import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import RoundMagic from "@/components/tools/RoundMagic";
import Embedded from "@/components/tools/Embedded";
import { isAdmin } from "@/lib/admin";
import { currentUser, displayName } from "@/lib/auth";
import "../tools.css";

export const metadata = { title: "Round Magic · The Break" };
export const dynamic = "force-dynamic";

const FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap";

/**
 * Round Magic — the card cutter, the library and the speech doc, and the
 * other team's docs, in one window. Like Evidence and the Doc viewer before
 * it, a link carrying a room code (or a SpeechDrop room) opens without the
 * admin key: a partner sent here to build the speech doc is a debater, not
 * an administrator.
 */
export default async function RoundMagicTool({ searchParams }: { searchParams?: { room?: string | string[]; sd?: string | string[]; embed?: string | string[] } }) {
  const one = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v) || undefined;
  const room = one(searchParams?.room);
  const sd = one(searchParams?.sd);
  if (!isAdmin() && !room && !sd) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="Round Magic" /></section></main>
      </>
    );
  }
  const user = await currentUser();
  const embed = !!searchParams?.embed;
  return (
    <>
      <link rel="stylesheet" href={FONTS} />
      {embed ? <Embedded /> : <Nav />}
      <main>
        <div className="toolpage"><RoundMagic owner={user?.id} me={user ? displayName(user) : undefined} room={room} sd={sd} /></div>
      </main>
    </>
  );
}
