"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Drops the admin cookie again — for a borrowed or shared machine. */
export default function AdminLock() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <div className="admin-update">
      <button type="button" className="ghost" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await fetch("/api/admin", { method: "DELETE" }); router.refresh(); }
        finally { setBusy(false); }
      }}>
        {busy ? "Locking…" : "Lock the tools on this browser"}
      </button>
    </div>
  );
}
