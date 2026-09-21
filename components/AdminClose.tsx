"use client";

import { useState } from "react";

/**
 * Closes a pool by hand.
 *
 * Locking is otherwise each person's own business, and a pool always has a few
 * who never get round to it. Once the bracket is up, that is the moment entries
 * should shut for everyone at once — so whoever runs the pool calls it, with the
 * same admin key the rest of the admin controls take.
 *
 * The close is undoable for as long as this panel is open: it reopens exactly
 * the brackets it shut, and never one its owner had locked beforehand.
 */
export default function AdminClose({ tid, onDone }: { tid: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "" | "bad" | "good" }>({ text: "", kind: "" });
  const [closedAt, setClosedAt] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/tournaments/${encodeURIComponent(tid)}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminKey: key.trim(), ...body }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "that didn't work");
    return j;
  }

  async function close(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) { setMsg({ text: "Admin key required.", kind: "bad" }); return; }
    if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 5000); return; }
    setArmed(false);
    setBusy(true);
    try {
      const j = await post({});
      setClosedAt(j.at);
      setMsg({ text: `Closed — ${j.count} bracket${j.count === 1 ? "" : "s"} locked.`, kind: "good" });
      onDone?.();
    } catch (err: any) {
      setMsg({ text: err.message, kind: "bad" });
    } finally { setBusy(false); }
  }

  async function reopen() {
    setBusy(true);
    try {
      const j = await post({ open: true, at: closedAt });
      setClosedAt(null);
      setMsg({ text: `Reopened ${j.count} bracket${j.count === 1 ? "" : "s"}.`, kind: "good" });
      onDone?.();
    } catch (err: any) {
      setMsg({ text: err.message, kind: "bad" });
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <div className="admin-update">
        <button type="button" className="ghost" onClick={() => setOpen(true)}>Admin: close this pool</button>
      </div>
    );
  }

  return (
    <div className="admin-update">
      <form onSubmit={close}>
        <input type="password" placeholder="admin key" value={key} autoComplete="off" onChange={(e) => setKey(e.target.value)} />
        {closedAt
          ? <button type="button" onClick={reopen} disabled={busy}>{busy ? "Reopening…" : "Reopen the pool"}</button>
          : <button type="submit" className={"lock" + (armed ? " armed" : "")} disabled={busy}>
              {busy ? "Closing…" : armed ? "Lock everyone's bracket?" : "Close the pool"}
            </button>}
        <button type="button" onClick={() => { setOpen(false); setArmed(false); setMsg({ text: "", kind: "" }); }}>Cancel</button>
        <span className={"msg " + msg.kind}>{msg.text}</span>
      </form>
    </div>
  );
}
