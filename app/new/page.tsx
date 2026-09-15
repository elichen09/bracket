"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";

export default function NewTournament() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ text: string; kind: "" | "bad" | "good" }>({ text: "", kind: "" });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg({ text: "", kind: "" });
    const f = e.currentTarget;
    const body = {
      adminKey: (f.elements.namedItem("admin") as HTMLInputElement).value.trim(),
      name: (f.elements.namedItem("name") as HTMLInputElement).value.trim(),
      event: (f.elements.namedItem("event") as HTMLInputElement).value.trim(),
      url: (f.elements.namedItem("url") as HTMLInputElement).value.trim(),
      roundUrl: (f.elements.namedItem("round") as HTMLInputElement).value.trim(),
      slotsText: (f.elements.namedItem("slots") as HTMLTextAreaElement).value,
    };
    if (!body.adminKey) { setMsg({ text: "The admin key is required to add a tournament.", kind: "bad" }); return; }
    if (!/tourn_id=\d+/.test(body.url) || !/result_id=\d+/.test(body.url)) {
      setMsg({ text: "That link needs both tourn_id and result_id — copy it from the bracket page.", kind: "bad" }); return;
    }
    if (!body.name) { setMsg({ text: "Give it a name.", kind: "bad" }); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/tournaments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "could not create");
      setMsg({ text: "Created.", kind: "good" });
      setTimeout(() => router.push(`/t/${j.id}`), 300);
    } catch (err: any) {
      setMsg({ text: err.message, kind: "bad" });
      setBusy(false);
    }
  }

  return (
    <>
      <Nav />
      <main>
        <section className="view enter">
          <div className="thead">
            <h1 className="reveal">Add a <em style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400 }}>tournament</em></h1>
            <p className="prose reveal">Paste the Tabroom bracket link. The bracket is pulled in on the next automatic update — usually within the hour. Add the first elim round&rsquo;s results link too, if it exists yet: that is what lets results start flowing. If you have the bracket in front of you, paste the seeded list to open it for picks right away.</p>
          </div>
          <form className="form reveal" onSubmit={submit}>
            <label><span className="mono">Admin key</span><input name="admin" type="password" placeholder="the passphrase you set in ADMIN_KEY" autoComplete="off" /></label>
            <label><span className="mono">Tabroom bracket link</span><input name="url" placeholder="https://www.tabroom.com/index/tourn/results/bracket.mhtml?tourn_id=…&result_id=…" /></label>
            <label><span className="mono">Tournament name</span><input name="name" placeholder="e.g. Glenbrooks" maxLength={60} /></label>
            <label><span className="mono">Event · division</span><input name="event" placeholder="e.g. Public Forum · Varsity" maxLength={60} /></label>
            <label><span className="mono">First elim round results link (optional)</span><input name="round" placeholder="https://www.tabroom.com/index/tourn/results/round_results.mhtml?tourn_id=…&round_id=…" /></label>
            <label><span className="mono">Bracket list (optional)</span><textarea name="slots" placeholder={"One team per line, in bracket order, exactly as Tabroom lists them:\n1. Emory GY\n32. Kentucky SR\n…\nLeave a blank line for a bye."} /></label>
            <div className="row">
              <button type="submit" className="primary" disabled={busy}>{busy ? "Creating…" : "Create tournament"}</button>
              <span className={"msg " + msg.kind}>{msg.text}</span>
            </div>
          </form>
        </section>
      </main>
    </>
  );
}
