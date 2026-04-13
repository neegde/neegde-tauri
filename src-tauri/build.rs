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
    let dst = cmake::Config::new(&vozduxan_dir)
        .define("CMAKE_BUILD_TYPE", "Release")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        // Suppress noisy status output in CI; remove if you want verbose builds.
        .very_verbose(false)
        .build();

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
    // Try pkg-config first (works on most Linux and Homebrew macOS setups).
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
        // Homebrew installs to /opt/homebrew (ARM) or /usr/local (Intel).
        for brew_prefix in &["/opt/homebrew", "/usr/local"] {
            let lib_path = std::path::Path::new(brew_prefix).join("lib");
            if lib_path.exists() {
                println!("cargo:rustc-link-search=native={}", lib_path.display());
                break;
            }
        }
        println!("cargo:rustc-link-lib=dylib=torrent-rasterbar");
        // FetchContent/static libtorrent links OpenSSL (ssl.cpp); rustc must see ssl/crypto too.
        link_homebrew_openssl_libs_macos();
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=IOKit");
    }

    #[cfg(target_os = "linux")]
    {
        println!("cargo:rustc-link-lib=dylib=torrent-rasterbar");
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
    }
}

/// Emits Cargo link instructions for Apple Silicon/Intel Homebrew OpenSSL libraries.
///
/// FetchContent-built libtorrent links `libssl` / `libcrypto`; the final Rust link must
/// include them when `pkg-config` is not used. Searches `opt/openssl@3` kegs then `lib/`.
fn link_homebrew_openssl_libs_macos() {
    let keg_libs = [
        "/opt/homebrew/opt/openssl@3/lib",
        "/opt/homebrew/opt/openssl/lib",
        "/usr/local/opt/openssl@3/lib",
        "/usr/local/opt/openssl/lib",
    ];
    for dir in keg_libs {
        let p = std::path::Path::new(dir);
        if p.join("libssl.dylib").exists() || p.join("libssl.a").exists() {
            println!("cargo:rustc-link-search=native={}", p.display());
            println!("cargo:rustc-link-lib=dylib=ssl");
            println!("cargo:rustc-link-lib=dylib=crypto");
            return;
        }
    }
    for brew in &["/opt/homebrew", "/usr/local"] {
        let lib = std::path::Path::new(*brew).join("lib");
        if lib.join("libssl.dylib").exists() {
            println!("cargo:rustc-link-search=native={}", lib.display());
            println!("cargo:rustc-link-lib=dylib=ssl");
            println!("cargo:rustc-link-lib=dylib=crypto");
            return;
        }
    }
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
