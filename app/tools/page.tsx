import Link from "next/link";
import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import AdminLock from "@/components/AdminLock";
import { isAdmin } from "@/lib/admin";
import { TOOLS } from "@/lib/tools";
import "./tools.css";

export const metadata = { title: "Tools · The Break" };
export const dynamic = "force-dynamic";      // the gate is read from a cookie

export default function Tools() {
  const admin = isAdmin();
  return (
    <>
      <Nav />
      <main>
        <section className="view enter">
          {!admin ? <AdminGate what="the tools" /> : (
            <>
              <div className="thead">
                <p className="crumb mono reveal"><Link href="/">← The Break</Link></p>
                <h1 className="reveal">Tools</h1>
                <p className="hint reveal" style={{ marginTop: 0 }}>
                  Each is a workbench of its own and keeps its own data in this browser. Start with the tutorial, or go straight to Round Magic.
                </p>
              </div>

              <div className="index" style={{ marginTop: 40 }}>
                {TOOLS.map((t, i) => (
                  <Link key={t.slug} href={`/tools/${t.slug}`} className="row toolrow">
                    <span className="n">{String(i + 1).padStart(2, "0")}</span>
                    <span className="t">{t.name}<small>{t.blurb}</small></span>
                    <span className="s mono">{t.storage.split("—")[0].trim()}</span>
                    <span className="a">→</span>
                  </Link>
                ))}
              </div>

              <AdminLock />
            </>
          )}
        </section>
      </main>
    </>
  );
}
