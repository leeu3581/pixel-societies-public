"use client";

// Step 1 of onboarding — capture display_name. Writes to public.profiles
// via the Supabase client (RLS lets the authed user upsert their own
// row). Adapted from the Pixel Societies NamePage with the Identity step
// chrome and brutalist tokens; bio kept as a simple optional field.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchSession } from "@/lib/authClient";
import { apiGet, apiPatch } from "@/lib/api";
import BrandChip from "@/components/BrandChip";
import posthog from "posthog-js";

const MAP_BG = "/onboarding/map-bg.png";
const CHAR_PREVIEW = "/onboarding/char-preview.png";
const LAPTOP = "/onboarding/laptop.png";

export default function OnboardingNamePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const auth = await fetchSession();
      if (!auth) {
        router.replace("/login?next=/onboarding/name");
        return;
      }
      try {
        const me = await apiGet<{ profile: { display_name: string | null; bio: string | null } | null }>("/api/me");
        if (me.profile?.display_name) setDisplayName(me.profile.display_name);
        if (me.profile?.bio) setBio(me.profile.bio);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [router]);

  const canContinue = Boolean(displayName.trim());

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPatch("/api/me/profile", {
        display_name: displayName.trim(),
        bio: bio.trim() || null,
      });
      posthog.capture("onboarding_profile_saved", { has_bio: Boolean(bio.trim()) });
      router.push("/onboarding/photo");
    } catch (err: unknown) {
      posthog.captureException(err instanceof Error ? err : new Error(String(err)));
      setError(err instanceof Error ? err.message : "Couldn't save profile");
    } finally {
      setBusy(false);
    }
  };

  const bgStyle = {
    backgroundImage: `linear-gradient(rgba(12, 22, 38, 0.72), rgba(12, 22, 38, 0.82)), url(${MAP_BG})`,
    backgroundPosition: "center top",
    backgroundSize: "cover",
  } as const;

  if (loading) {
    return (
      <main
        className="flex min-h-dvh items-center justify-center bg-[#0c1626] px-4"
        style={bgStyle}
      >
        <BrandChip />
        <div className="font-mono text-sm uppercase tracking-wider text-[#dcecf4]">
          Loading…
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#0c1626] pb-28" style={bgStyle}>
      <BrandChip />
      <div className="mx-auto max-w-2xl px-3 pt-20 pb-4 sm:px-4 sm:pt-24 sm:pb-5">
        {/* Header chip with character preview + headline + laptop prop */}
        <div className="mb-4 border-[3px] border-[#1f2a3c] bg-[rgba(236,231,217,0.96)] p-3 text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c] sm:p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-[54px] w-[54px] items-center justify-center border-[3px] border-[#1f2a3c] bg-[#dcecf4] shadow-[3px_3px_0_#1f2a3c]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={CHAR_PREVIEW}
                alt="Pixel character preview"
                className="h-[44px] w-[22px] object-contain"
                style={{ imageRendering: "pixelated" }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="bg-[#e8f1ff] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
                  Pixel Societies
                </span>
                <span className="bg-[#ddd7c8] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
                  Step 1 of 3
                </span>
              </div>
              <h1 className="mb-1 font-mono text-xl font-bold uppercase leading-tight sm:text-2xl">
                What is your name?
              </h1>
              <p className="max-w-2xl text-sm leading-relaxed text-[#425166] sm:text-[15px]">
                Your name powers your profile, your office badge, and the
                sprite generation step that comes next.
              </p>
            </div>
            <div className="hidden h-[54px] w-[54px] items-center justify-center border-[3px] border-[#1f2a3c] bg-[#f6f4ea] shadow-[3px_3px_0_#1f2a3c] sm:flex">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={LAPTOP}
                alt="Laptop prop"
                className="h-[26px] w-[26px] object-contain"
                style={{ imageRendering: "pixelated" }}
              />
            </div>
          </div>
        </div>

        {/* Form card */}
        <div className="border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] p-4 text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c] sm:p-5">
          <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-4 shadow-[3px_3px_0_#1f2a3c] sm:p-5">
            <p className="mb-2 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#637387]">
              Identity
            </p>
            <h2 className="mb-3 text-[24px] font-bold leading-tight sm:text-[28px]">
              What name should appear in the pixel office?
            </h2>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canContinue && !busy) save();
              }}
              placeholder="Your name"
              className="w-full border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-4 py-4 text-lg font-semibold text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
              autoFocus
            />

            <label className="mt-5 mb-1 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]">
              About you (optional)
            </label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              placeholder="Consultant turned founder, into photography and long walks."
              className="w-full resize-none border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-4 py-3 text-sm shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
              maxLength={500}
            />
            <div className="mt-1 text-right font-mono text-[10px] text-[#7f8b98]">
              {bio.length}/500
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-3 border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24] shadow-[3px_3px_0_#1f2a3c]">
            {error}
          </div>
        )}
      </div>

      {/* Sticky footer with primary action */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t-[3px] border-[#1f2a3c] bg-[rgba(236,231,217,0.98)] p-3 shadow-[0_-4px_0_#1f2a3c]">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[#637387]">
              Identity step
            </p>
            <p className="truncate text-sm text-[#425166]">
              {canContinue
                ? "Name ready. Continue to sprite setup."
                : "Enter your name to continue."}
            </p>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={!canContinue || busy}
            className="min-w-[132px] border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-4 py-3 font-mono text-sm font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:bg-[#d9deea]"
          >
            {busy ? "Saving…" : "Next"}
          </button>
        </div>
      </div>
    </main>
  );
}
