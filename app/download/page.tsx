import Link from "next/link";
import Grain from "@/components/Grain";
import { DESKTOP_RELEASES } from "@/lib/desktop";
import s from "./download.module.css";

export const metadata = { title: "coda for Windows" };
// the newest installer, asked of GitHub at most every ten minutes
export const revalidate = 600;

interface Asset { name: string; size: number; browser_download_url: string }
interface Release { tag_name: string; published_at: string; assets: Asset[] }

/** The latest release's Windows installer, or null (none yet, or GitHub not answering). */
async function latest(): Promise<{ url: string; size: number; version: string; date: string } | null> {
  try {
    const r = await fetch("https://api.github.com/repos/elichen09/bracket/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "coda-site" },
      next: { revalidate: 600 },
    });
    if (!r.ok) return null;
    const rel = (await r.json()) as Release;
    const exe = rel.assets.find((a) => /-setup\.exe$/i.test(a.name)) || rel.assets.find((a) => /\.exe$/i.test(a.name));
    if (!exe) return null;
    return {
      url: exe.browser_download_url,
      size: exe.size,
      version: rel.tag_name.replace(/^desktop-v/, ""),
      date: new Date(rel.published_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    };
  } catch {
    return null;
  }
}

/**
 * coda for Windows: the download, and how to get going with it. The app is
 * the site in a window of its own (src-tauri/), so it is always the newest
 * coda; what changes is that every key is yours and Google is not asked for.
 */
export default async function Download() {
  const rel = await latest();
  const mb = rel ? Math.max(1, Math.round(rel.size / 1e6)) : 0;
  return (
    <main className={s.page}>
      <section className={s.hero}>
        <Grain className={s.grain} />
        <div className={s.heroIn}>
          <Link href="/" className={s.home}>coda</Link>
          <h1 className={s.title}>coda for Windows</h1>
          <p className={s.lead}>The same coda, in a window of its own. Every key is yours — no browser, no extension taking Ctrl+K or Ctrl+N.</p>
          <div className={s.ctaRow}>
            {rel ? (
              <a className={s.cta} href={rel.url}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
                Download for Windows
              </a>
            ) : (
              <a className={s.cta} href={DESKTOP_RELEASES}>See the downloads on GitHub</a>
            )}
          </div>
          <p className={s.meta}>
            {rel ? <>Version {rel.version} · {mb} MB · {rel.date} · </> : null}
            Windows 10 or 11, 64-bit · <a href={DESKTOP_RELEASES}>every version</a>
          </p>
        </div>
      </section>

      <section className={s.body}>
        <h2 className={s.h2}>Getting it going</h2>
        <ol className={s.steps}>
          <li>
            <b>Download it</b> with the button above. It&apos;s an installer called <code>coda_…_x64-setup.exe</code>.
          </li>
          <li>
            <b>Open it.</b> Windows may say <i>&ldquo;Windows protected your PC&rdquo;</i> — coda isn&apos;t signed with a paid
            certificate, so Windows doesn&apos;t know it yet. Click <b>More info</b>, then <b>Run anyway</b>. If your browser asks
            whether to keep the file, choose <b>Keep</b>.
          </li>
          <li>
            <b>It installs for you alone</b> — no administrator password — and opens. coda is in the Start menu from then on;
            right-click it in the taskbar and choose <b>Pin to taskbar</b> to keep it there.
          </li>
          <li>
            <b>Sign in</b> with the same email and password you use here.
          </li>
          <li>
            <b>Bring your files across, once.</b> The app keeps its own copy of everything, apart from this browser&apos;s. Here, in
            coda&apos;s <b>Files</b> tab, press <b>↓</b> beside each file to download it as a .docx; then in the app, <b>Open .docx</b>.
            For blocks you imported into the library: here, <b>⋯ › Export the library</b>; in the app, <b>⋯ › Import an evidence
            file › Load a .json export instead</b>.
          </li>
        </ol>

        <h2 className={s.h2}>What&apos;s different in the app</h2>
        <ul className={s.diff}>
          <li><b>Every key works.</b> Ctrl+K, Ctrl+N and the rest reach coda — nothing in a browser or an extension takes them first.</li>
          <li><b>It&apos;s always up to date.</b> The app opens the live coda, so every change here is there the next time it opens.</li>
          <li><b>No Google sign-in.</b> Google won&apos;t sign in inside apps, so your partner&apos;s Google Doc flow opens read only, from
            the flow tab&apos;s link shared <i>Anyone with the link</i>. Writing straight into the Doc stays in the browser.</li>
          <li><b>It needs the internet</b>, as coda does in the browser.</li>
        </ul>

        <h2 className={s.h2}>Removing it</h2>
        <p className={s.p}>Settings › Apps › Installed apps › coda › Uninstall. Your files in the browser are untouched.</p>

        <p className={s.back}><Link href="/tools/magic">← Back to coda</Link></p>
      </section>
    </main>
  );
}
