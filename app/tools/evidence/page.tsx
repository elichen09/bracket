import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import Evidence from "@/components/tools/Evidence";
import { isAdmin } from "@/lib/admin";
import { currentUser, displayName } from "@/lib/auth";
import "../tools.css";

export const metadata = { title: "Evidence · The Break" };
export const dynamic = "force-dynamic";

/**
 * The tool gets the window. No title band, no blurb: what it is and where it
 * came from live in its own toolbar, and every pixel of the rest is the work.
 */
/**
 * One exception to the lock, the same one Flow makes: a link carrying a room
 * code opens without the admin key. That link is how a partner is sent here
 * to build the send doc for the flow, and a partner is not an administrator.
 */
export default async function EvidenceTool({ searchParams }: { searchParams?: { room?: string | string[] } }) {
  const raw = searchParams?.room;
  const room = (Array.isArray(raw) ? raw[0] : raw) || undefined;
  if (!isAdmin() && !room) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="Evidence" /></section></main>
      </>
    );
  }
  // The library is this account's alone: another person signed in on the same
  // browser opens their own.
  const user = await currentUser();
  return (
    <>
      <Nav />
      <main>
        <div className="toolpage"><Evidence owner={user?.id} me={user ? displayName(user) : undefined} room={room} /></div>
      </main>
    </>
  );
}
