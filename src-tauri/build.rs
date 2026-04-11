fn main() {
    tauri_build::build();
    build_blizorukost();
}

fn build_blizorukost() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // src-tauri/ → neegde-tauri/ → neegde/ → blizorukost/
    let bliz_dir = manifest_dir
        .parent() // neegde-tauri/
        .unwrap()
        .parent() // neegde/
        .unwrap()
        .join("blizorukost");

    if !bliz_dir.exists() {
        panic!(
            "[blizorukost] source directory not found: {}",
            bliz_dir.display()
        );
    }

    // cmake::Config builds the project and installs it to a temp prefix.
    // The built static library lands at <dst>/lib/libblizorukost.a (POSIX) or
    // <dst>/lib/blizorukost.lib (Windows).
    let dst = cmake::Config::new(&bliz_dir)
        .define("CMAKE_BUILD_TYPE", "Release")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        // Suppress noisy status output in CI; remove if you want verbose builds.
        .very_verbose(false)
        .build();

    let lib_dir = dst.join("lib");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=blizorukost");

    // Re-run if any C++ source changes.
    println!("cargo:rerun-if-changed={}", bliz_dir.join("src").display());
    println!("cargo:rerun-if-changed={}", bliz_dir.join("include").display());
    println!("cargo:rerun-if-changed={}", bliz_dir.join("CMakeLists.txt").display());

    // ── C++ standard library ──────────────────────────────────────────────
    // Must come before libtorrent so the linker sees it while resolving
    // unresolved symbols from libblizorukost.a.
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

fn link_cxx_stdlib() {
    // A static C++ library (blizorukost) pulls in C++ runtime symbols that Rust's
    // linker won't resolve automatically.  We must explicitly link the C++ stdlib.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-lib=c++");         // libc++ (Clang/macOS)

    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-lib=stdc++");      // libstdc++ (GCC/Linux)

    // Windows: the MSVC runtime is linked automatically by the compiler.
}
