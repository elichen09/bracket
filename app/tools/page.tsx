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
                <p className="crumb mono reveal"><Link href="/">← Tournaments</Link></p>
                <h1 className="reveal">Tools</h1>
                <p className="hint reveal" style={{ marginTop: 0 }}>
                  Workbenches, not part of any pool. Each runs on the admin key and keeps its own data.
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
