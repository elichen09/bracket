import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import Split from "@/components/tools/Split";
import { isAdmin } from "@/lib/admin";
import "../tools.css";

export const metadata = { title: "Split screen · The Break" };
export const dynamic = "force-dynamic";

/** Any two tools side by side, each whole, in one window. `?a=flow` puts that one on the left. */
export default function SplitTool({ searchParams }: { searchParams?: { a?: string | string[] } }) {
  const a = (Array.isArray(searchParams?.a) ? searchParams?.a[0] : searchParams?.a) || undefined;
  if (!isAdmin()) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="Split screen" /></section></main>
      </>
    );
  }
  return (
    <>
      <Nav />
      <main>
        <div className="toolpage"><Split first={a} /></div>
      </main>
    </>
  );
}
