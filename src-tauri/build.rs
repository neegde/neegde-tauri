fn main() {
    // ── blizorukost (C++ / libtorrent streaming engine) ─────────────────────
    let bliz_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../blizorukost");

    if bliz_dir.exists() {
        let dst = cmake::Config::new(&bliz_dir)
            .define("CMAKE_BUILD_TYPE", "Release")
            .build_target("blizorukost")
            .build();

        // cmake install puts the archive under {dst}/build/
        println!(
            "cargo:rustc-link-search=native={}/build",
            dst.display()
        );
        // Also try the standard cmake-rs install prefix location
        println!(
            "cargo:rustc-link-search=native={}/lib",
            dst.display()
        );
        println!("cargo:rustc-link-lib=static=blizorukost");

        // ── libtorrent-rasterbar (system-installed) ──────────────────────
        println!("cargo:rustc-link-lib=dylib=torrent-rasterbar");

        // Homebrew search paths (macOS arm64 / x86_64)
        #[cfg(target_os = "macos")]
        {
            for prefix in &["/opt/homebrew", "/usr/local"] {
                let lib = format!("{prefix}/lib");
                if std::path::Path::new(&lib).exists() {
                    println!("cargo:rustc-link-search=native={lib}");
                }
            }
            println!("cargo:rustc-link-lib=dylib=c++");
            println!("cargo:rustc-link-lib=framework=SystemConfiguration");
            println!("cargo:rustc-link-lib=framework=CoreFoundation");
            println!("cargo:rustc-link-lib=framework=IOKit");
        }
        #[cfg(target_os = "linux")]
        {
            println!("cargo:rustc-link-lib=dylib=stdc++");
        }

        // Re-run if blizorukost sources change
        println!("cargo:rerun-if-changed=../../blizorukost/src/session.cpp");
        println!("cargo:rerun-if-changed=../../blizorukost/src/api.cpp");
        println!("cargo:rerun-if-changed=../../blizorukost/include/blizorukost.h");
    } else {
        eprintln!(
            "[build.rs] WARNING: blizorukost not found at {}; \
             streaming will fall back to librqbit.",
            bliz_dir.display()
        );
    }

    tauri_build::build()
}
