import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import Cutter from "@/components/tools/Cutter";
import Embedded from "@/components/tools/Embedded";
import { isAdmin } from "@/lib/admin";
import { currentUser } from "@/lib/auth";
import "../tools.css";

export const metadata = { title: "Card cutter · The Break" };
export const dynamic = "force-dynamic";

/** Cutting cards into files of your own, by key; every file is in Evidence's search too. */
export default async function CutterTool({ searchParams }: { searchParams?: { embed?: string | string[] } }) {
  if (!isAdmin()) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="Card cutter" /></section></main>
      </>
    );
  }
  const user = await currentUser();
  const embed = !!searchParams?.embed;
  return (
    <>
      {embed ? <Embedded /> : <Nav />}
      <main>
        <div className="toolpage"><Cutter owner={user?.id} /></div>
      </main>
    </>
  );
}
