import Nav from "@/components/Nav";
import AdminGate from "@/components/AdminGate";
import PastFlows from "@/components/tools/PastFlows";
import { isAdmin } from "@/lib/admin";
import { currentUser } from "@/lib/auth";
import "../tools.css";

export const metadata = { title: "Past flows · The Break" };
export const dynamic = "force-dynamic";

/** Every round this account has flowed, in either tool. */
export default async function PastFlowsTool() {
  if (!isAdmin()) {
    return (
      <>
        <Nav />
        <main><section className="view enter"><AdminGate what="Past flows" /></section></main>
      </>
    );
  }
  const user = await currentUser();
  return (
    <>
      <Nav />
      <main>
        <div className="toolpage"><PastFlows owner={user?.id} /></div>
      </main>
    </>
  );
}
