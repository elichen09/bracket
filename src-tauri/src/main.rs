// coda's desktop app: coda itself, built into the app (desktop/ → desktop/dist),
// so it opens with no internet and asks for no account.
//
// Everything is kept on this computer, as it is in the browser. The page is
// told it is the app by one line run before it (window.__CODA_DESKTOP__), and
// leaves out what needs a server or an account (lib/desktop.ts).
//
// The one thing the app adds to the page is a direct road to a partner's app
// (p2p.rs, iroh): the page's rooms — Flow's shared round, the speech doc's
// Room — ride it beside the relay, so two apps on the same Wi-Fi keep working
// with no internet at all (lib/p2p.ts is the page's side).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod p2p;

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::OnceCell;

/// The connection, opened the first time a room asks for it.
#[derive(Default)]
struct P2p(OnceCell<Arc<p2p::Mesh>>);

async fn mesh<'a>(app: &AppHandle, s: &'a State<'_, P2p>) -> Result<&'a Arc<p2p::Mesh>, String> {
    let app = app.clone();
    s.0.get_or_try_init(|| p2p::Mesh::start(move |ev| { let _ = app.emit("coda-p2p", ev); })).await
}

#[derive(Serialize)]
struct Joined {
    /// this app, as partners' events name it
    id: String,
    /// where a partner's app can reach this one, for the room's presence on the relay
    addr: String,
}

#[tauri::command]
async fn p2p_join(app: AppHandle, s: State<'_, P2p>, room: String) -> Result<Joined, String> {
    let m = mesh(&app, &s).await?;
    m.join(&room);
    Ok(Joined { id: m.id(), addr: m.addr().await })
}

#[tauri::command]
async fn p2p_leave(s: State<'_, P2p>, room: String) -> Result<(), String> {
    if let Some(m) = s.0.get() { m.leave(&room); }
    Ok(())
}

#[tauri::command]
async fn p2p_send(s: State<'_, P2p>, room: String, data: String) -> Result<(), String> {
    if let Some(m) = s.0.get() { m.send(&room, data); }
    Ok(())
}

#[tauri::command]
async fn p2p_dial(s: State<'_, P2p>, room: String, addr: String) -> Result<(), String> {
    match s.0.get() { Some(m) => m.dial(&addr, &room), None => Ok(()) }
}

fn main() {
    tauri::Builder::default()
        .manage(P2p::default())
        .invoke_handler(tauri::generate_handler![p2p_join, p2p_leave, p2p_send, p2p_dial])
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
