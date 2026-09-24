import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import DocFlow from "@/components/tools/DocFlow";
import { isAdmin } from "@/lib/admin";
import { currentUser, displayName } from "@/lib/auth";
import "../tools.css";

export const metadata = { title: "Doc flow · The Break" };
export const dynamic = "force-dynamic";

/** The flow as a document gets the window, like the other tools. */
export default async function DocFlowTool() {
  if (!isAdmin()) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="Doc flow" /></section></main>
      </>
    );
  }
  // Each account keeps its own flows.
  const user = await currentUser();
  return (
    <>
      <Nav />
      <main>
        <div className="toolpage"><DocFlow owner={user?.id} me={user ? displayName(user) : undefined} /></div>
      </main>
    </>
  );
}
