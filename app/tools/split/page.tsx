import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import Split from "@/components/tools/Split";
import { isAdmin } from "@/lib/admin";
import "../tools.css";

export const metadata = { title: "Evidence + Flow · The Break" };
export const dynamic = "force-dynamic";

/** Evidence and Flow side by side, each the whole tool, in one window. */
export default function SplitTool() {
  if (!isAdmin()) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="Evidence + Flow" /></section></main>
      </>
    );
  }
  return (
    <>
      <Nav />
      <main>
        <div className="toolpage"><Split /></div>
      </main>
    </>
  );
}
