fn main() {
    tauri_build::build();
    build_vozduxan();
}

fn build_vozduxan() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // src-tauri/ → repo root / vozduxan/ (git submodule)
    let vozduxan_dir = manifest_dir.parent().unwrap().join("vozduxan");

    if !vozduxan_dir.exists() {
        panic!(
            "[vozduxan] source directory not found: {}",
            vozduxan_dir.display()
        );
    }

    // cmake::Config builds the project and installs it to a temp prefix.
    // The built static library lands at <dst>/lib/libvozduxan.a (POSIX) or
    // <dst>/lib/vozduxan.lib (Windows).
    let mut cmake_cfg = cmake::Config::new(&vozduxan_dir);
    cmake_cfg
        .define("CMAKE_BUILD_TYPE", "Release")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        // Suppress noisy status output in CI; remove if you want verbose builds.
        .very_verbose(false);

    // macOS: force static OpenSSL so FetchContent-built libtorrent embeds it.
    // Prevents "Library not loaded: .../libssl.dylib" on systems without Homebrew.
    #[cfg(target_os = "macos")]
    cmake_cfg.define("OPENSSL_USE_STATIC_LIBS", "ON");

    let dst = cmake_cfg.build();

    let lib_dir = dst.join("lib");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=vozduxan");

    // Re-run if any C++ source changes.
    // NOTE: Cargo's rerun-if-changed on a directory only tracks the directory
    // mtime, which macOS does NOT update when a file inside is modified.
    // We enumerate the individual source files so Cargo detects changes correctly.
    for entry in std::fs::read_dir(vozduxan_dir.join("src"))
        .into_iter()
        .flatten()
        .flatten()
    {
        println!("cargo:rerun-if-changed={}", entry.path().display());
    }
    for entry in std::fs::read_dir(vozduxan_dir.join("include"))
        .into_iter()
        .flatten()
        .flatten()
    {
        println!("cargo:rerun-if-changed={}", entry.path().display());
    }
    println!("cargo:rerun-if-changed={}", vozduxan_dir.join("CMakeLists.txt").display());

    // ── C++ standard library ──────────────────────────────────────────────
    // Must come before libtorrent so the linker sees it while resolving
    // unresolved symbols from libvozduxan.a.
    link_cxx_stdlib();

    // ── Link against libtorrent-rasterbar ─────────────────────────────────
    // On macOS we always use the FetchContent static build (installed to dst/lib/
    // by CMakeLists.txt) so the binary carries no dylib path dependencies.
    // pkg-config is only used on Linux where dynamic linking is acceptable.
    #[cfg(target_os = "macos")]
    let found_via_pkg_config = false;
    #[cfg(not(target_os = "macos"))]
    let found_via_pkg_config = pkg_config::Config::new()
        .atleast_version("2.0")
        .probe("libtorrent-rasterbar")
        .is_ok();

    if !found_via_pkg_config {
        // Fallback: hard-code common installation paths.
        link_libtorrent_fallback();
    }
}

fn link_libtorrent_fallback() {
    #[cfg(target_os = "macos")]
    {
        // libtorrent-rasterbar.a is installed to dst/lib/ by CMakeLists.txt
        // (FetchContent path). Static link: no dylib runtime dep on end-user machines.
        println!("cargo:rustc-link-lib=static=torrent-rasterbar");
        // libtorrent links OpenSSL; link statically so there's no Homebrew path dep.
        link_homebrew_openssl_libs_macos();
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=IOKit");
    }

    #[cfg(target_os = "linux")]
    {
        println!("cargo:rustc-link-lib=dylib=torrent-rasterbar");
        // libtorrent-rasterbar uses OpenSSL (SSL sockets, SHA-512); link explicitly
        // so the symbols are available regardless of what TLS backend Rust crates use.
        println!("cargo:rustc-link-lib=dylib=ssl");
        println!("cargo:rustc-link-lib=dylib=crypto");
        println!("cargo:rustc-link-lib=dylib=pthread");
    }

    #[cfg(target_os = "windows")]
    {
        // vcpkg or manually installed libtorrent
        if let Ok(vcpkg_root) = std::env::var("VCPKG_ROOT") {
            let lib_path =
                std::path::Path::new(&vcpkg_root).join("installed/x64-windows/lib");
            println!("cargo:rustc-link-search=native={}", lib_path.display());
        }
        println!("cargo:rustc-link-lib=static=torrent-rasterbar");
        println!("cargo:rustc-link-lib=dylib=ws2_32");
        println!("cargo:rustc-link-lib=dylib=iphlpapi");
        // FetchContent-built libtorrent links OpenSSL (HTTPS trackers, crypto, SSL sockets).
        // The static .lib does not carry OpenSSL — rustc must link libssl/libcrypto explicitly.
        link_openssl_libs_windows_msvc();
    }
}

/// Emits Cargo link instructions for Apple Silicon/Intel Homebrew OpenSSL libraries.
///
/// Prefers static libs (.a) so the distributed binary has no Homebrew path deps
/// (fixes "Library not loaded: .../libssl.dylib" on macOS Tahoe and other systems
/// where Homebrew is not installed or uses different paths).
fn link_homebrew_openssl_libs_macos() {
    let keg_libs = [
        "/opt/homebrew/opt/openssl@3/lib",
        "/opt/homebrew/opt/openssl/lib",
        "/usr/local/opt/openssl@3/lib",
        "/usr/local/opt/openssl/lib",
    ];
    // Prefer static (.a) — embedded in binary, no runtime path dependency.
    for dir in keg_libs {
        let p = std::path::Path::new(dir);
        if p.join("libssl.a").exists() {
            println!("cargo:rustc-link-search=native={}", p.display());
            println!("cargo:rustc-link-lib=static=ssl");
            println!("cargo:rustc-link-lib=static=crypto");
            return;
        }
    }
    for brew in &["/opt/homebrew", "/usr/local"] {
        let lib = std::path::Path::new(*brew).join("lib");
        if lib.join("libssl.a").exists() {
            println!("cargo:rustc-link-search=native={}", lib.display());
            println!("cargo:rustc-link-lib=static=ssl");
            println!("cargo:rustc-link-lib=static=crypto");
            return;
        }
    }
    // Fallback to dynamic if no static lib found.
    for dir in keg_libs {
        let p = std::path::Path::new(dir);
        if p.join("libssl.dylib").exists() {
            println!("cargo:rustc-link-search=native={}", p.display());
            println!("cargo:rustc-link-lib=dylib=ssl");
            println!("cargo:rustc-link-lib=dylib=crypto");
            return;
        }
    }
}

/// Emits Cargo link instructions for OpenSSL import/static libs on Windows MSVC.
///
/// Same idea as rust-openssl / openssl-sys: lib names `libssl` and `libcrypto`, search
/// `OPENSSL_ROOT_DIR\\lib`, vcpkg, or Chocolatey's OpenSSL-Win64 layout.
#[cfg(target_os = "windows")]
fn link_openssl_libs_windows_msvc() {
    use std::path::{Path, PathBuf};

    for key in [
        "OPENSSL_ROOT_DIR",
        "OPENSSL_DIR",
        "OPENSSL_LIB_DIR",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(v) = std::env::var("OPENSSL_LIB_DIR") {
        candidates.push(PathBuf::from(v));
    }
    for root_key in ["OPENSSL_ROOT_DIR", "OPENSSL_DIR"] {
        if let Ok(v) = std::env::var(root_key) {
            candidates.push(Path::new(&v).join("lib"));
        }
    }
    if let Ok(vcpkg) = std::env::var("VCPKG_ROOT") {
        let v = Path::new(&vcpkg);
        candidates.push(v.join("installed/x64-windows/lib"));
        candidates.push(v.join("installed/x64-windows-static/lib"));
    }
    for rel in [
        "",
        r"VC\x64\MD",
        r"VC\x64\MT",
        r"VC\MD",
        r"VC\MT",
    ] {
        let base = Path::new(r"C:\Program Files\OpenSSL\lib");
        candidates.push(if rel.is_empty() {
            base.to_path_buf()
        } else {
            base.join(rel)
        });
        let base64 = Path::new(r"C:\Program Files\OpenSSL-Win64\lib");
        candidates.push(if rel.is_empty() {
            base64.to_path_buf()
        } else {
            base64.join(rel)
        });
    }
    candidates.push(r"C:\Program Files (x86)\OpenSSL-Win64\lib".into());

    fn emit_common_windows_libs() {
        println!("cargo:rustc-link-lib=dylib=crypt32");
        println!("cargo:rustc-link-lib=dylib=advapi32");
        println!("cargo:rustc-link-lib=dylib=user32");
        println!("cargo:rustc-link-lib=dylib=gdi32");
        println!("cargo:rustc-link-lib=dylib=bcrypt");
    }

    // Prefer true static libs (libssl_static.lib / libcrypto_static.lib).
    // Shining Light Productions (Chocolatey) installs them in the root lib\ dir.
    // Static linking embeds OpenSSL into the binary — users need no DLLs.
    for dir in &candidates {
        if dir.join("libssl_static.lib").exists() && dir.join("libcrypto_static.lib").exists() {
            println!("cargo:rustc-link-search=native={}", dir.display());
            println!("cargo:rustc-link-lib=static=libssl_static");
            println!("cargo:rustc-link-lib=static=libcrypto_static");
            emit_common_windows_libs();
            return;
        }
    }

    // Fallback: import libs (libssl.lib / libcrypto.lib).
    // These link against the DLL — acceptable in dev builds, not for distribution.
    for dir in &candidates {
        if dir.join("libssl.lib").exists() && dir.join("libcrypto.lib").exists() {
            println!("cargo:rustc-link-search=native={}", dir.display());
            println!("cargo:rustc-link-lib=dylib=libssl");
            println!("cargo:rustc-link-lib=dylib=libcrypto");
            emit_common_windows_libs();
            return;
        }
    }

    panic!(
        "[vozduxan] Windows: libssl.lib / libcrypto.lib not found. Install OpenSSL (e.g. `choco install openssl -y`) \
         and set OPENSSL_LIB_DIR to the folder that contains both libs (often \
         ..\\\\OpenSSL\\\\lib\\\\VC\\\\x64\\\\MD), or OPENSSL_ROOT_DIR to the install root."
    );
}

fn link_cxx_stdlib() {
    // A static C++ library (vozduxan) pulls in C++ runtime symbols that Rust's
    // linker won't resolve automatically.  We must explicitly link the C++ stdlib.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-lib=c++");         // libc++ (Clang/macOS)

    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-lib=stdc++");      // libstdc++ (GCC/Linux)

    // Windows: the MSVC runtime is linked automatically by the compiler.
}
