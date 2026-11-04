"use client";

// A single shared World (group) — same Phaser-canvas vibe as /worlds
// (the public gallery), but the agent set is restricted to the
// accepted members of this group. URL: /worlds/[slug] so it's
// shareable and browser-history-friendly.
//
// Visiting a group you're a member of: full agent canvas + Society
// scoped to this group + Worlds drawer for navigation.
// Visiting a group you're NOT in: same canvas (read-only),
// plus a prominent "Join World" banner — basis for the upcoming
// invite-link flow.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { fetchSession } from "@/lib/authClient";
import AgentProfilePanel from "@/components/AgentProfilePanel";
import BrandChip from "@/components/BrandChip";
import GameControls from "@/components/GameControls";
import RPGDialog from "@/components/RPGDialog";
import SocietyFeed from "@/components/SocietyFeed";
import MatchesPanel from "@/components/MatchesPanel";
import WorldGroupsDrawer from "@/components/WorldGroupsDrawer";
import WorldRoomChat from "@/components/WorldRoomChat";
import WorldZoomControls from "@/components/WorldZoomControls";
import type { WorldAgent } from "@/components/PhaserHost";

const PhaserHost = dynamic(() => import("@/components/PhaserHost"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-[#0c1626] font-mono text-[11px] uppercase tracking-wider text-[#fffaf0]">
      Loading World…
    </div>
  ),
});

type NetworkAgent = {
  agent_id: string;
  display_name: string;
  subtitle: string | null;
  canonical_id: string | null;
  sprite_url: string | null;
  portrait_url: string | null;
  owner_user_id: string;
  owner_display_name: string;
  world_id: string;
  is_own: boolean;
};

type AgentsResponse = { agents: NetworkAgent[] };

type GroupSummary = {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  visibility: "invite_only" | "public";
  created_by: string;
  created_at: string;
  member_count: number;
};

type Member = {
  user_id: string;
  status: "pending" | "accepted" | "left";
  display_name: string | null;
  photo_url: string | null;
  joined_at: string | null;
  invited_at: string | null;
};

type DetailResponse = { group: GroupSummary; members: Member[] };

type MeResponse = {
  profile: { id: string | null; display_name: string | null } | null;
  home_world: { id: string } | null;
};

const PLACEHOLDER_SPRITES = [
  "/team-office/characters/char_0.png",
  "/team-office/characters/char_1.png",
  "/team-office/characters/char_2.png",
  "/team-office/characters/char_3.png",
  "/team-office/characters/char_4.png",
  "/team-office/characters/char_5.png",
];

function pickPlaceholder(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return PLACEHOLDER_SPRITES[Math.abs(hash) % PLACEHOLDER_SPRITES.length];
}

function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const GRID_W = 32;
const GRID_H = 24;
const OWNER_RING_RADIUS = 4;
const AGENT_SPREAD = 6;

function clampGrid(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Same placement as /worlds — clusters per owner so each member's
// agents form a loose neighbourhood around a shared centre.
function placeAgents(agents: NetworkAgent[]): WorldAgent[] {
  const byOwner = new Map<string, NetworkAgent[]>();
  for (const a of agents) {
    const arr = byOwner.get(a.owner_user_id);
    if (arr) arr.push(a);
    else byOwner.set(a.owner_user_id, [a]);
  }
  const owners = Array.from(byOwner.keys());
  const cxMap = GRID_W / 2;
  const cyMap = GRID_H / 2;
  const ownerCenter = (i: number): { cx: number; cy: number } => {
    if (owners.length === 1) return { cx: cxMap, cy: cyMap };
    const theta = (i / owners.length) * Math.PI * 2;
    return {
      cx: Math.round(cxMap + Math.cos(theta) * OWNER_RING_RADIUS),
      cy: Math.round(cyMap + Math.sin(theta) * OWNER_RING_RADIUS),
    };
  };
  const used = new Set<string>();
  const out: WorldAgent[] = [];
  for (let oi = 0; oi < owners.length; oi++) {
    const { cx, cy } = ownerCenter(oi);
    const group = byOwner.get(owners[oi])!;
    for (const a of group) {
      const h = hash32(a.agent_id);
      const span = AGENT_SPREAD * 2 + 1;
      let x = clampGrid(cx + ((h % span) - AGENT_SPREAD), 1, GRID_W - 2);
      let y = clampGrid(cy + (((h >>> 8) % span) - AGENT_SPREAD), 1, GRID_H - 2);
      let attempts = 0;
      while (used.has(`${x},${y}`) && attempts < 200) {
        attempts++;
        const offX = ((h + attempts * 7) % span) - AGENT_SPREAD;
        const offY = (((h >>> 8) + attempts * 11) % span) - AGENT_SPREAD;
        x = clampGrid(cx + offX, 1, GRID_W - 2);
        y = clampGrid(cy + offY, 1, GRID_H - 2);
      }
      let ring = 1;
      while (used.has(`${x},${y}`) && ring < 100) {
        x = clampGrid(
          cx + Math.round(Math.cos(ring) * (AGENT_SPREAD + ring)),
          1,
          GRID_W - 2,
        );
        y = clampGrid(
          cy + Math.round(Math.sin(ring) * (AGENT_SPREAD + ring)),
          1,
          GRID_H - 2,
        );
        ring++;
      }
      used.add(`${x},${y}`);
      out.push({
        id: a.agent_id,
        display_name: a.display_name,
        canonical_id: a.canonical_id,
        sprite_url: a.sprite_url,
        portrait_url: a.portrait_url ?? null,
        sprite_sheet_url: null,
        tile_x: x,
        tile_y: y,
        placeholder_sprite_url: pickPlaceholder(a.agent_id),
      });
    }
  }
  return out;
}

export default function WorldGroupPage() {
  const params = useParams();
  const router = useRouter();
  const slug = String(params?.slug ?? "");

  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [agents, setAgents] = useState<NetworkAgent[] | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileAgentId, setProfileAgentId] = useState<string | null>(null);
  const [chatAgentId, setChatAgentId] = useState<string | null>(null);
  const [societyOpen, setSocietyOpen] = useState(false);
  const [matchesOpen, setMatchesOpen] = useState(false);
  const [matchesAgentId, setMatchesAgentId] = useState<string | null>(null);
  const [roomOpen, setRoomOpen] = useState(false);
  const [worldsOpen, setWorldsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Unread badge for the closed Chat Room — incremented when a new
  // message lands while the panel is shut, cleared when it opens.
  const [roomUnread, setRoomUnread] = useState(false);
  const isMobile = useIsMobile();
  const [joining, setJoining] = useState(false);
  const [playerSprite, setPlayerSprite] = useState<{ url: string; type: "portrait" | "sheet" } | null>(null);
  // Tracks whether we've finished the auth-gate check. Until true,
  // we don't fetch data — keeps the invite-link flow clean: anonymous
  // visitors get bounced to /login?next=/worlds/[slug] and come back
  // here once authed.
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (!authReady || new URLSearchParams(window.location.search).get("matches") !== "mine") return;
    let active = true;
    apiGet<{ agent_id: string | null }>("/api/ingest/claude-code").then((state) => {
      if (active && state.agent_id) {
        setMatchesAgentId(state.agent_id);
        setMatchesOpen(true);
      }
    }).catch(() => { if (active) setError("Could not load your matches. Use Matches to try again."); });
    return () => { active = false; };
  }, [authReady, slug]);

  // Discord-style invite-link gate. If logged out, redirect to login
  // and come back. If logged in but not yet through onboarding (no
  // display_name), send to /onboarding/name first — the trigger on
  // profiles will auto-add them to Pixel Globe membership, but for
  // any *other* group we land back here and offer Join.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const auth = await fetchSession();
      if (cancelled) return;
      if (!auth) {
        const next = `/worlds/${encodeURIComponent(slug)}${window.location.search}`;
        router.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      setAuthReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, slug]);

  const refetch = useCallback(async () => {
    setError(null);
    try {
      const [d, a] = await Promise.all([
        apiGet<DetailResponse>(
          `/api/world-groups/by-slug/${encodeURIComponent(slug)}`,
        ),
        apiGet<AgentsResponse>(
          `/api/world-groups/by-slug/${encodeURIComponent(slug)}/agents`,
        ),
      ]);
      setDetail(d);
      setAgents(a.agents);
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      );
    }
  }, [slug]);

  useEffect(() => {
    if (!authReady) return;
    refetch();
    apiGet<MeResponse>("/api/me")
      .then((meRes) => {
        setMe(meRes);
        if (meRes.home_world?.id) {
          apiGet<{ agents: Array<{ canonical_id: string | null; sprite_url: string | null; portrait_url: string | null }> }>(
            `/api/worlds/${meRes.home_world.id}/agents`,
          ).then(({ agents: myAgents }) => {
            const self = myAgents.find((a: { canonical_id: string | null }) => a.canonical_id === null) as { sprite_sheet_url?: string | null } | undefined;
            if (self?.sprite_sheet_url) setPlayerSprite({ url: self.sprite_sheet_url, type: "sheet" });
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }, [refetch, authReady]);

  useEffect(() => {
    // Click → profile panel.
    const onTap = (e: Event) => {
      const d = (e as CustomEvent).detail as { agent_id?: string };
      if (d?.agent_id) setProfileAgentId(d.agent_id);
    };
    // Z key → RPG chat dialog.
    const onChat = (e: Event) => {
      const d = (e as CustomEvent).detail as { agent_id?: string };
      if (d?.agent_id) setChatAgentId(d.agent_id);
    };
    const onBPress = () => { setChatAgentId(null); setProfileAgentId(null); };
    window.addEventListener("phaser:agent-tap", onTap);
    window.addEventListener("phaser:agent-chat", onChat);
    window.addEventListener("phaser:b-press", onBPress);
    return () => {
      window.removeEventListener("phaser:agent-tap", onTap);
      window.removeEventListener("phaser:agent-chat", onChat);
      window.removeEventListener("phaser:b-press", onBPress);
    };
  }, []);

  // Speech bubbles in the canvas — subscribe to room INSERTs and
  // dispatch the existing `phaser:agent-bubble` event that WorldScene
  // already listens for (5s TTL, max 5 on-screen, oldest evicted).
  // Independent of the room-chat panel so bubbles show even when the
  // panel is closed.
  useEffect(() => {
    if (!detail?.group.id) return;
    const gid = detail.group.id;
    let cancelled = false;
    let lastSeq = 0;
    let seeded = false;
    const poll = async () => {
      try {
        const res = await apiGet<{
          messages: { agent_id: string | null; body: string; seq: number }[];
        }>(`/api/world-groups/${gid}/room?limit=30`);
        const msgs = res.messages ?? [];
        const maxSeq = msgs.reduce((mx, x) => Math.max(mx, x.seq), lastSeq);
        if (!seeded) {
          // First poll seeds the baseline — don't replay history as bubbles.
          lastSeq = maxSeq;
          seeded = true;
          return;
        }
        for (const m of msgs) {
          if (m.seq > lastSeq && m.agent_id && m.body) {
            window.dispatchEvent(
              new CustomEvent("phaser:agent-bubble", {
                detail: { agent_id: m.agent_id, text: m.body },
              }),
            );
          }
        }
        lastSeq = maxSeq;
      } catch {
        /* ignore transient poll errors */
      }
    };
    void poll();
    const iv = setInterval(() => {
      if (!cancelled) void poll();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [detail?.group.id]);

  const phaserAgents = useMemo(
    () => (agents ? placeAgents(agents) : []),
    [agents],
  );

  const profileAgent = profileAgentId
    ? agents?.find((a) => a.agent_id === profileAgentId) ?? null
    : null;
  const chatAgent = chatAgentId
    ? agents?.find((a) => a.agent_id === chatAgentId) ?? null
    : null;

  const agentsById = useMemo(() => {
    const m = new Map<string, { id: string; display_name: string }>();
    for (const a of agents ?? []) {
      m.set(a.agent_id, { id: a.agent_id, display_name: a.display_name });
    }
    return m;
  }, [agents]);

  const meMembership = useMemo(() => {
    if (!detail || !me?.profile?.id) return null;
    return detail.members.find((m) => m.user_id === me.profile?.id) ?? null;
  }, [detail, me]);
  const isMember = meMembership?.status === "accepted";

  const handleJoin = useCallback(async () => {
    if (!detail) return;
    setJoining(true);
    try {
      await apiPost(
        `/api/world-groups/${encodeURIComponent(detail.group.id)}/join`,
        {},
      );
      await refetch();
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      );
    } finally {
      setJoining(false);
    }
  }, [detail, refetch]);

  // Discord-style auto-join for public worlds. When someone follows
  // an invite link to a PUBLIC world and they're authed but not yet
  // a member, silently add them — no extra click. Invite-only stays
  // explicit (the Visiting banner with "Request to join").
  useEffect(() => {
    if (!detail || !me?.profile?.id || joining) return;
    if (meMembership) return; // already pending or accepted
    if (detail.group.visibility !== "public") return;
    handleJoin();
  }, [detail, me, meMembership, joining, handleJoin]);

  // Unread Chat Room badge — subscribe at the page level so we know
  // about new messages while the panel is shut. When it opens, the
  // panel takes over its own subscription (in WorldRoomChat).
  useEffect(() => {
    const groupId = detail?.group.id;
    const myUserId = me?.profile?.id;
    if (!groupId) return;
    if (roomOpen) {
      setRoomUnread(false);
      return;
    }
    let cancelled = false;
    let lastSeq = 0;
    let seeded = false;
    const poll = async () => {
      try {
        const res = await apiGet<{
          messages: { user_id: string | null; seq: number }[];
        }>(`/api/world-groups/${groupId}/room?limit=10`);
        const msgs = res.messages ?? [];
        const maxSeq = msgs.reduce((mx, x) => Math.max(mx, x.seq), lastSeq);
        if (!seeded) {
          lastSeq = maxSeq;
          seeded = true;
          return;
        }
        const fresh = msgs.filter((m) => m.seq > lastSeq && m.user_id !== myUserId);
        if (fresh.length > 0) setRoomUnread(true);
        lastSeq = maxSeq;
      } catch {
        /* ignore */
      }
    };
    void poll();
    const iv = setInterval(() => {
      if (!cancelled) void poll();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [detail?.group.id, me?.profile?.id, roomOpen]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0c1626] p-6 text-[#fffaf0]">
        <div className="max-w-sm border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-3 font-mono text-[12px] uppercase tracking-wider text-[#6d2d24] shadow-[3px_3px_0_#1f2a3c]">
          {error}
          <div className="mt-3">
            <Link
              href="/worlds"
              className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-1.5 font-mono text-[10px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]"
            >
              ← Public
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!detail || !agents) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0c1626] font-mono text-[12px] uppercase tracking-wider text-[#fffaf0]">
        Loading World…
      </div>
    );
  }

  const accepted = detail.members.filter((m) => m.status === "accepted");

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0c1626] text-[#fffaf0]">
      <PhaserHost agents={phaserAgents} mode="visit" playerName={me?.profile?.display_name ?? "You"} />

      <BrandChip
        compact={isMobile}
        subtitle={`${detail.group.name} · ${accepted.length} ${accepted.length === 1 ? "member" : "members"} · ${agents.length} agents`}
      />
      {!isMobile && <WorldZoomControls />}

      {/* Top HUD — desktop: full strip; mobile: compact Home + Menu. */}
      <div className="pointer-events-auto fixed top-3 right-3 z-20 sm:top-4 sm:right-4">
        {isMobile ? (
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <Link
                href="/world"
                className="flex h-8 items-center border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 font-mono text-[10px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]"
              >
                ← Home
              </Link>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                className="flex h-8 items-center border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 font-mono text-[10px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]"
              >
                Menu
              </button>
            </div>
            {isMember && (
              <button
                type="button"
                onClick={() => setRoomOpen((s) => !s)}
                aria-pressed={roomOpen}
                className={
                  "relative flex h-8 items-center border-[3px] border-[#1f2a3c] px-3 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                  (roomOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#f6f4ea] text-[#1f2a3c]")
                }
              >
                Chat Room
                {roomUnread && !roomOpen && (
                  <span
                    aria-label="New messages"
                    className="absolute -right-1.5 -top-1.5 h-3 w-3 rounded-full border-[2px] border-[#1f2a3c] bg-[#d94545]"
                  />
                )}
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/world"
              className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]"
            >
              ← Home
            </Link>
            <div className="border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]">
              {detail.group.name} · {accepted.length}{" "}
              {accepted.length === 1 ? "member" : "members"} · {agents.length} agents
            </div>
            <button
              type="button"
              onClick={() => setRoomOpen((s) => !s)}
              className={
                "relative border-[3px] border-[#1f2a3c] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (roomOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#dcecf4] text-[#1f2a3c]")
              }
            >
              Chat Room
              {roomUnread && !roomOpen && (
                <span
                  aria-label="New messages"
                  className="absolute -right-1.5 -top-1.5 h-3 w-3 rounded-full border-[2px] border-[#1f2a3c] bg-[#d94545]"
                />
              )}
            </button>
            <button
              type="button"
              onClick={() => setSocietyOpen((s) => !s)}
              className={
                "border-[3px] border-[#1f2a3c] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (societyOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#e8d6ff] text-[#1f2a3c]")
              }
            >
              DMs
            </button>
            <button
              type="button"
              onClick={() => setMatchesOpen((s) => !s)}
              className={
                "border-[3px] border-[#1f2a3c] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (matchesOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#b8f0c8] text-[#1f2a3c]")
              }
            >
              Explore current matches
            </button>
            <button
              type="button"
              onClick={() => setWorldsOpen((s) => !s)}
              className={
                "border-[3px] border-[#1f2a3c] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (worldsOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#e8d6ff] text-[#1f2a3c]")
              }
            >
              Worlds
            </button>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("phaser:reset-camera"))
              }
              className="border-[3px] border-[#1f2a3c] bg-[#fff3cd] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]"
            >
              Reset view
            </button>
          </div>
        )}
      </div>

      {/* Mobile menu sheet — same pattern as /world. */}
      {isMobile && menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-30 bg-[rgba(12,22,38,0.55)] backdrop-blur-sm"
          />
          <div className="fixed inset-x-3 top-14 z-40 max-h-[calc(100dvh-4.5rem)] overflow-y-auto border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.99)] p-3 text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c]">
            {/* Info pill */}
            <div className="mb-3 border-[2px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#1f2a3c]">
              {detail.group.name} · {accepted.length}{" "}
              {accepted.length === 1 ? "member" : "members"} · {agents.length} agents
            </div>

            {/* Section: Chat */}
            <p className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-[#637387]">Chat</p>
            <div className="mb-3 grid grid-cols-2 gap-2">
              {isMember && (
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); setRoomOpen(true); }}
                  className="border-[2px] border-[#1f2a3c] bg-[#dcecf4] px-3 py-2.5 font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
                >
                  Chat Room
                </button>
              )}
              <button
                type="button"
                onClick={() => { setMenuOpen(false); setSocietyOpen(true); }}
                className="border-[2px] border-[#1f2a3c] bg-[#e8d6ff] px-3 py-2.5 font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                DMs
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); setWorldsOpen(true); }}
                className="col-span-2 border-[2px] border-[#1f2a3c] bg-[#e8d6ff] px-3 py-2.5 text-left font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                Worlds
              </button>
            </div>

            {/* Section: Navigate */}
            <p className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-[#637387]">Navigate</p>
            <div className="grid grid-cols-2 gap-2">
              <Link
                href="/world"
                onClick={() => setMenuOpen(false)}
                className="border-[2px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-2.5 text-center font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                ← My World
              </Link>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  window.dispatchEvent(new CustomEvent("phaser:reset-camera"));
                }}
                className="border-[2px] border-[#1f2a3c] bg-[#fff3cd] px-3 py-2.5 font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                Reset view
              </button>
            </div>
          </div>
        </>
      )}

      {/* "Visiting" banner — only when you're not a member yet */}
      {!isMember && (
        <div className="pointer-events-auto fixed left-1/2 top-3 z-30 -translate-x-1/2 sm:top-4">
          <div className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c]">
            Visiting · {detail.group.visibility === "public" ? "public" : "invite only"}
            {meMembership?.status === "pending" ? (
              <span className="ml-3 text-[#5a3d7a]">Request pending</span>
            ) : (
              <button
                type="button"
                onClick={handleJoin}
                disabled={joining}
                className="ml-3 border-[3px] border-[#1f2a3c] bg-[#d6f4d6] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] disabled:opacity-60"
              >
                {joining
                  ? "…"
                  : detail.group.visibility === "public"
                    ? "Join World"
                    : "Request to join"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Hint pill — desktop only; on mobile it crowds the bottom HUD. */}
      {!isMobile && (
        <div className="pointer-events-none fixed bottom-3 left-3 z-20 sm:bottom-4 sm:left-4">
          <div className="border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.92)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]">
            Tap a sprite to view profile
            {detail.group.description ? ` · ${detail.group.description}` : ""}
          </div>
        </div>
      )}

      {agents.length === 0 && (
        <div className="fixed inset-0 z-10 flex items-center justify-center">
          <div className="border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]">
            No agents in this World yet.
          </div>
        </div>
      )}

      {profileAgent && (
        <AgentProfilePanel
          agentId={profileAgent.agent_id}
          fallbackSpriteUrl={
            profileAgent.sprite_url ?? pickPlaceholder(profileAgent.agent_id)
          }
          onClose={() => setProfileAgentId(null)}
          onChat={() => {
            setChatAgentId(profileAgent.agent_id);
            setProfileAgentId(null);
          }}
        />
      )}

      {chatAgent && (
        <RPGDialog
          agentId={chatAgent.agent_id}
          agentDisplayName={chatAgent.display_name}
          canonicalId={chatAgent.canonical_id}
          agentSpriteUrl={
            chatAgent.sprite_url ?? pickPlaceholder(chatAgent.agent_id)
          }
          agentPortraitUrl={chatAgent.portrait_url}
          onClose={() => setChatAgentId(null)}
        />
      )}

      {isMember && (
        <WorldRoomChat
          open={roomOpen}
          onClose={() => setRoomOpen(false)}
          worldGroupId={detail.group.id}
          worldGroupName={detail.group.name}
          myAgents={(agents ?? [])
            .filter((a) => a.is_own)
            .map((a) => ({ id: a.agent_id, display_name: a.display_name }))}
          agentsById={agentsById}
          myUserId={me?.profile?.id ?? null}
          myDisplayName={me?.profile?.display_name ?? null}
          membersByUserId={
            new Map(
              detail.members
                .filter((m) => m.display_name)
                .map((m) => [m.user_id, m.display_name as string]),
            )
          }
        />
      )}

      <MatchesPanel
        open={matchesOpen}
        onClose={() => setMatchesOpen(false)}
        slug={slug}
        agentId={matchesAgentId}
        onSelectAgent={setMatchesAgentId}
        agents={(agents ?? []).map((a) => ({ id: a.agent_id, name: a.display_name, canonicalId: a.canonical_id }))}
        onOpenProfile={(id) => {
          setMatchesOpen(false);
          setProfileAgentId(id);
        }}
      />

      <SocietyFeed
        open={societyOpen}
        onClose={() => setSocietyOpen(false)}
        ownerUsername={null}
        agentsById={agentsById}
        worldGroupId={detail.group.id}
        worldGroupName={detail.group.name}
      />

      <WorldGroupsDrawer
        open={worldsOpen}
        onClose={() => setWorldsOpen(false)}
      />

      {/* On-screen D-pad + A/B controls — same gating as /world: hide
          when any panel/menu/dialog is open so the chat input + drawer
          buttons aren't blocked by the bottom HUD on mobile. */}
      <GameControls
        hidden={
          roomOpen ||
          societyOpen ||
          worldsOpen ||
          menuOpen ||
          !!profileAgentId ||
          !!chatAgentId
        }
      />
    </div>
  );
}
