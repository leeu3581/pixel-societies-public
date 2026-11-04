"use client";

// Profile page — view and edit your display name, bio, social links,
// and see your photo + inventory through the authenticated backend API.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fetchSession } from "@/lib/authClient";
import { apiGet, apiPatch } from "@/lib/api";
import GmailContext from "@/components/GmailContext";
import TwinMemory from "@/components/TwinMemory";
import BrandChip from "@/components/BrandChip";

const MAP_BG = "/onboarding/map-bg.png";

type SocialLinks = {
  github?: string;
  linkedin?: string;
  twitter?: string;
  instagram?: string;
};

type MeResp = {
  profile: {
    display_name: string | null;
    bio: string | null;
    photo_url: string | null;
    social_links: SocialLinks | null;
  } | null;
  home_world: { id: string } | null;
};

export default function ProfilePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [social, setSocial] = useState<SocialLinks>({});
  const [userId, setUserId] = useState<string | null>(null);

  // Inventory summary
  const [selfAgentId, setSelfAgentId] = useState<string | null>(null);
  const [pebbles, setPebbles] = useState<number | null>(null);
  const [itemCount, setItemCount] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const auth = await fetchSession();
      if (!auth) { router.replace("/login?next=/profile"); return; }

      setUserId(auth.id);

      let me: MeResp;
      try {
        me = await apiGet<MeResp>("/api/me");
      } catch {
        setError("Couldn't load profile");
        setLoading(false);
        return;
      }
      if (me.profile) {
        setDisplayName(me.profile.display_name ?? "");
        setBio(me.profile.bio ?? "");
        setPhotoUrl(me.profile.photo_url ?? null);
        setSocial((me.profile.social_links as SocialLinks) ?? {});
      }

      // Load inventory from self-agent
      try {
        if (me.home_world?.id) {
          const { agents } = await apiGet<{
            agents: Array<{ id: string; canonical_id: string | null }>;
          }>(`/api/worlds/${me.home_world.id}/agents`);
          const selfAgent = agents.find((a) => a.canonical_id === null);
          if (selfAgent) {
            setSelfAgentId(selfAgent.id);
            try {
              const inv = await apiGet<{
                pebbles: number;
                slots: Array<{ quantity: number }>;
              }>(`/api/agents/${selfAgent.id}/inventory`);
              setPebbles(inv.pebbles);
              setItemCount(inv.slots.reduce((n, s) => n + s.quantity, 0));
            } catch { /* inventory may not exist */ }
          }
        }
      } catch { /* non-critical */ }

      setLoading(false);
    })();
  }, [router]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await apiPatch("/api/me/profile", {
        display_name: displayName.trim() || null,
        bio: bio.trim() || null,
        social_links: social,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't save profile");
    } finally {
      setSaving(false);
    }
  };

  const updateSocial = (key: keyof SocialLinks, value: string) => {
    setSocial((prev) => ({ ...prev, [key]: value || undefined }));
  };

  if (loading) {
    return (
      <main className="flex h-dvh items-center justify-center bg-[#0c1626]">
        <p className="font-mono text-sm uppercase tracking-wider text-[#dcecf4]">
          Loading profile…
        </p>
      </main>
    );
  }

  return (
    <main
      className="min-h-dvh bg-[#0c1626] text-[#fffaf0]"
      style={{
        backgroundImage: `linear-gradient(rgba(12,22,38,0.82), rgba(12,22,38,0.92)), url(${MAP_BG})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <BrandChip />
      <div id="understanding" className="mx-auto max-w-6xl px-6 pt-20"><TwinMemory /></div>
      <div id="gmail-context" className="mx-auto max-w-3xl px-6"><GmailContext /></div>

      {/* Back button */}
      <div className="fixed top-3 right-3 z-30">
        <Link
          href="/world"
          className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-1.5 font-mono text-[10px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]"
        >
          ← Your World
        </Link>
      </div>

      <div className="mx-auto max-w-lg px-4 pt-20 pb-12">
       <div className="rounded border-[3px] border-[#1f2a3c] bg-[rgba(12,22,38,0.75)] p-5 shadow-[4px_4px_0_rgba(0,0,0,0.25)] backdrop-blur-sm">
        {/* Header */}
        <div className="mb-6 flex items-center gap-4">
          {/* Photo */}
          <div className="shrink-0">
            {photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photoUrl}
                alt="Profile photo"
                className="h-20 w-20 border-[3px] border-[#1f2a3c] object-cover shadow-[3px_3px_0_#1f2a3c]"
              />
            ) : (
              <div className="flex h-20 w-20 items-center justify-center border-[3px] border-[#1f2a3c] bg-[#1f2a3c] font-mono text-2xl font-bold text-[#fffaf0] shadow-[3px_3px_0_rgba(255,250,240,0.1)]">
                {displayName.charAt(0).toUpperCase() || "?"}
              </div>
            )}
          </div>
          <div>
            <h1 className="font-mono text-xl font-bold uppercase tracking-wider">
              Profile
            </h1>
            <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
              Edit your details
            </p>
            <Link
              href="/onboarding/photo"
              className="mt-1 inline-block font-mono text-[10px] uppercase tracking-wider text-[#8ab4d6] underline"
            >
              Change photo
            </Link>
          </div>
        </div>

        {/* Form */}
        <div className="space-y-4">
          {/* Display Name */}
          <div>
            <label className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#7f8b98]">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={40}
              className="w-full border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 font-mono text-sm text-[#1f2a3c] shadow-[3px_3px_0_rgba(255,250,240,0.08)] outline-none placeholder:text-[#7f8b98]"
              placeholder="Your name"
            />
          </div>

          {/* Bio */}
          <div>
            <label className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#7f8b98]">
              Bio
            </label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full resize-none border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 font-mono text-sm text-[#1f2a3c] shadow-[3px_3px_0_rgba(255,250,240,0.08)] outline-none placeholder:text-[#7f8b98]"
              placeholder="A bit about yourself…"
            />
          </div>

          {/* Social Links */}
          <div>
            <label className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#7f8b98]">
              Social Links
            </label>
            <div className="space-y-2">
              {([
                ["github", "GitHub", "https://github.com/…"],
                ["linkedin", "LinkedIn", "https://linkedin.com/in/…"],
                ["twitter", "X / Twitter", "https://x.com/…"],
                ["instagram", "Instagram", "https://instagram.com/…"],
              ] as const).map(([key, label, placeholder]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-right font-mono text-[10px] font-bold uppercase tracking-wider text-[#7f8b98]">
                    {label}
                  </span>
                  <input
                    type="url"
                    value={social[key] ?? ""}
                    onChange={(e) => updateSocial(key, e.target.value)}
                    className="min-w-0 flex-1 border-[2px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-1.5 font-mono text-[12px] text-[#1f2a3c] outline-none placeholder:text-[#b0a99a]"
                    placeholder={placeholder}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Inventory summary */}
          {pebbles !== null && (
            <div className="border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.06)] p-3">
              <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#7f8b98]">
                Inventory
              </p>
              <div className="flex gap-4 font-mono text-sm">
                <span>
                  <span className="text-[#ffe17d]">{pebbles}</span>{" "}
                  <span className="text-[10px] uppercase text-[#7f8b98]">pebbles</span>
                </span>
                <span>
                  <span className="text-[#dcecf4]">{itemCount ?? 0}</span>{" "}
                  <span className="text-[10px] uppercase text-[#7f8b98]">items</span>
                </span>
              </div>
            </div>
          )}

          {/* Error / success */}
          {error && (
            <div className="border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#6d2d24]">
              {error}
            </div>
          )}
          {saved && (
            <div className="border-[3px] border-[#1f2a3c] bg-[#d6f4d6] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#2d6a3f]">
              Saved!
            </div>
          )}

          {/* Save */}
          <button
            type="button"
            onClick={save}
            disabled={saving || !displayName.trim()}
            className="w-full border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-[#1f2a3c] shadow-[3px_3px_0_rgba(255,250,240,0.1)] disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save Profile"}
          </button>
        </div>
       </div>
      </div>
    </main>
  );
}
