"use client";

import { useState } from "react";

/**
 * The pool's admin controls: pull Tabroom's results now, close the pool, open it
 * again.
 *
 * Locking is otherwise each person's own business, and a pool always has a few
 * who never get round to it. Once the bracket is up, that is the moment entries
 * should shut for everyone at once — so whoever runs the pool calls it, with the
 * same admin key the rest of the admin controls take.
 *
 * Opening is the same control in reverse, and it is not only an undo: a pool
 * shut too early, or one whose bracket Tabroom then redrew, has to be openable
 * hours later from a fresh page. Straight after a close it reopens exactly the
 * brackets that close shut; otherwise it unlocks every bracket in the pool,
 * which is the honest reading of "open it" and is what the confirm says.
 *
 * Updating is the one that gets used most. Results land when a round finishes,
 * and the scheduled job runs on the hour, so the page can sit a long way behind
 * a bracket people are watching. This pulls just this tournament, which takes
 * seconds rather than the whole-site rebuild the home page's update does.
 */
export default function AdminPool({ tid, onDone }: { tid: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<"close" | "open" | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "" | "bad" | "good" }>({ text: "", kind: "" });
  const [closedAt, setClosedAt] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, path = "close") {
    const res = await fetch(`/api/tournaments/${encodeURIComponent(tid)}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminKey: key.trim(), ...body }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "that didn't work");
    return j;
  }

  // Both actions take two clicks: the first arms the button and the label says
  // what the second one will do to other people's brackets.
  function arm(which: "close" | "open"): boolean {
    if (!key.trim()) { setMsg({ text: "Admin key required.", kind: "bad" }); return false; }
    if (armed !== which) { setArmed(which); setTimeout(() => setArmed(null), 5000); return false; }
    setArmed(null);
    return true;
  }

  async function run(which: "close" | "open") {
    setBusy(true);
    setMsg({ text: "", kind: "" });
    try {
      const n = (c: number) => `${c} bracket${c === 1 ? "" : "s"}`;
      if (which === "close") {
        const j = await post({});
        setClosedAt(j.at);
        setMsg({ text: `Closed — ${n(j.count)} locked.`, kind: "good" });
      } else {
        const j = await post({ open: true, at: closedAt });
        setClosedAt(null);
        setMsg({
          text: `Open — ${n(j.count)} unlocked.` + (j.startsAt ? ` New brackets can be started; picking and scoring begin at ${j.startsAt}.` : ""),
          kind: "good",
        });
      }
      onDone?.();
    } catch (err: any) {
      setMsg({ text: err.message, kind: "bad" });
    } finally { setBusy(false); }
  }

  async function sync() {
    if (!key.trim()) { setMsg({ text: "Admin key required.", kind: "bad" }); return; }
    setBusy(true);
    setMsg({ text: "", kind: "" });
    try {
      const j = await post({}, "sync");
      // syncTournament reports round by round; the last line is the useful one.
      const last = (j.log || []).slice(-1)[0] || "nothing new";
      setMsg({ text: j.changed ? `Updated — ${(j.log || []).join("; ")}` : `No change — ${last}`, kind: "good" });
      onDone?.();
    } catch (err: any) {
      setMsg({ text: err.message, kind: "bad" });
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <div className="admin-update">
        <button type="button" className="ghost" onClick={() => setOpen(true)}>Admin: update, close or open this pool</button>
      </div>
    );
  }

  return (
    <div className="admin-update">
      <form onSubmit={(e) => { e.preventDefault(); if (arm("close")) run("close"); }}>
        <input type="password" placeholder="admin key" value={key} autoComplete="off" onChange={(e) => setKey(e.target.value)} />
        <button type="button" className="primary" disabled={busy} onClick={sync}>
          {busy ? "Working…" : "Update results now"}
        </button>
        <button type="submit" className={"lock" + (armed === "close" ? " armed" : "")} disabled={busy}>
          {busy ? "Working…" : armed === "close" ? "Lock everyone's bracket?" : "Close the pool"}
        </button>
        <button type="button" className={"reopen" + (armed === "open" ? " armed" : "")} disabled={busy}
          onClick={() => { if (arm("open")) run("open"); }}>
          {armed === "open"
            ? (closedAt ? "Undo that close?" : "Unlock every bracket?")
            : "Open the pool"}
        </button>
        <button type="button" onClick={() => { setOpen(false); setArmed(null); setMsg({ text: "", kind: "" }); }}>Cancel</button>
        <span className={"msg " + msg.kind}>{msg.text}</span>
      </form>
    </div>
  );
}
