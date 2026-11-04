"use client";

// Slide-in profile panel for an agent. Pulls /api/agents/{id}/profile
// (RLS gated by the backend — own or accepted-friend's agent). Brutalist
// styling matching PublicProfilePage from Ai-Engine: yellow archetype
// pill, sprite hero on a sky-to-cream gradient plinth, persona excerpt,
// quick stats (your messages so far, when you first chatted).
//
// Triggered from ChatDrawer's "View profile" button. ESC + backdrop tap
// to close. Stays mounted independent of ChatDrawer so the user can
// keep chatting after dismissing the panel.

import { useEffect, useState } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { apiUrl } from "@/lib/backend";
import { photoForAgent } from "@/lib/profile-photos";
import MarkdownPreview from "@/components/MarkdownPreview";
import SpriteFrame from "@/components/SpriteFrame";

type Profile = {
  id: string;
  world_id: string;
  owner_user_id: string;
  owner_display_name: string;
  canonical_id: string | null;
  display_name: string;
  subtitle: string | null;
  persona_md: string;
  sprite_url: string | null;
  portrait_url: string | null;
  photo_url: string | null;
  tile_x: number;
  tile_y: number;
  is_own: boolean;
  is_friend: boolean;
  created_at: string;
  stats: {
    your_msgs: number;
    agent_msgs: number;
    first_chat_at: string | null;
    last_chat_at: string | null;
  };
};

/** Parse markdown text into sections split on ## headings.
 *  Returns [{title, body}] — first entry has title="" for any preamble
 *  text before the first heading. */
function parseSections(md: string): { title: string; body: string }[] {
  // Strip frontmatter.
  let text = md;
  while (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end === -1) break;
    text = text.slice(end + 4).replace(/^\n+/, "");
  }
  const sections: { title: string; body: string }[] = [];
  const parts = text.split(/^##\s+/m);
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i].trim();
    if (!raw) continue;
    if (i === 0) {
      // Preamble before first ##
      sections.push({ title: "", body: raw });
    } else {
      const nl = raw.indexOf("\n");
      const title = nl === -1 ? raw : raw.slice(0, nl).trim();
      const body = nl === -1 ? "" : raw.slice(nl + 1).trim();
      sections.push({ title, body });
    }
  }
  return sections;
}

/** Brutalist section card — mirrors UMhack SectionCard pattern. */
function ProfileSectionCard({
  eyebrow,
  title,
  children,
  className = "",
}: {
  eyebrow?: string;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[3px_3px_0_#1f2a3c] ${className}`}
    >
      <div className="border-b-[2px] border-[#e8e4d9] px-3 py-2">
        {eyebrow && (
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#637387]">
            {eyebrow}
          </p>
        )}
        <h3 className="mt-0.5 text-[15px] font-bold leading-tight text-[#1f2a3c]">
          {title}
        </h3>
      </div>
      <div className="px-3 py-3">{children}</div>
    </div>
  );
}

type Props = {
  agentId: string;
  fallbackSpriteUrl: string;
  onClose: () => void;
  /** When provided, renders a "Chat with {name}" CTA that the parent
   *  wires up to open ChatDrawer for the same agent. Only shown for
   *  own or accepted-friend's agents (the redacted view skips it). */
  onChat?: () => void;
};

export default function AgentProfilePanel({
  agentId,
  fallbackSpriteUrl,
  onClose,
  onChat,
}: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hubMd, setHubMd] = useState<string | null>(null);
  const [hubLoading, setHubLoading] = useState(false);
  const [showReferrer, setShowReferrer] = useState(false);
  const [pebbles, setPebbles] = useState<number | null>(null);

  useEffect(() => {
    setShowReferrer(false);
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<Profile>(
          `/api/agents/${encodeURIComponent(agentId)}/profile`,
        );
        if (cancelled) return;
        setProfile(data);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Fetch pebble balance
  useEffect(() => {
    let cancelled = false;
    apiGet<{ pebbles: number }>(`/api/agents/${encodeURIComponent(agentId)}/inventory`)
      .then((data) => { if (!cancelled) setPebbles(data.pebbles); })
      .catch(() => { /* non-critical — wallet may not exist yet */ });
    return () => { cancelled = true; };
  }, [agentId]);

  // Once we have a canonical agent's profile, fetch its hub markdown
  // (e.g. backend/data/wikis/support/Joon.md) so we can render the
  // same rich view the /world graph overlay shows on hub click —
  // sections for Topics / Key relationships / Projects / Recurring
  // tensions, with [[wikilink]] tags styled as cream chips.
  useEffect(() => {
    if (!profile?.canonical_id) {
      setHubMd(null);
      return;
    }
    let cancelled = false;
    setHubLoading(true);
    setHubMd(null);
    fetch(
      apiUrl(
        `/api/wiki_page?id=${encodeURIComponent(
          `${profile.canonical_id}/${profile.display_name}`,
        )}`,
      ),
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { exists?: boolean; markdown?: string }) => {
        if (cancelled) return;
        setHubMd(d.exists && d.markdown ? d.markdown : null);
      })
      .catch(() => {
        if (cancelled) return;
        setHubMd(null);
      })
      .finally(() => {
        if (!cancelled) setHubLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profile?.canonical_id, profile?.display_name]);

  // ESC closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close profile"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-[rgba(12,22,38,0.55)] backdrop-blur-sm"
      />
      {/* Slide-in panel */}
      <aside
        role="dialog"
        aria-label="Agent profile"
        className="fixed inset-0 z-50 flex w-full flex-col overflow-hidden border-[#1f2a3c] bg-[rgba(246,244,234,0.99)] text-[#1f2a3c] sm:inset-y-4 sm:right-4 sm:left-auto sm:w-[min(440px,calc(100vw-1.5rem))] sm:border-[3px] sm:shadow-[6px_6px_0_#1f2a3c]"
      >
        {/* Header */}
        <header className="flex items-center justify-between border-b-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-3">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#637387]">
            Agent profile
          </p>
          <button
            type="button"
            onClick={onClose}
            className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
          >
            Close
          </button>
        </header>

        {error && (
          <div className="m-3 border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24] shadow-[3px_3px_0_#1f2a3c]">
            {error}
          </div>
        )}

        {!profile && !error && (
          <div className="flex flex-1 items-center justify-center p-8 font-mono text-[11px] uppercase tracking-wider text-[#7f8b98]">
            Loading…
          </div>
        )}

        {profile && !profile.is_friend && !profile.is_own && (
          <RedactedProfile profile={profile} fallbackSpriteUrl={fallbackSpriteUrl} />
        )}

        {profile && (profile.is_friend || profile.is_own) && (
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {/* Tags row */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]">
                {profile.canonical_id ?? "custom"}
              </span>
              {profile.is_own ? (
                <span className="border-[3px] border-[#1f2a3c] bg-[#e7f8ef] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]">
                  Your agent
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowReferrer((s) => !s)}
                  className="border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c] transition-colors hover:bg-[#d6e4f5]"
                >
                  {showReferrer
                    ? `Referred by ${profile.owner_display_name}`
                    : "Referred by \u2026"}
                </button>
              )}
              {pebbles !== null && (
                <span className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]">
                  ◉ {pebbles} pebbles
                </span>
              )}
            </div>

            {/* Hero: portrait photo (when available) + sprite badge + headline.
                Photo is the a social virtual world-style portrait; sprite is the
                pixelated abstraction painted on top — small inset bottom-right
                so the user sees both representations. */}
            {(() => {
              const portrait = profile.photo_url || photoForAgent(profile.canonical_id);
              return (
                <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-3 shadow-[4px_4px_0_#1f2a3c]">
                  <div className="grid grid-cols-[140px_1fr] gap-3">
                    <div className="relative h-[160px] w-full overflow-hidden border-[3px] border-[#1f2a3c] bg-[linear-gradient(180deg,#b6cadf_0%,#dcecf4_55%,#fffaf0_55%,#fffaf0_100%)] shadow-[3px_3px_0_#1f2a3c]">
                      {portrait ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={portrait}
                          alt={`${profile.display_name} portrait`}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : profile.portrait_url ? (
                        <div className="absolute inset-0 flex items-end justify-center pb-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={profile.portrait_url}
                            alt={`${profile.display_name} pixel portrait`}
                            className="max-h-full max-w-full object-contain"
                            style={{ imageRendering: "pixelated" }}
                          />
                        </div>
                      ) : (
                        <div className="absolute inset-0 flex items-end justify-center pb-2">
                          <SpriteFrame
                            src={profile.sprite_url || fallbackSpriteUrl}
                            size={4}
                            title={`${profile.display_name} sprite`}
                          />
                        </div>
                      )}
                      {portrait && (
                        // Sprite inset over the photo for the both-views feel.
                        <div className="absolute bottom-1 right-1 z-10 border-[2px] border-[#1f2a3c] bg-[#fffaf0] p-0.5 shadow-[2px_2px_0_#1f2a3c]">
                          <SpriteFrame
                            src={profile.sprite_url || fallbackSpriteUrl}
                            size={1.25}
                          />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <h1 className="font-mono text-xl font-bold uppercase leading-tight">
                        {profile.display_name}
                      </h1>
                      {profile.subtitle && (
                        <p className="mt-1 text-sm italic leading-snug text-[#4f5c6d]">
                          {profile.subtitle}
                        </p>
                      )}
                      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#7f8b98]">
                        Tile ({profile.tile_x}, {profile.tile_y})
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()}

            {onChat && (
              <button
                type="button"
                onClick={onChat}
                className="mt-3 w-full border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-4 py-3 font-mono text-[12px] font-bold uppercase tracking-[0.16em] text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c] hover:bg-[#ffd84d]"
              >
                Chat with {profile.display_name}
              </button>
            )}

            {/* Stats */}
            {(profile.stats.your_msgs > 0 || profile.stats.agent_msgs > 0) && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Stat
                  label="Your messages"
                  value={String(profile.stats.your_msgs)}
                />
                <Stat
                  label="Agent replies"
                  value={String(profile.stats.agent_msgs)}
                />
                {profile.stats.first_chat_at && (
                  <Stat
                    label="First chat"
                    value={relTime(profile.stats.first_chat_at)}
                  />
                )}
                {profile.stats.last_chat_at && (
                  <Stat
                    label="Last chat"
                    value={relTime(profile.stats.last_chat_at)}
                  />
                )}
              </div>
            )}

            {/* Profile sections — split by ## headings into separate cards */}
            {hubLoading ? (
              <div className="mt-3 border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-3 shadow-[3px_3px_0_#1f2a3c]">
                <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
                  Loading wiki page…
                </p>
              </div>
            ) : (
              <ProfileSections md={hubMd || profile.persona_md} />
            )}
          </div>
        )}
      </aside>
    </>
  );
}

/** Extract a short public description (first ~3 lines of the preamble
 *  before any ## heading) from the persona markdown. */
function publicDescription(md: string): string {
  let text = md;
  // Strip frontmatter.
  while (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end === -1) break;
    text = text.slice(end + 4).replace(/^\n+/, "");
  }
  // Take everything before the first ## heading.
  const headingIdx = text.search(/^##\s/m);
  const preamble = (headingIdx === -1 ? text : text.slice(0, headingIdx)).trim();
  // Cap at ~3 lines worth of text.
  const lines = preamble.split(/\n/).filter((l) => l.trim());
  return lines.slice(0, 3).join("\n");
}

/** Public profile for agents whose owner you're not connected with.
 *  Shows portrait/sprite, name, subtitle, connect CTA, and a short
 *  3-line public description. No detailed sections or stats. */
function RedactedProfile({
  profile,
  fallbackSpriteUrl,
}: {
  profile: Profile;
  fallbackSpriteUrl: string;
}) {
  const [requested, setRequested] = useState(false);

  const requestIntro = async () => {
    try {
      await apiPost("/api/friends/request", {
        target_user_id: profile.owner_user_id,
      });
      setRequested(true);
    } catch {
      setRequested(true);
    }
  };

  const visitOwner = () => {
    window.location.href = `/world/${encodeURIComponent(profile.owner_display_name || "")}`;
  };

  const portrait = profile.photo_url || photoForAgent(profile.canonical_id);
  const pubDesc = publicDescription(profile.persona_md);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {/* Tags row */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]">
          {profile.canonical_id ?? "custom"}
        </span>
        <span className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#7f8b98] shadow-[2px_2px_0_#1f2a3c]">
          Not connected
        </span>
      </div>

      {/* Hero — portrait/sprite visible, name + subtitle visible */}
      <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-3 shadow-[4px_4px_0_#1f2a3c]">
        <div className="grid grid-cols-[140px_1fr] gap-3">
          <div className="relative h-[160px] w-full overflow-hidden border-[3px] border-[#1f2a3c] bg-[linear-gradient(180deg,#b6cadf_0%,#dcecf4_55%,#fffaf0_55%,#fffaf0_100%)] shadow-[3px_3px_0_#1f2a3c]">
            {portrait ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={portrait}
                alt={`${profile.display_name} portrait`}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : profile.portrait_url ? (
              <div className="absolute inset-0 flex items-end justify-center pb-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={profile.portrait_url}
                  alt={`${profile.display_name} pixel portrait`}
                  className="max-h-full max-w-full object-contain"
                  style={{ imageRendering: "pixelated" }}
                />
              </div>
            ) : (
              <div className="absolute inset-0 flex items-end justify-center pb-2">
                <SpriteFrame
                  src={profile.sprite_url || fallbackSpriteUrl}
                  size={4}
                  title={`${profile.display_name} sprite`}
                />
              </div>
            )}
            {portrait && (
              <div className="absolute bottom-1 right-1 z-10 border-[2px] border-[#1f2a3c] bg-[#fffaf0] p-0.5 shadow-[2px_2px_0_#1f2a3c]">
                <SpriteFrame
                  src={profile.sprite_url || fallbackSpriteUrl}
                  size={1.25}
                />
              </div>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="font-mono text-xl font-bold uppercase leading-tight">
              {profile.display_name}
            </h1>
            {profile.subtitle && (
              <p className="mt-1 text-sm italic leading-snug text-[#4f5c6d]">
                {profile.subtitle}
              </p>
            )}
            <p className="mt-2 text-[13px] leading-snug text-[#425166]">
              Invited by{" "}
              <button
                type="button"
                onClick={visitOwner}
                className="font-bold text-[#1f2a3c] underline decoration-[#7aa7d9] underline-offset-2 hover:text-[#7aa7d9]"
              >
                {profile.owner_display_name}
              </button>
            </p>
          </div>
        </div>
      </div>

      {/* Connect CTA — right below the profile picture */}
      <div className="mt-3 border-[3px] border-[#1f2a3c] bg-[#e8f1ff] p-4 shadow-[3px_3px_0_#1f2a3c]">
        {requested ? (
          <>
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c]">
              Request sent
            </p>
            <p className="mt-2 text-sm leading-snug text-[#425166]">
              We&apos;ll notify {profile.owner_display_name}. Once they accept,
              you&apos;ll have full access to their agents.
            </p>
          </>
        ) : (
          <>
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c]">
              Want to connect?
            </p>
            <p className="mt-2 text-sm leading-snug text-[#425166]">
              Connect with{" "}
              <button
                type="button"
                onClick={visitOwner}
                className="font-bold text-[#1f2a3c] underline decoration-[#7aa7d9] underline-offset-2 hover:text-[#7aa7d9]"
              >
                {profile.owner_display_name}
              </button>
              {" "}to view full profiles and chat with their agents.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={requestIntro}
                className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-3 font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] hover:bg-[#ffd84d]"
              >
                Ask for intro
              </button>
              <button
                type="button"
                onClick={requestIntro}
                className="border-[3px] border-[#1f2a3c] bg-[#d6f4d6] px-3 py-3 font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] hover:bg-[#b8eab8]"
              >
                Send request
              </button>
            </div>
          </>
        )}
      </div>

      {/* Public description — 3-line excerpt visible to everyone */}
      {pubDesc && (
        <div className="mt-3 border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-3 shadow-[3px_3px_0_#1f2a3c]">
          <p className="mb-2 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#637387]">
            About
          </p>
          <p className="whitespace-pre-line text-sm leading-snug text-[#1f2a3c] line-clamp-3">
            {pubDesc}
          </p>
        </div>
      )}
    </div>
  );
}

/** Render persona markdown split into separate section cards. */
function ProfileSections({ md }: { md: string }) {
  if (!md) {
    return (
      <div className="mt-3 border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-3 shadow-[3px_3px_0_#1f2a3c]">
        <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
          No persona yet.
        </p>
      </div>
    );
  }
  const sections = parseSections(md);
  return (
    <div className="mt-3 space-y-3">
      {sections.map((s, i) => {
        if (!s.title && !s.body) return null;
        const sectionMd = s.title
          ? `## ${s.title}\n${s.body}`
          : s.body;
        return s.title ? (
          <ProfileSectionCard key={i} eyebrow="Profile" title={s.title}>
            <MarkdownPreview text={s.body} />
          </ProfileSectionCard>
        ) : (
          <ProfileSectionCard key={i} eyebrow="Overview" title="Profile">
            <MarkdownPreview text={sectionMd} />
          </ProfileSectionCard>
        );
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 shadow-[2px_2px_0_#1f2a3c]">
      <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#637387]">
        {label}
      </p>
      <p className="mt-1 font-bold leading-tight">{value}</p>
    </div>
  );
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const sec = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
}
