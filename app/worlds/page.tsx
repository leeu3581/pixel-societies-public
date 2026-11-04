"use client";

// All Worlds — every signed-up user's home world rendered as one big
// Phaser map. Agents are clustered by owner so each "neighborhood" reads
// as a distinct world. Tap a sprite → AgentProfilePanel slides in with
// the {Owner}'s world tag + the same rich hub markdown the /world graph
// overlay shows.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/authClient";
import { apiGet, ApiError } from "@/lib/api";
import AgentProfilePanel from "@/components/AgentProfilePanel";
import RPGDialog from "@/components/RPGDialog";
import BrandChip from "@/components/BrandChip";
import SocietyFeed from "@/components/SocietyFeed";
import WorldGroupsDrawer from "@/components/WorldGroupsDrawer";
import SpriteFrame from "@/components/SpriteFrame";
import WorldConsultDrawer from "@/components/WorldConsultDrawer";
import WorldGraphOverlay from "@/components/WorldGraphOverlay";
import WorldRoomChat from "@/components/WorldRoomChat";
import WorldZoomControls from "@/components/WorldZoomControls";
import GameControls from "@/components/GameControls";
import type { WorldAgent } from "@/components/PhaserHost";

const PhaserHost = dynamic(() => import("@/components/PhaserHost"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-[#0c1626] font-mono text-[11px] uppercase tracking-wider text-[#fffaf0]">
      Loading world…
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

type Resp = { agents: NetworkAgent[] };

type MeResponse = {
  profile: {
    display_name: string | null;
  } | null;
};

type SearchResult = {
  type: "profile" | "agent";
  id: string;
  display_name: string;
  subtitle: string | null;
  sprite_url: string | null;
  photo_url: string | null;
  owner_display_name: string | null;
  world_id: string | null;
  friendship_status: "pending" | "accepted" | null;
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

function clampGrid(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Place owner centers on a small ring around the middle of the map and
 * scatter each owner's agents inside a generous radius so the
 * neighborhoods OVERLAP — you see everyone in roughly the same area
 * but each owner has a slight center of gravity. Keeps the demo feel
 * of "one shared world" rather than partitioned districts.
 */
const OWNER_RING_RADIUS = 4; // distance from map center for each owner's center
const AGENT_SPREAD = 6;      // half-width of the per-owner scatter box

function placeForAllWorlds(agents: NetworkAgent[]): WorldAgent[] {
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
      let y = clampGrid(
        cy + (((h >>> 8) % span) - AGENT_SPREAD),
        1,
        GRID_H - 2,
      );
      // Resolve collisions by walking small offsets, then spiral outward.
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

export default function AllWorldsPage() {
  const router = useRouter();
  const [network, setNetwork] = useState<NetworkAgent[] | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileAgentId, setProfileAgentId] = useState<string | null>(null);
  const [chatAgentId, setChatAgentId] = useState<string | null>(null);
  const [consultOpen, setConsultOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [societyOpen, setSocietyOpen] = useState(false);
  const [worldsOpen, setWorldsOpen] = useState(false);
  const [roomOpen, setRoomOpen] = useState(false);
  const [playerSprite, setPlayerSprite] = useState<{ url: string; type: "portrait" | "sheet" } | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeGroupName, setActiveGroupName] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isMobile = useIsMobile();

  const signOut = () => {
    logout();
    router.replace("/login");
  };

  // BGM
  const [bgmPlaying, setBgmPlaying] = useState(true);
  const bgmRef = useRef<HTMLAudioElement | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }
    setSearchLoading(true);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await apiGet<{ results: SearchResult[] }>(
          `/api/search?q=${encodeURIComponent(searchQuery.trim())}`,
        );
        setSearchResults(res.results);
        setSearchOpen(true);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 250);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchQuery]);

  // Close search on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // BGM: create audio, autoplay on mount
  useEffect(() => {
    const audio = new Audio("/music/bg-music-digital-momentum.mp3");
    audio.loop = true;
    audio.volume = 0.3;
    bgmRef.current = audio;
    audio.play().catch(() => setBgmPlaying(false));
    return () => {
      audio.pause();
      audio.src = "";
      bgmRef.current = null;
    };
  }, []);

  const toggleBgm = useCallback(() => {
    const audio = bgmRef.current;
    if (!audio) return;
    if (bgmPlaying) {
      audio.pause();
      setBgmPlaying(false);
    } else {
      audio.play().then(() => setBgmPlaying(true)).catch(() => setBgmPlaying(false));
    }
  }, [bgmPlaying]);

  const handleSearchSelect = useCallback((result: SearchResult) => {
    setSearchOpen(false);
    setSearchQuery("");
    if (result.type === "agent") {
      setProfileAgentId(result.id);
    } else {
      // Navigate to profile's world
      window.location.href = `/world/${encodeURIComponent(result.display_name)}`;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meRes = await apiGet<MeResponse>("/api/me");
        if (!cancelled) setMe(meRes);
        const res = await apiGet<Resp>("/api/me/network-agents");
        if (!cancelled) {
          if (res.agents.length > 0) setNetwork(res.agents);
          else {
            const fallback = await apiGet<Resp>("/api/network-agents");
            if (!cancelled) setNetwork(fallback.agents);
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          try {
            const res = await apiGet<Resp>("/api/network-agents");
            if (!cancelled) setNetwork(res.agents);
          } catch (fallbackErr) {
            if (!cancelled) {
              setError(
                fallbackErr instanceof ApiError
                  ? `${fallbackErr.status}: ${fallbackErr.message}`
                  : String(fallbackErr),
              );
            }
          }
          return;
        }
        setError(
          err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
        );
      }
      // Fetch player's own sprite for the controllable character.
      try {
        const meData = await apiGet<{ home_world: { id: string } | null }>("/api/me");
        if (!cancelled && meData.home_world?.id) {
          const { agents: myAgents } = await apiGet<{ agents: Array<{ canonical_id: string | null; sprite_url: string | null; portrait_url: string | null }> }>(
            `/api/worlds/${meData.home_world.id}/agents`,
          );
          const self = myAgents.find((a: { canonical_id: string | null; sprite_sheet_url?: string | null }) => a.canonical_id === null) as { sprite_sheet_url?: string | null } | undefined;
          if (self?.sprite_sheet_url) {
            setPlayerSprite({ url: self.sprite_sheet_url, type: "sheet" });
          }
        }
      } catch { /* non-critical */ }
      // Auto-select first world group so Room chat works immediately.
      try {
        let gRes = await apiGet<{ groups: Array<{ id: string; name: string }> }>(
          "/api/world-groups?scope=mine",
        );
        if (gRes.groups.length === 0) {
          gRes = await apiGet<{ groups: Array<{ id: string; name: string }> }>(
            "/api/world-groups?scope=public",
          );
        }
        if (!cancelled && gRes.groups.length > 0) {
          setActiveGroupId(gRes.groups[0].id);
          setActiveGroupName(gRes.groups[0].name);
        }
      } catch { /* non-critical */ }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const phaserAgents = useMemo(
    () => (network ? placeForAllWorlds(network.filter((a) => !(a.is_own && a.canonical_id === null))) : []),
    [network],
  );

  // Tap any sprite → open the AgentProfilePanel for that agent. Profile
  // endpoint is RLS-gated (own or accepted-friend's agent), so visitors
  // who hit a non-friend sprite see the panel's error state — that's
  // fine for the demo; closes the loop without faking access.
  useEffect(() => {
    // Click on sprite → open profile panel.
    const onTap = (e: Event) => {
      const detail = (e as CustomEvent).detail as { agent_id?: string };
      if (detail?.agent_id) setProfileAgentId(detail.agent_id);
    };
    // Z key near agent → open RPG chat dialog.
    const onChat = (e: Event) => {
      const detail = (e as CustomEvent).detail as { agent_id?: string };
      if (detail?.agent_id) setChatAgentId(detail.agent_id);
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

  const ownerCount = useMemo(() => {
    if (!network) return 0;
    return new Set(network.map((a) => a.owner_user_id)).size;
  }, [network]);

  const profileAgent = profileAgentId
    ? network?.find((a) => a.agent_id === profileAgentId) ?? null
    : null;
  const ownAgents = useMemo(
    () =>
      (network ?? [])
        .filter((a) => a.is_own)
        .map((a) => ({
          id: a.agent_id,
          display_name: a.display_name,
          sprite_url: a.sprite_url,
          placeholder_sprite_url: pickPlaceholder(a.agent_id),
        })),
    [network],
  );
  const myUsername = me?.profile?.display_name || null;
  const agentsById = useMemo(() => {
    const m = new Map<string, { id: string; display_name: string }>();
    for (const a of network ?? []) {
      m.set(a.agent_id, { id: a.agent_id, display_name: a.display_name });
    }
    return m;
  }, [network]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0c1626] text-[#fffaf0]">
      {network !== null && (
        <PhaserHost
          agents={phaserAgents}
          mode="visit"
          playerName={myUsername ?? "You"}
        />
      )}

      {!isMobile && <BrandChip />}
      {!isMobile && <WorldZoomControls />}

      {/* Pixel Globe — the default public World everyone is in.
          One-tap entry into the live room from the Public gallery. */}
      <div className="pointer-events-auto fixed bottom-3 right-3 z-30 sm:bottom-4 sm:right-4">
        <Link
          href="/worlds/pixel-square"
          className="flex items-center gap-2 border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c] hover:bg-[#ffd84d]"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-[#2f6e2c]" />
          Enter Pixel Globe →
        </Link>
      </div>

      {/* Top HUD — mobile: compact BGM + Menu; desktop: full strip */}
      <div className="pointer-events-auto fixed top-3 right-3 z-20 sm:top-4 sm:right-4">
        {isMobile ? (
          /* ── Mobile: BGM + MENU ── */
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={bgmPlaying ? "Mute music" : "Play music"}
              onClick={toggleBgm}
              className={
                "flex h-8 items-center gap-1 border-[3px] border-[#1f2a3c] px-2 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (bgmPlaying
                  ? "bg-[#d6f4d6] text-[#1f2a3c]"
                  : "bg-[rgba(246,244,234,0.97)] text-[#7f8b98]")
              }
            >
              <span className="text-sm leading-none">{bgmPlaying ? "♫" : "♪"}</span>
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              className="flex h-8 items-center border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 font-mono text-[10px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]"
            >
              Menu
            </button>
          </div>
        ) : (
          /* ── Desktop: identical to /world HUD, "All worlds" → "My World" ── */
          <div className="flex items-center gap-2">
            <div ref={searchBoxRef} className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => searchResults.length > 0 && setSearchOpen(true)}
                placeholder="Search…"
                className="w-28 border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-1 font-mono text-[10px] text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98] sm:w-44"
              />
              {searchOpen && searchResults.length > 0 && (
                <div className="absolute right-0 top-full z-50 mt-1 max-h-64 w-72 overflow-y-auto border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[4px_4px_0_#1f2a3c]">
                  {searchResults.map((r) => (
                    <button
                      key={`${r.type}-${r.id}`}
                      type="button"
                      onClick={() => handleSearchSelect(r)}
                      className="flex w-full items-center gap-2 border-b border-[#e8e2d4] px-3 py-2 text-left hover:bg-[#e8f1ff]"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center border-[2px] border-[#1f2a3c] bg-[#dcecf4]">
                        {r.type === "agent" && r.sprite_url ? (
                          <SpriteFrame src={r.sprite_url} sheet="generated" frame={0} size={1} title={r.display_name} />
                        ) : r.photo_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.photo_url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="font-mono text-[10px] font-bold text-[#1f2a3c]">{r.display_name.charAt(0).toUpperCase()}</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-[11px] font-bold text-[#1f2a3c]">{r.display_name}</span>
                          <span className={`shrink-0 px-1 py-0.5 font-mono text-[8px] font-bold uppercase ${r.type === "profile" ? "bg-[#dcecf4] text-[#425166]" : "bg-[#e8d6ff] text-[#5a3d7a]"}`}>
                            {r.type === "profile" ? "Person" : "Agent"}
                          </span>
                          {r.friendship_status === "accepted" && (
                            <span className="shrink-0 px-1 py-0.5 font-mono text-[8px] font-bold uppercase bg-[#d4edda] text-[#2d6a3f]">Friend</span>
                          )}
                        </div>
                        {r.subtitle && <p className="truncate text-[10px] text-[#637387]">{r.subtitle}</p>}
                        {r.owner_display_name && <p className="truncate text-[10px] text-[#637387]">in {r.owner_display_name}&apos;s world</p>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {searchOpen && searchResults.length === 0 && searchQuery.trim() && !searchLoading && (
                <div className="absolute right-0 top-full z-50 mt-1 w-72 border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 font-mono text-[10px] text-[#637387] shadow-[4px_4px_0_#1f2a3c]">
                  No results for &ldquo;{searchQuery}&rdquo;
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label={bgmPlaying ? "Mute music" : "Play music"}
              onClick={toggleBgm}
              className={
                "flex h-7 items-center gap-1 border-[3px] border-[#1f2a3c] px-2 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (bgmPlaying
                  ? "bg-[#d6f4d6] text-[#1f2a3c]"
                  : "bg-[rgba(246,244,234,0.97)] text-[#7f8b98]")
              }
            >
              <span className="text-sm leading-none">{bgmPlaying ? "♫" : "♪"}</span>
              {bgmPlaying ? "On" : "Off"}
            </button>
            <Link
              href="/world"
              className="flex items-center gap-2 border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] hover:bg-[#ffd84d]"
            >
              My World
            </Link>
            <button
              type="button"
              onClick={() => setGraphOpen((s) => !s)}
              className={
                "border-[3px] border-[#1f2a3c] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (graphOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#b8a4d6] text-[#1f2a3c]")
              }
            >
              Graph
            </button>
            <button
              type="button"
              onClick={() => setSocietyOpen((s) => !s)}
              className={
                "border-[3px] border-[#1f2a3c] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (societyOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#b8a4d6] text-[#1f2a3c]")
              }
            >
              DMs
            </button>
            <button
              type="button"
              onClick={() => setWorldsOpen((s) => !s)}
              className={
                "border-[3px] border-[#1f2a3c] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (worldsOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#b8a4d6] text-[#1f2a3c]")
              }
            >
              Worlds{activeGroupName ? ` · ${activeGroupName}` : ""}
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!activeGroupId) {
                  try {
                    let g = await apiGet<{ groups: Array<{ id: string; name: string }> }>("/api/world-groups?scope=mine");
                    if (g.groups.length === 0) g = await apiGet<{ groups: Array<{ id: string; name: string }> }>("/api/world-groups?scope=public");
                    if (g.groups.length > 0) { setActiveGroupId(g.groups[0].id); setActiveGroupName(g.groups[0].name); }
                  } catch { /* ignore */ }
                }
                setRoomOpen((s) => !s);
              }}
              className={
                "border-[3px] border-[#1f2a3c] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (roomOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#dcecf4]")
              }
            >
              Room
            </button>
            <Link
              href="/friends"
              className="relative border-[3px] border-[#1f2a3c] bg-[#d4cbbe] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
            >
              Friends
            </Link>
            <div className="relative">
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                aria-expanded={settingsOpen}
                className="border-[3px] border-[#1f2a3c] bg-[#d4cbbe] px-3 py-1.5 font-mono text-[10px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]"
              >
                Settings
              </button>
              {settingsOpen && (
                <div className="absolute right-0 top-[calc(100%+0.5rem)] flex w-40 flex-col gap-2 border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] p-2 shadow-[3px_3px_0_#1f2a3c]">
                  <Link href="/profile" className="border-[2px] border-[#1f2a3c] bg-[#e8f1ff] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[#1f2a3c]">
                    Profile
                  </Link>
                  <Link href="/worlds" className="border-[2px] border-[#1f2a3c] bg-[#fff3cd] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[#1f2a3c]">
                    All worlds
                  </Link>
                  <button type="button" onClick={() => { setSettingsOpen(false); signOut(); }} className="border-[2px] border-[#1f2a3c] bg-[#f7ddd7] px-2 py-1 text-left font-mono text-[10px] font-bold uppercase text-[#1f2a3c]">
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Mobile dropdown menu */}
        {isMobile && menuOpen && (
          <>
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0 z-10"
            />
            <div className="relative z-20 mt-2 flex flex-col gap-2 border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] p-3 shadow-[4px_4px_0_#1f2a3c]">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#637387]">
                {ownerCount} {ownerCount === 1 ? "owner" : "owners"} · {network?.length ?? 0} agents
              </div>
              <Link
                href="/world"
                onClick={() => setMenuOpen(false)}
                className="border-[2px] border-[#1f2a3c] bg-[#d4cbbe] px-3 py-2 font-mono text-[10px] font-bold uppercase text-[#1f2a3c]"
              >
                ← My World
              </Link>
              <Link
                href="/worlds"
                onClick={() => setMenuOpen(false)}
                className="border-[2px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-2 text-left font-mono text-[10px] font-bold uppercase text-[#1f2a3c]"
              >
                All worlds
              </Link>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); setGraphOpen((s) => !s); }}
                className="border-[2px] border-[#1f2a3c] bg-[#b8a4d6] px-3 py-2 text-left font-mono text-[10px] font-bold uppercase text-[#1f2a3c]"
              >
                Graph
              </button>
              <Link
                href="/friends"
                onClick={() => setMenuOpen(false)}
                className="border-[2px] border-[#1f2a3c] bg-[#d4cbbe] px-3 py-2 font-mono text-[10px] font-bold uppercase text-[#1f2a3c]"
              >
                Friends
              </Link>
              <div ref={searchBoxRef} className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search…"
                  className="w-full border-[2px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 font-mono text-[10px] text-[#1f2a3c] outline-none placeholder:text-[#7f8b98]"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  window.dispatchEvent(new CustomEvent("phaser:reset-camera"));
                }}
                className="border-[2px] border-[#1f2a3c] bg-[#fff3cd] px-3 py-2 text-left font-mono text-[10px] font-bold uppercase text-[#1f2a3c]"
              >
                Reset view
              </button>
            </div>
          </>
        )}
      </div>

      {/* Posts + Inner Thoughts panels removed — focus is rooms/DMs. */}

      {/* On-screen D-pad + A/B game controls */}
      <GameControls />


      {error && (
        <div className="fixed bottom-3 right-3 z-30 max-w-sm border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24] shadow-[3px_3px_0_#1f2a3c] sm:bottom-4 sm:right-4">
          {error}
        </div>
      )}

      {network !== null && phaserAgents.length === 0 && !error && (
        <div className="fixed inset-0 z-10 flex items-center justify-center">
          <div className="border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]">
            No agents in the network yet.
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

      {chatAgentId && (() => {
        const a = network?.find((n) => n.agent_id === chatAgentId);
        if (!a) return null;
        return (
          <RPGDialog
            agentId={a.agent_id}
            agentDisplayName={a.display_name}
            canonicalId={a.canonical_id}
            agentSpriteUrl={a.sprite_url ?? pickPlaceholder(a.agent_id)}
            agentPortraitUrl={a.portrait_url ?? null}
            onClose={() => setChatAgentId(null)}
          />
        );
      })()}

      {graphOpen && (
        <WorldGraphOverlay
          onClose={() => setGraphOpen(false)}
          worldAgents={phaserAgents}
          onOpenAgent={(agentId) => setProfileAgentId(agentId)}
        />
      )}

      {consultOpen && (
        <WorldConsultDrawer
          agents={ownAgents}
          onClose={() => setConsultOpen(false)}
        />
      )}

      {activeGroupId && (
        <WorldRoomChat
          open={roomOpen}
          onClose={() => setRoomOpen(false)}
          worldGroupId={activeGroupId}
          worldGroupName={activeGroupName ?? "Room"}
          myAgents={phaserAgents.map((a) => ({ id: a.id, display_name: a.display_name }))}
          agentsById={agentsById}
          myUserId={null}
          myDisplayName={myUsername}
          membersByUserId={new Map()}
        />
      )}

      <SocietyFeed
        open={societyOpen}
        onClose={() => setSocietyOpen(false)}
        ownerUsername={myUsername}
        agentsById={agentsById}
        worldGroupId={activeGroupId}
        worldGroupName={activeGroupName}
      />

      <WorldGroupsDrawer
        open={worldsOpen}
        onClose={() => setWorldsOpen(false)}
        onSelect={async (groupId) => {
          setActiveGroupId(groupId);
          try {
            const res = await apiGet<{ group: { id: string; name: string } }>(
              `/api/world-groups/${encodeURIComponent(groupId)}`,
            );
            setActiveGroupName(res.group.name);
          } catch {
            setActiveGroupName(null);
          }
          setWorldsOpen(false);
          setSocietyOpen(true);
        }}
      />
    </div>
  );
}
