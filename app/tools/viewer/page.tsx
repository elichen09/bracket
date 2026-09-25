import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import DocViewer from "@/components/tools/DocViewer";
import Embedded from "@/components/tools/Embedded";
import { isAdmin } from "@/lib/admin";
import { currentUser, displayName } from "@/lib/auth";
import "../tools.css";

export const metadata = { title: "Doc viewer · The Break" };
export const dynamic = "force-dynamic";

/**
 * Reading another person's doc. Like Flow, a link carrying a room code (or a
 * SpeechDrop room) opens without the admin key: the person reading their
 * partner's send doc is a debater, not an administrator.
 */
export default async function DocViewerTool({ searchParams }: { searchParams?: { room?: string | string[]; sd?: string | string[]; embed?: string | string[] } }) {
  const one = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v) || undefined;
  const room = one(searchParams?.room);
  const sd = one(searchParams?.sd);
  if (!isAdmin() && !room && !sd) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="Doc viewer" /></section></main>
      </>
    );
  }
  const user = await currentUser();
  // inside Split screen: the split page has the nav, and this is half of it
  const embed = !!searchParams?.embed;
  return (
    <>
      {embed ? <Embedded /> : <Nav />}
      <main>
        <div className="toolpage"><DocViewer owner={user?.id} me={user ? displayName(user) : undefined} room={room} sd={sd} /></div>
      </main>
    </>
  );
}
