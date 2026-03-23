#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Send SIGTERM to the entire process group so that the Tauri CLI
                // watcher and the Vite dev server (port 5173) also exit cleanly.
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(libc::getpgrp()), libc::SIGTERM);
                }
                std::process::exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
