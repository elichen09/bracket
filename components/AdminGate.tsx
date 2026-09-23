"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The lock on the tools.
 *
 * The key is checked on the server and comes back as a cookie the page cannot
 * read, so nothing here ever holds it. On success the router is refreshed
 * rather than navigated: the page behind this form is a server component, and
 * refreshing is what makes it re-render as an admin.
 */
export default function AdminGate({ what = "these tools" }: { what?: string }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) { setMsg("The admin key is required."); return; }
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminKey: key.trim() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "that didn't work");
      setKey("");
      router.refresh();
    } catch (err: any) {
      setMsg(err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="gate">
      <p className="mono">Admin only</p>
      <h1>Locked</h1>
      <p className="prose">
        {what[0].toUpperCase() + what.slice(1)} run on the admin key, not on an account. Enter it once and
        this browser stays unlocked for a month.
      </p>
      <form onSubmit={unlock}>
        <input type="password" placeholder="admin key" value={key} autoComplete="off" autoFocus
          onChange={(e) => setKey(e.target.value)} />
        <button type="submit" className="primary" disabled={busy}>{busy ? "Checking…" : "Unlock"}</button>
        {msg && <span className="msg bad">{msg}</span>}
      </form>
    </div>
  );
}
