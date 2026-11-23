//! The caselist, kept on this computer (lib/caselist/offline.js is the page's side).
//!
//! Searching the caselist is already local: the page keeps each wiki's index
//! of tags. A card's text is not in the index — it is read out of openCaselist's
//! weekly archive of every open-source document. Online the site does that
//! with one ranged request; offline there is nothing to ask. So on request the
//! app downloads the week's whole archive for a wiki (hundreds of MB, about a
//! gigabyte for PF) into its own folder, resuming where it stopped, and the
//! page reads a card's document out of it by the offset the index already
//! gives. A newer archive replaces the old one only once it is whole.
//!
//! Only openCaselist's archive host is fetched, and only into the app's data
//! folder, named by the wiki.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

#[derive(Serialize, Deserialize, Clone)]
pub struct Kept {
    pub slug: String,
    pub url: String,
    pub bytes: u64,
    /// when it was kept, in ms
    pub at: u64,
}

#[derive(Serialize, Clone)]
struct Progress {
    slug: String,
    got: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

/// Downloads under way, by wiki: a flag to stop each.
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

fn good_slug(s: &str) -> bool {
    let letters = s.trim_end_matches(|c: char| c.is_ascii_digit());
    !letters.is_empty() && letters.chars().all(|c| c.is_ascii_lowercase()) && s.len() - letters.len() == 2
}

fn good_url(u: &str) -> bool {
    u.starts_with("https://caselist-files.s3.")
        && u.contains(".backblazeb2.com/weekly/")
        && u.ends_with(".zip")
        && !u.contains("..")
        && !u.contains('?')
        && !u.contains('#')
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("caselist");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The archives kept here.
#[tauri::command]
pub async fn cl_kept(app: AppHandle) -> Result<Vec<Kept>, String> {
    let d = folder(&app)?;
    let mut out = vec![];
    for e in std::fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") || p.to_string_lossy().ends_with(".part.json") { continue; }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(k) = serde_json::from_str::<Kept>(&text) else { continue };
        if d.join(format!("{}.zip", k.slug)).exists() { out.push(k); }
    }
    Ok(out)
}

/// Keep a wiki's archive here: downloaded in the background (resumed if it was
/// cut off), with progress as `coda-cl` events. Already under way: nothing more.
#[tauri::command]
pub async fn cl_keep(app: AppHandle, downloads: State<'_, Downloads>, slug: String, url: String) -> Result<(), String> {
    if !good_slug(&slug) || !good_url(&url) { return Err("not a caselist archive".into()); }
    let stop = {
        let mut m = downloads.0.lock().unwrap();
        if m.contains_key(&slug) { return Ok(()); }
        let f = Arc::new(AtomicBool::new(false));
        m.insert(slug.clone(), f.clone());
        f
    };
    let d = folder(&app)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let res = fetch(&app2, &d, &slug, &url, &stop).await;
        app2.state::<Downloads>().0.lock().unwrap().remove(&slug);
        let (done, error) = match res {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e)),
        };
        let _ = app2.emit("coda-cl", Progress { slug, got: 0, total: 0, done, error });
    });
    Ok(())
}

async fn fetch(app: &AppHandle, d: &PathBuf, slug: &str, url: &str, stop: &AtomicBool) -> Result<(), String> {
    let part = d.join(format!("{slug}.part"));
    let part_meta = d.join(format!("{slug}.part.json"));
    // what was got last time, if it was this same archive
    let mut have = 0u64;
    if let (Ok(m), Ok(f)) = (std::fs::read_to_string(&part_meta), std::fs::metadata(&part)) {
        if m.trim() == url { have = f.len(); }
    }
    if have == 0 { let _ = std::fs::remove_file(&part); }
    std::fs::write(&part_meta, url).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    if have > 0 { req = req.header("range", format!("bytes={have}-")); }
    let r = req.send().await.map_err(|e| format!("no connection ({e})"))?;
    let status = r.status().as_u16();
    if status == 200 { have = 0; } else if status != 206 { return Err(format!("the archive said {status}")); }
    let total = have + r.content_length().unwrap_or(0);

    let mut file = tokio::fs::OpenOptions::new().create(true).write(true).truncate(have == 0).open(&part).await.map_err(|e| e.to_string())?;
    file.seek(std::io::SeekFrom::Start(have)).await.map_err(|e| e.to_string())?;
    let mut got = have;
    let mut said = Instant::now();
    let mut body = r.bytes_stream();
    while let Some(chunk) = body.next().await {
        if stop.load(Ordering::Relaxed) { return Err("stopped".into()); }
        let chunk = chunk.map_err(|e| format!("the download broke off ({e}) — it picks up where it stopped"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if said.elapsed() > Duration::from_millis(300) {
            said = Instant::now();
            let _ = app.emit("coda-cl", Progress { slug: slug.into(), got, total, done: false, error: None });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    if total > 0 && got < total { return Err("the download stopped short — it picks up where it stopped".into()); }

    // whole: it replaces the one kept before
    let zip = d.join(format!("{slug}.zip"));
    std::fs::rename(&part, &zip).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&part_meta);
    let kept = Kept { slug: slug.into(), url: url.into(), bytes: got, at: now_ms() };
    std::fs::write(d.join(format!("{slug}.json")), serde_json::to_string(&kept).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(())
}

/// How big a wiki's archive is, before deciding to keep it.
#[tauri::command]
pub async fn cl_size(url: String) -> Result<u64, String> {
    if !good_url(&url) { return Err("not a caselist archive".into()); }
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let r = client.head(&url).send().await.map_err(|e| format!("no connection ({e})"))?;
    // the header itself: for a HEAD there is no body for content_length() to measure
    r.headers().get(reqwest::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| "the archive didn't say its size".into())
}

/// Bytes of a kept archive: a card's document, by where the index says it is.
#[tauri::command]
pub async fn cl_read(app: AppHandle, slug: String, off: u64, len: u64) -> Result<Response, String> {
    if !good_slug(&slug) || len == 0 || len > 64 << 20 { return Err("not a card's document".into()); }
    let path = folder(&app)?.join(format!("{slug}.zip"));
    let mut f = tokio::fs::File::open(&path).await.map_err(|_| "this wiki isn't kept here".to_string())?;
    let size = f.metadata().await.map_err(|e| e.to_string())?.len();
    if off >= size { return Err("the kept archive is not the one the index was read from".into()); }
    let n = len.min(size - off) as usize;
    f.seek(std::io::SeekFrom::Start(off)).await.map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; n];
    f.read_exact(&mut buf).await.map_err(|e| e.to_string())?;
    Ok(Response::new(buf))
}

/// A wiki's archive let go: a download under way stopped, the files removed.
#[tauri::command]
pub async fn cl_drop(app: AppHandle, downloads: State<'_, Downloads>, slug: String) -> Result<(), String> {
    if !good_slug(&slug) { return Err("which wiki?".into()); }
    if let Some(f) = downloads.0.lock().unwrap().get(&slug) { f.store(true, Ordering::Relaxed); }
    let d = folder(&app)?;
    for name in [format!("{slug}.zip"), format!("{slug}.json"), format!("{slug}.part"), format!("{slug}.part.json")] {
        let _ = std::fs::remove_file(d.join(name));
    }
    Ok(())
}
