"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Zap } from "lucide-react";

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get("redirect") ?? "/app/dashboard";
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setInfo(null); setLoading(true);
    const supabase = createSupabaseBrowserClient();
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setInfo("Account created. If email confirmation is required, check your inbox then sign in.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(redirect);
        router.refresh();
      }
    } catch (e: any) {
      setErr(e?.message ?? "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-5">
      <div className="card w-full max-w-md p-6 md:p-8">
        <div className="flex items-center gap-2 mb-5">
          <Zap size={22} style={{ color: "var(--accent)" }} />
          <div>
            <div className="font-semibold text-lg tracking-tight leading-tight">Legion Opportunity Scanner</div>
            <div className="text-xs text-[var(--text-muted)]">Find the next Legion before anyone else does.</div>
          </div>
        </div>

        <div className="flex gap-1 mb-5 p-1 rounded-lg bg-[var(--bg-3)] border border-[var(--border)]">
          <button type="button"
            className="flex-1 py-1.5 rounded-md text-sm font-medium"
            style={{ background: mode === "signin" ? "var(--bg-2)" : "transparent", color: mode === "signin" ? "var(--text)" : "var(--text-muted)" }}
            onClick={() => setMode("signin")}>Sign in</button>
          <button type="button"
            className="flex-1 py-1.5 rounded-md text-sm font-medium"
            style={{ background: mode === "signup" ? "var(--bg-2)" : "transparent", color: mode === "signup" ? "var(--text)" : "var(--text-muted)" }}
            onClick={() => setMode("signup")}>Sign up</button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" required minLength={6} value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
          </div>
          {err && <div className="text-xs text-[var(--red)] p-2 rounded-md bg-[rgba(248,113,113,0.08)] border border-[rgba(248,113,113,0.2)]">{err}</div>}
          {info && <div className="text-xs text-[var(--green)] p-2 rounded-md bg-[rgba(74,222,128,0.08)] border border-[rgba(74,222,128,0.2)]">{info}</div>}
          <button className="btn btn-primary w-full" disabled={loading}>
            {loading ? "…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}
