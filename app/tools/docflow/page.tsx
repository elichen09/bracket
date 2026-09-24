import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import DocFlow from "@/components/tools/DocFlow";
import { isAdmin } from "@/lib/admin";
import { currentUser, displayName } from "@/lib/auth";
import "../tools.css";

export const metadata = { title: "Doc flow · The Break" };
export const dynamic = "force-dynamic";

/**
 * The flow as a document gets the window, like the other tools — and, as
 * with Flow, a link carrying a room code opens without the admin key, since
 * the person you flow with is your partner, not an administrator.
 */
export default async function DocFlowTool({ searchParams }: { searchParams?: { join?: string | string[]; open?: string | string[] } }) {
  const raw = searchParams?.join;
  const join = (Array.isArray(raw) ? raw[0] : raw) || undefined;
  const rawOpen = searchParams?.open;
  const open = (Array.isArray(rawOpen) ? rawOpen[0] : rawOpen) || undefined;

  if (!isAdmin() && !join) {
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
        <div className="toolpage"><DocFlow join={join} open={open} owner={user?.id} me={user ? displayName(user) : undefined} /></div>
      </main>
    </>
  );
}
