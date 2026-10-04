"use client";
import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const isLogin = mode === "login";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const supabase = createClient();
    if (isLogin) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg(error.message);
      else window.location.href = "/dashboard";
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/onboarding` },
      });
      if (error) setMsg(error.message);
      else if (data.session) window.location.href = "/onboarding";
      else setMsg("Semak emel anda untuk mengesahkan akaun. / Check your email to confirm your account.");
    }
    setBusy(false);
  }

  async function google() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/dashboard` },
    });
  }

  return (
    <div className="mx-auto mt-16 max-w-sm px-4">
      <Link href="/" className="mb-8 block text-center text-2xl font-extrabold text-brand-700">
        Layankan
      </Link>
      <div className="card space-y-4">
        <h1 className="text-xl font-bold">{isLogin ? "Log masuk" : "Daftar akaun"}</h1>
        <button type="button" onClick={google} className="btn-secondary w-full">
          Teruskan dengan Google
        </button>
        <div className="text-center text-xs text-zinc-400">atau</div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label" htmlFor="email">Emel</label>
            <input id="email" type="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div>
            <label className="label" htmlFor="password">Kata laluan</label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isLogin ? "current-password" : "new-password"}
            />
          </div>
          <button disabled={busy} className="btn-primary w-full">
            {busy ? "…" : isLogin ? "Log masuk" : "Daftar"}
          </button>
        </form>
        {msg && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{msg}</p>}
        <p className="text-center text-sm text-zinc-500">
          {isLogin ? (
            <>Belum ada akaun? <Link className="font-semibold text-brand-700" href="/signup">Daftar</Link></>
          ) : (
            <>Sudah ada akaun? <Link className="font-semibold text-brand-700" href="/login">Log masuk</Link></>
          )}
        </p>
        {!isLogin && (
          <p className="text-xs text-zinc-400">
            Dengan mendaftar, anda bersetuju dengan <Link href="/privacy" className="underline">Notis Privasi</Link> kami.
          </p>
        )}
      </div>
    </div>
  );
}
