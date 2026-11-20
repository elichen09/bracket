// coda's desktop app: coda itself, built into the app (desktop/ → desktop/dist),
// so it opens with no internet and asks for no account.
//
// Everything is kept on this computer, as it is in the browser. The page is
// told it is the app by one line run before it (window.__CODA_DESKTOP__), and
// leaves out what needs a server or an account (lib/desktop.ts).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("coda")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .maximized(true)
                // the page's own drag and drop (the outline, a .docx dropped on the window) — not Tauri's
                .disable_drag_drop_handler()
                .initialization_script("window.__CODA_DESKTOP__ = true;")
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("coda could not start");
}
