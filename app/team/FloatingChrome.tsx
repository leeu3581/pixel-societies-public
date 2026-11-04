"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSession } from "@/lib/authClient";
import { apiGet } from "@/lib/api";

const MUSIC_KEY = "crowdsource-intelligence-music-on";
const MUSIC_SRC = "/crowdsource-intelligence-music.mp3";

/**
 * Top-of-page chrome: brand chip on the left, music toggle on the right.
 * Floats above the canvas but below the chat drawer (z-30).
 *
 * Music autoplay is blocked until the user interacts, so we start muted and
 * kick playback the first time they tap the ♪ button. Preference persists
 * in localStorage across visits.
 */
export default function FloatingChrome() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [userLabel, setUserLabel] = useState<string | null>(null);
  const supaConfigured = true;

  // Read saved preference + auth status on mount
  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem(MUSIC_KEY);
    if (saved === "on") {
      void attemptPlay();
    }
    void (async () => {
      const auth = await fetchSession();
      if (!auth) return;
      try {
        const me = await apiGet<{ profile: { display_name: string | null } | null }>("/api/me");
        setUserLabel(me.profile?.display_name || auth.email?.split("@")[0] || "you");
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const attemptPlay = useCallback(async () => {
    const el = audioRef.current;
    if (!el) return;
    try {
      el.volume = 0.35;
      await el.play();
      setPlaying(true);
      localStorage.setItem(MUSIC_KEY, "on");
    } catch {
      // Autoplay blocked — user needs to click.
      setPlaying(false);
    }
  }, []);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    setPlaying(false);
    localStorage.setItem(MUSIC_KEY, "off");
  }, []);

  const toggle = useCallback(() => {
    if (playing) stop();
    else void attemptPlay();
  }, [playing, stop, attemptPlay]);

  return (
    <>
      <audio
        ref={audioRef}
        src={MUSIC_SRC}
        loop
        preload="auto"
        aria-hidden
      />
      <div className="pointer-events-none fixed inset-x-3 top-3 z-30 flex items-start justify-between gap-3 sm:inset-x-4 sm:top-4">
        {/* Brand chip (top-left) */}
        <a
          href="/"
          className="pointer-events-auto flex items-center gap-2.5 border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] px-3 py-2 no-underline shadow-[3px_3px_0_#1f2a3c] transition-transform hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_#1f2a3c]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="Crowdsource Intelligence"
            src="/unicorn-intelligence-logo.svg"
            className="h-7 w-7 shrink-0"
            style={{ imageRendering: "pixelated" }}
          />
          <div className="flex flex-col leading-tight">
            <span className="font-bold text-[13px] text-[#1f2a3c]">
              Crowdsource Intelligence
            </span>
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#4f5c6d]">
              Meet the people
            </span>
          </div>
        </a>

        {/* Account pill (shows current user or sign-in link). Hidden if Supabase isn't configured. */}
        {supaConfigured && (
          <a
            href={userLabel ? "/onboarding" : "/login"}
            className="pointer-events-auto hidden items-center gap-2 border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] px-3 py-2 no-underline shadow-[3px_3px_0_#1f2a3c] transition-transform hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_#1f2a3c] sm:flex"
          >
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#4f5c6d]">
              {userLabel ? "Profile" : "Sign in"}
            </span>
            {userLabel && (
              <span className="font-bold text-[12px] text-[#1f2a3c]">{userLabel}</span>
            )}
          </a>
        )}

        {/* Music toggle (top-right) */}
        <button
          type="button"
          onClick={toggle}
          title={playing ? "Mute music" : "Play music"}
          aria-label={playing ? "Mute music" : "Play music"}
          aria-pressed={playing}
          className={`pointer-events-auto flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1f2a3c] font-mono text-lg font-bold text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] transition-transform hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_#1f2a3c] ${
            playing ? "bg-[#e8f1ff]" : "bg-[rgba(246,244,234,0.97)]"
          }`}
          suppressHydrationWarning
        >
          <span className={mounted && !playing ? "relative after:absolute after:inset-x-[-3px] after:top-1/2 after:h-[2px] after:rotate-[-25deg] after:bg-[#1f2a3c]" : ""}>
            ♪
          </span>
        </button>
      </div>
    </>
  );
}
