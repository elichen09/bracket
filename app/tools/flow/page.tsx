import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import Flow from "@/components/tools/Flow";
import { isAdmin } from "@/lib/admin";
import { currentUser, displayName } from "@/lib/auth";
import "../tools.css";

export const metadata = { title: "Flow · The Break" };
export const dynamic = "force-dynamic";

/**
 * The flow gets the window, the same as Evidence does.
 *
 * One exception to the lock: a link carrying a room code opens without the
 * admin key. The tools are for whoever runs the thing, but the person you are
 * flowing with is your partner, not an administrator — and a room code is
 * already the thing that decides who may see that round. Without this the
 * share feature would only work between two people who both hold the key,
 * which is nobody's partnership.
 */
export default async function FlowTool({ searchParams }: { searchParams?: { join?: string | string[]; open?: string | string[] } }) {
  const raw = searchParams?.join;
  const join = (Array.isArray(raw) ? raw[0] : raw) || undefined;
  const rawOpen = searchParams?.open;
  const open = (Array.isArray(rawOpen) ? rawOpen[0] : rawOpen) || undefined;

  if (!isAdmin() && !join) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="Flow" /></section></main>
      </>
    );
  }
  // Your flows are yours: another account on the same browser opens its own.
  const user = await currentUser();
  return (
    <>
      <Nav />
      <main>
        <div className="toolpage"><Flow join={join} open={open} owner={user?.id} me={user ? displayName(user) : undefined} /></div>
      </main>
    </>
  );
}
