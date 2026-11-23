/**
 * The desktop app keeping itself up to date (tauri-plugin-updater).
 *
 * Each release (a desktop-v* tag, .github/workflows/desktop.yml) carries a
 * latest.json naming the newest version and, for each platform, the installer
 * signed with coda's updater key. The app asks for it a little after it opens
 * and every few hours; if there is a newer one it says so, quietly, and one
 * click downloads it, checks the signature against the key built into the app
 * (tauri.conf.json), installs it and starts coda again. Nothing happens
 * without that click, and offline the question just goes unanswered.
 */
import { isDesktop } from "@/lib/desktop";

export interface Ready {
  version: string;
  /** Download, install, start again. `onProgress` gets 0..1 while it downloads. */
  install: (onProgress: (p: number) => void) => Promise<void>;
}

/** A newer version, if there is one; null if not, offline, or on the site. */
export async function checkUpdate(): Promise<Ready | null> {
  if (!isDesktop()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check();
    if (!u) return null;
    return {
      version: u.version,
      async install(onProgress) {
        let total = 0, got = 0;
        await u.downloadAndInstall((e) => {
          if (e.event === "Started") total = e.data.contentLength || 0;
          else if (e.event === "Progress") { got += e.data.chunkLength; onProgress(total ? Math.min(1, got / total) : 0); }
          else if (e.event === "Finished") onProgress(1);
        });
        // Windows: the installer has already closed the app and starts it again. A Mac: start again here.
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  } catch {
    return null;                                   // no internet, or no release that says anything: ask again later
  }
}
