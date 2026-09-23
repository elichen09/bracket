import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import Evidence from "@/components/tools/Evidence";
import { isAdmin } from "@/lib/admin";
import "../tools.css";

export const metadata = { title: "Evidence · The Break" };
export const dynamic = "force-dynamic";

/**
 * The tool gets the window. No title band, no blurb: what it is and where it
 * came from live in its own toolbar, and every pixel of the rest is the work.
 */
export default function EvidenceTool() {
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
        <div className="toolpage"><Evidence /></div>
      </main>
    </>
  );
}
