"use client";

import { useState } from "react";

// Lets an admin trigger /api/update by hand instead of waiting for the next
// Vercel Cron run. Guarded by the same ADMIN_KEY used on /new.
export default function AdminUpdate() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "" | "bad" | "good" }>({ text: "", kind: "" });
  const [summary, setSummary] = useState<string[] | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const adminKey = key.trim();
    if (!adminKey) { setMsg({ text: "Admin key required.", kind: "bad" }); return; }
    setBusy(true);
    setMsg({ text: "", kind: "" });
    setSummary(null);
    try {
      const res = await fetch("/api/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminKey }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "update failed");
      const changed = (j.summary || []).filter((s: string) => !s.endsWith(": no change")).length;
      setMsg({ text: `Checked ${j.checked} tournament${j.checked === 1 ? "" : "s"} — ${changed} changed.`, kind: "good" });
      setSummary(j.summary || []);
    } catch (err: any) {
      setMsg({ text: err.message, kind: "bad" });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="admin-update">
        <button type="button" className="ghost" onClick={() => setOpen(true)}>Admin: force update</button>
      </div>
    );
  }

  return (
    <div className="admin-update">
      <form onSubmit={run}>
        <input
          type="password"
          placeholder="admin key"
          value={key}
          autoComplete="off"
          onChange={(e) => setKey(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy}>{busy ? "Updating…" : "Force update"}</button>
        <button type="button" onClick={() => { setOpen(false); setMsg({ text: "", kind: "" }); setSummary(null); }}>Cancel</button>
        <span className={"msg " + msg.kind}>{msg.text}</span>
      </form>
      {summary && (
        <ul className="admin-summary mono">
          {summary.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      )}
    </div>
  );
}
