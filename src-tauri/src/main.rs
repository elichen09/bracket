// coda for Windows: the live site in a window of its own.
//
// The window opens coda itself — the same address as in the browser — so the
// app is always the newest coda and nothing here needs updating when the site
// changes. What the window adds is a place where every key reaches coda (no
// browser shortcuts, no extensions), and one line run before each page,
// window.__CODA_DESKTOP__, so the site knows to leave out what needs Google
// (lib/desktop.ts).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

const CODA: &str = "https://bracket-ashy.vercel.app/tools/magic";

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let url = CODA.parse().expect("coda's address");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
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
