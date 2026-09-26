import Peek, { type PeekView } from "@/components/tools/Peek";
import { currentUser } from "@/lib/auth";
import "../tools.css";
import "@/components/tools/peek.css";

export const metadata = { title: "Pop-out · The Break" };
export const dynamic = "force-dynamic";

const VIEWS: PeekView[] = ["doc", "send", "flow", "docflow"];

/**
 * A pop-out window (Pop out, in any tool): one thing from one tool, to look
 * at. No site nav and no admin key — it shows only what this browser already
 * holds (the Doc viewer's docs, the flow, Evidence's send doc), and changes
 * none of it.
 */
export default async function PeekPage({ searchParams }: { searchParams?: { v?: string | string[]; doc?: string | string[]; id?: string | string[] } }) {
  const one = (x?: string | string[]) => (Array.isArray(x) ? x[0] : x) || undefined;
  const v = one(searchParams?.v);
  const view: PeekView = VIEWS.includes(v as PeekView) ? (v as PeekView) : "doc";
  const user = await currentUser();
  return (
    <main>
      <div className="toolpage peekpage"><Peek owner={user?.id} view={view} doc={one(searchParams?.doc)} id={one(searchParams?.id)} /></div>
    </main>
  );
}
