import Link from "next/link";
import Grain from "@/components/Grain";
import { DESKTOP_RELEASES } from "@/lib/desktop";
import OsPick from "./OsPick";
import s from "./download.module.css";

export const metadata = { title: "coda for Windows and Mac" };
// the newest installers, asked of GitHub at most every ten minutes
export const revalidate = 600;

interface Asset { name: string; size: number; browser_download_url: string }
interface Release { tag_name: string; published_at: string; assets: Asset[] }

/** The latest release's installers — Windows' setup .exe and the Mac's .dmg — or nulls (none yet, or GitHub not answering). */
async function latest() {
  try {
    const r = await fetch("https://api.github.com/repos/elichen09/bracket/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "coda-site" },
      next: { revalidate: 600 },
    });
    if (!r.ok) return null;
    const rel = (await r.json()) as Release;
    const win = rel.assets.find((a) => /-setup\.exe$/i.test(a.name)) || rel.assets.find((a) => /\.exe$/i.test(a.name)) || null;
    const mac = rel.assets.find((a) => /\.dmg$/i.test(a.name)) || null;
    return {
      win, mac,
      version: rel.tag_name.replace(/^desktop-v/, ""),
      date: new Date(rel.published_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    };
  } catch {
    return null;
  }
}

const mb = (a: Asset | null | undefined) => (a ? Math.max(1, Math.round(a.size / 1e6)) + " MB" : "");

/**
 * coda for Windows and Mac: the downloads, and how to get going. The app is
 * the site in a window of its own (src-tauri/), so it is always the newest
 * coda; what changes is that every key is yours and Google is not asked for.
 */
export default async function Download() {
  const rel = await latest();
  return (
    <main className={s.page}>
      <section className={s.hero}>
        <Grain className={s.grain} />
        <div className={s.heroIn}>
          <Link href="/" className={s.home}>coda</Link>
          <h1 className={s.title}>coda, on your desktop</h1>
          <p className={s.lead}>The same coda, in a window of its own, for Windows and Mac. It works offline, needs no account, and every key is yours.</p>
          <OsPick win={rel?.win?.browser_download_url || null} mac={rel?.mac?.browser_download_url || null} fallback={DESKTOP_RELEASES} />
          <p className={s.meta}>
            {rel ? <>Version {rel.version} · {rel.date} · </> : null}
            Windows 10 or 11{rel?.win ? ` (${mb(rel.win)})` : ""} · macOS 11 or later, Apple Silicon or Intel{rel?.mac ? ` (${mb(rel.mac)})` : ""} · <a href={DESKTOP_RELEASES}>every version</a>
          </p>
        </div>
      </section>

      <section className={s.body}>
        <h2 className={s.h2}>On Windows</h2>
        <ol className={s.steps}>
          <li><b>Download it</b> with the Windows button above. It&apos;s an installer called <code>coda_…_x64-setup.exe</code>.</li>
          <li>
            <b>Open it.</b> Windows may say <i>&ldquo;Windows protected your PC&rdquo;</i> — coda isn&apos;t signed with a paid
            certificate, so Windows doesn&apos;t know it yet. Click <b>More info</b>, then <b>Run anyway</b>. If your browser asks
            whether to keep the file, choose <b>Keep</b>.
          </li>
          <li>
            <b>It installs for you alone</b> — no administrator password — and opens. coda is in the Start menu from then on;
            right-click it in the taskbar and choose <b>Pin to taskbar</b> to keep it there.
          </li>
        </ol>

        <h2 className={s.h2}>On a Mac</h2>
        <ol className={s.steps}>
          <li><b>Download it</b> with the Mac button above — <code>coda_…_universal.dmg</code>, one app for Apple Silicon and Intel Macs.</li>
          <li><b>Open the .dmg</b> and drag <b>coda</b> into <b>Applications</b>.</li>
          <li>
            <b>Open coda from Applications.</b> The first time, macOS says it can&apos;t check coda for malicious software — coda
            isn&apos;t notarised by Apple. Click <b>Done</b>, open <b>System Settings › Privacy &amp; Security</b>, scroll down, click
            <b> Open Anyway</b> beside coda, and confirm. It opens normally from then on; keep it in the Dock with right-click ›
            <b> Options › Keep in Dock</b>.
          </li>
          <li>
            If macOS says instead that coda <i>&ldquo;is damaged and can&apos;t be opened&rdquo;</i>, it isn&apos;t — that is the mark
            macOS puts on downloads. Open <b>Terminal</b>, paste this and press Return, then open coda again:
            <code className={s.block}>xattr -dr com.apple.quarantine /Applications/coda.app</code>
          </li>
        </ol>

        <h2 className={s.h2}>Then, on either</h2>
        <ol className={s.steps}>
          <li><b>There&apos;s nothing to sign in to.</b> coda opens straight to your files — it works offline and needs no account.</li>
          <li>
            <b>Bring your library across, once.</b> The app keeps its own copy of everything, on your computer, apart from this
            browser&apos;s. Here, in coda: <b>⋯ › Export the library</b>. In the app: <b>⋯ › Import an evidence file › Load a .json
            export instead</b>, and pick that file. Your files come back as files, the blocks you imported as blocks, each in the
            bin it was in.
          </li>
        </ol>

        <h2 className={s.h2}>What&apos;s different in the app</h2>
        <ul className={s.diff}>
          <li><b>It works offline.</b> coda is inside the app, and everything you make is on your computer — no internet, no account.</li>
          <li><b>Every key works.</b> Ctrl+K, Ctrl+N and the rest reach coda — nothing in a browser or an extension takes them first.</li>
          <li><b>Cutting, the library and the speech doc are all there</b> — searching, sending, Flow, their docs from a .docx,
            PDF or paste, export and import.</li>
          <li><b>With the internet, SpeechDrop and the caselist work too.</b> SpeechDrop needs nothing more. The caselist asks you,
            the first time, to sign into openCaselist with your own Tabroom email and password — it searches as you, and keeps the
            sign-in on your computer for two weeks.</li>
          <li><b>The caselist with no internet.</b> Once its index has loaded, searching the caselist works offline. Press
            <b>Keep offline</b> in the caselist bar and the week&apos;s whole caselist for your event is kept on your computer (its size is
            shown first — about 3 GB for PF), so its cards open with no internet too. A new week&apos;s comes down by itself.</li>
          <li><b>It updates itself.</b> When there&apos;s a newer coda, an <b>Update</b> button appears at the top; one click
            installs it and starts coda again. Your files stay.</li>
          <li><b>Your partner, by code, app to app</b> — Flow&apos;s Invite and the speech doc&apos;s Room work in the app with no account: one of you reads out the code, the other types it in. Two apps on the same Wi-Fi connect straight to each other, <b>even when the Wi-Fi has no internet</b>; anywhere else they connect over the internet. The first time, Windows asks whether coda may use the network (allow it on public networks too, for tournament Wi-Fi) and a Mac asks to find devices on your network. Nothing about the round is stored.</li>
          <li><b>Sharing a file by link works here too</b>, with no account: Share gives a link that opens on coda&apos;s site or in the app, and a link someone sends you opens from Share → Open a shared file. Only you can stop a file you shared. Your partner&apos;s Google Doc stays on the web.</li>
          <li><b>On a Mac it runs on Safari&apos;s engine</b>, so it may differ from Chrome in small ways.</li>
        </ul>

        <h2 className={s.h2}>Removing it</h2>
        <p className={s.p}>Windows: Settings › Apps › Installed apps › coda › Uninstall. Mac: drag coda from Applications to the Bin. Your files in
          the app live on your computer: export the library first if you want to keep them. The uninstaller&apos;s <i>delete the
          application data</i> box erases them; leave it unticked to keep them for a reinstall.</p>

        <p className={s.back}><Link href="/tools/magic">← Back to coda</Link></p>
      </section>
    </main>
  );
}
