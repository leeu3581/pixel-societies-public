"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { login, signup } from "@/lib/authClient";
import Link from "next/link";
import LoginBackground from "@/components/LoginBackground";
import posthog from "posthog-js";
import { safeAuthNext } from "@/lib/auth-redirect";

type Mode = "signin" | "signup";

export default function LoginPage() {
  // useSearchParams() opts out of static prerendering — wrap the inner
  // form in Suspense so `next build` can still emit a placeholder shell.
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>(() => params.has("next") ? "signin" : "signup");
  const next = safeAuthNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error") ? "Sign-in failed. Try again." : null);
  const [notice, setNotice] = useState<string | null>(null);

  const configured = true;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configured) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        const user = await signup(email, password, displayName || email.split("@")[0]);
        posthog.identify(user.id, { email });
        posthog.capture("signed_up", { method: "email" });
        router.push("/onboarding");
      } else {
        const user = await login(email, password);
        posthog.identify(user.id, { email });
        posthog.capture("signed_in", { method: "email" });
        router.push(next);
      }
    } catch (err: unknown) {
      posthog.captureException(err instanceof Error ? err : new Error(String(err)));
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const signInWithGoogle = async () => {
    // Google OAuth isn't wired to the self-hosted auth yet (see
    // FRONTEND-MIGRATION.md §3). Point users at email/password for now.
    setNotice(null);
    setError(
      "Google sign-in isn't available yet — please sign in with email and password.",
    );
  };

  /* ── BGM ─────────────────────────────────────────────── */
  const musicRef = useRef<HTMLAudioElement>(null);
  const [musicMuted, setMusicMuted] = useState(false);
  const [musicStarted, setMusicStarted] = useState(false);

  // Start music on first user interaction (browsers block autoplay).
  useEffect(() => {
    const start = () => {
      const audio = musicRef.current;
      if (audio && !musicStarted) {
        audio.volume = 0.35;
        audio.loop = true;
        void audio.play().then(() => setMusicStarted(true)).catch(() => undefined);
      }
    };
    window.addEventListener("pointerdown", start, { once: true });
    window.addEventListener("keydown", start, { once: true });
    return () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
    };
  }, [musicStarted]);

  // Sync mute state.
  useEffect(() => {
    if (musicRef.current) musicRef.current.muted = musicMuted;
  }, [musicMuted]);

  return (
    <main className="relative flex min-h-dvh items-center justify-center px-4 py-8">
      {/* Animated map + characters canvas */}
      <LoginBackground />

      {/* BGM audio element */}
      <audio ref={musicRef} src="/music/bg-music.mp3" preload="auto" aria-hidden="true" />

      {/* Music toggle — top-right */}
      <button
        type="button"
        onClick={() => {
          const audio = musicRef.current;
          if (audio && !musicStarted) {
            audio.volume = 0.35;
            audio.loop = true;
            void audio.play().then(() => setMusicStarted(true)).catch(() => undefined);
          }
          setMusicMuted((v) => !v);
        }}
        className="fixed right-4 top-4 z-20 h-11 w-11 border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] font-mono text-lg font-bold text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] transition-transform hover:scale-105"
        title={musicMuted ? "Enable music" : "Mute music"}
        aria-label={musicMuted ? "Enable music" : "Mute music"}
      >
        {musicMuted ? "✕" : "♪"}
      </button>

      <div className="relative z-10 w-full max-w-md border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] p-5 text-[#1f2a3c] shadow-[5px_5px_0_#1f2a3c] sm:p-6">
        <div className="mb-5 flex items-start gap-3 border-[#9fb0bf] border-b-2 border-dashed pb-4">
          <div className="flex h-[56px] w-[56px] items-center justify-center border-[3px] border-[#1f2a3c] bg-[#dcecf4] shadow-[3px_3px_0_#1f2a3c]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="" aria-hidden src="/unicorn-intelligence-logo.svg" className="h-8 w-8" style={{ imageRendering: "pixelated" }} />
          </div>
          <div className="min-w-0 flex-1">
            <span className="bg-[#e8f1ff] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">Pixel Societies</span>
            <h1 className="mt-2 font-bold text-[26px] leading-tight">
              {mode === "signup" ? "Create your account" : "Welcome back"}
            </h1>
            <p className="mt-2 text-[#4f5c6d] text-sm leading-relaxed">
              {mode === "signup"
                ? "Sign up so your character + chats stick around when you come back."
                : "Sign in to pick up where you left off."}
            </p>
          </div>
        </div>

        {!configured && (
          <div className="mb-4 border-[3px] border-dashed border-[#c78a2a] bg-[#fff3dc] p-3 font-mono text-[11px] uppercase tracking-wider text-[#6b4a0f]">
            Supabase env vars missing — sign-in disabled. Set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY.
          </div>
        )}

        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={() => setMode("signup")}
            className={`flex-1 border-[3px] border-[#1f2a3c] px-4 py-3 font-mono text-sm font-bold uppercase shadow-[3px_3px_0_#1f2a3c] ${
              mode === "signup" ? "bg-[#e8f1ff]" : "bg-[#f6f4ea]"
            }`}
          >
            Create account
          </button>
          <button
            type="button"
            onClick={() => setMode("signin")}
            className={`flex-1 border-[3px] border-[#1f2a3c] px-4 py-3 font-mono text-sm font-bold uppercase shadow-[3px_3px_0_#1f2a3c] ${
              mode === "signin" ? "bg-[#e8f1ff]" : "bg-[#f6f4ea]"
            }`}
          >
            Sign in
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {mode === "signup" && (
            <input
              placeholder="Your name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-4 text-base font-semibold text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
              type="text"
            />
          )}
          <input
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-4 text-base font-semibold shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
            type="email"
            required
          />
          <input
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-4 text-base font-semibold shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
            type="password"
            required
            minLength={6}
          />

          {error && (
            <div className="border-[3px] border-[#b23a3a] bg-[#ffecec] p-2 font-mono text-[11px] uppercase tracking-wider text-[#6b1a1a]">
              {error}
            </div>
          )}
          {notice && (
            <div className="border-[3px] border-[#1f7a45] bg-[#e8f5e8] p-2 font-mono text-[11px] uppercase tracking-wider text-[#14532d]">
              {notice}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !configured}
            className="w-full border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-6 py-4 font-mono text-sm font-bold uppercase shadow-[4px_4px_0_#1f2a3c] disabled:cursor-not-allowed disabled:bg-[#d9deea]"
          >
            {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>

        <div className="my-4 flex items-center gap-2">
          <span className="h-[2px] flex-1 bg-[#9fb0bf]" />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#637387]">
            or
          </span>
          <span className="h-[2px] flex-1 bg-[#9fb0bf]" />
        </div>

        <button
          type="button"
          onClick={signInWithGoogle}
          disabled={busy || !configured}
          className="flex w-full items-center justify-center gap-3 border-[3px] border-[#1f2a3c] bg-white px-6 py-3 font-mono text-sm font-bold uppercase shadow-[4px_4px_0_#1f2a3c] disabled:cursor-not-allowed disabled:bg-[#d9deea]"
        >
          {/* Google "G" mark — inline SVG so no extra asset request. */}
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <path
              d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.255h2.908c1.702-1.567 2.684-3.875 2.684-6.612z"
              fill="#4285F4"
            />
            <path
              d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
              fill="#34A853"
            />
            <path
              d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
              fill="#FBBC05"
            />
            <path
              d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
              fill="#EA4335"
            />
          </svg>
          {busy ? "…" : "Continue with Google"}
        </button>

        <p className="mt-4 text-center text-[11px] text-[#637387]">
          <Link className="underline" href="/worlds">← skip, browse anonymously</Link>
        </p>
      </div>
    </main>
  );
}
