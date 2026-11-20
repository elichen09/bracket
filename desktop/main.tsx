/**
 * coda's desktop app, offline: the same app as /tools/magic, built into the
 * app itself (desktop/build.mjs → desktop/dist, which src-tauri bundles), so
 * it starts with no internet and needs no account.
 *
 * Everything is kept on this computer, as it is in the browser — your files,
 * the library, the speech doc. What needs a server or an account (the
 * caselist, SpeechDrop, rooms, shared files, a partner's Google Doc) is left
 * to coda on the web; lib/desktop.ts tells the app which it is.
 */
import { createRoot } from "react-dom/client";
import RoundMagic from "@/components/tools/RoundMagic";
import ToolFx from "@/components/tools/ToolFx";
import { THEME_BOOT } from "@/lib/toolTheme";
import "@/app/globals.css";
import "@/app/theme.css";
import "@/app/tools/tools.css";
import "./fonts.css";

(window as unknown as { __CODA_DESKTOP__: boolean }).__CODA_DESKTOP__ = true;
// the tools' colours before the first paint, as the tools layout does on the web
try { new Function(THEME_BOOT)(); } catch { /* defaults */ }
document.documentElement.setAttribute("data-theme", "light");

createRoot(document.getElementById("coda")!).render(
  <>
    <ToolFx />
    <main>
      <div className="toolpage"><RoundMagic /></div>
    </main>
  </>,
);
