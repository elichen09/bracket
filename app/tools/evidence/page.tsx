import Link from "next/link";
import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import Evidence from "@/components/tools/Evidence";
import { isAdmin } from "@/lib/admin";
import { toolBySlug } from "@/lib/tools";
import "../tools.css";

export const metadata = { title: "Evidence · The Break" };
export const dynamic = "force-dynamic";

export default function EvidenceTool() {
  const tool = toolBySlug("evidence")!;
  if (!isAdmin()) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="Evidence" /></section></main>
      </>
    );
  }
  return (
    <>
      <Nav />
      <main>
        <div className="toolpage">
          <div className="toolhead">
            <Link className="crumb mono" href="/tools">← Tools</Link>
            <h1>{tool.name}</h1>
            <p className="about">{tool.about}</p>
            <span className="where mono">In this browser only</span>
          </div>
          <Evidence />
        </div>
      </main>
    </>
  );
}
