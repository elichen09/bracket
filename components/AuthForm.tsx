"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase";

export default function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [mode, setMode] = useState<"in" | "up">(params.get("mode") === "up" ? "up" : "in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const sb = supabaseBrowser();
      if (mode === "up") {
        const res = await fetch("/api/auth/signup", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, name }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "could not create the account");
      }
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(/invalid/i.test(error.message) ? "wrong email or password" : error.message);
      router.replace(next.startsWith("/") ? next : "/");
      router.refresh();
    } catch (e: any) {
      setErr(e.message || "something went wrong");
      setBusy(false);
    }
  }

  return (
    <form className="auth reveal" onSubmit={submit}>
      <div className="seg" role="group" aria-label="Sign in or create an account">
        <button type="button" aria-pressed={mode === "in"} onClick={() => { setMode("in"); setErr(""); }}>Sign in</button>
        <button type="button" aria-pressed={mode === "up"} onClick={() => { setMode("up"); setErr(""); }}>Create account</button>
      </div>
      {mode === "up" && (
        <label><span className="mono">Display name</span>
          <input value={name} maxLength={24} autoComplete="nickname" placeholder="what the leaderboard shows" onChange={(e) => setName(e.target.value)} required />
        </label>
      )}
      <label><span className="mono">Email</span>
        <input type="email" value={email} autoComplete="email" placeholder="you@school.edu" onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label><span className="mono">Password</span>
        <input type="password" value={password} autoComplete={mode === "up" ? "new-password" : "current-password"} placeholder={mode === "up" ? "at least 8 characters" : "••••••••"} minLength={8} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>{busy ? "One moment…" : mode === "up" ? "Create account" : "Sign in"}</button>
        <span className={"msg " + (err ? "bad" : "")}>{err}</span>
      </div>
      <p className="fine">
        {mode === "up"
          ? "No confirmation email — you're in as soon as you submit."
          : "New here? Switch to Create account. It takes ten seconds."}
      </p>
    </form>
  );
}
