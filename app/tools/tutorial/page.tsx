import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import Tutorial from "@/components/tools/Tutorial";
import { isAdmin } from "@/lib/admin";
import "../tools.css";

export const metadata = { title: "Tutorial · The Break" };
export const dynamic = "force-dynamic";

/** Every tool, explained — behind the same key as the tools it explains. */
export default function TutorialPage() {
  if (!isAdmin()) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="the tools" /></section></main>
      </>
    );
  }
  return (
    <>
      <Nav />
      <main>
        <div className="toolpage"><Tutorial /></div>
      </main>
    </>
  );
}
