"use client";

// World page — Phaser 3 scene mounts here. Step 3 brings the canvas to
// life: the four signup-seeded agents render at their tile positions,
// idle-wander, and emit a `phaser:agent-tap` event when clicked. The
// React side listens for that event and shows a brutalist toast (placeholder
// for the ChatDrawer that lands in step 7).
//
// Auth + data fetching is unchanged from the step-2 placeholder: read
// /api/me, then query public.agents under RLS.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { useRouter } from "next/navigation";
import { fetchSession, logout } from "@/lib/authClient";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api";
import BrandChip from "@/components/BrandChip";
import AgentProfilePanel from "@/components/AgentProfilePanel";
import RPGDialog from "@/components/RPGDialog";
import SpriteSheetViewer from "@/components/SpriteSheetViewer";
import SpriteFrame from "@/components/SpriteFrame";
import SocietyFeed from "@/components/SocietyFeed";
import WorldGroupsDrawer from "@/components/WorldGroupsDrawer";
import WorldConsultDrawer from "@/components/WorldConsultDrawer";
import WorldGraphOverlay from "@/components/WorldGraphOverlay";
import WorldIngestDrawer from "@/components/WorldIngestDrawer";
import WorldRoomChat from "@/components/WorldRoomChat";
import WorldZoomControls from "@/components/WorldZoomControls";
import GameControls from "@/components/GameControls";
import type { WorldAgent } from "@/components/PhaserHost";

// Dynamic import keeps Phaser out of the SSR bundle entirely.
const PhaserHost = dynamic(() => import("@/components/PhaserHost"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-[#0c1626] font-mono text-xs uppercase tracking-wider text-[#dcecf4]">
      Loading canvas…
    </div>
  ),
});

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

/** Map API agent row → WorldAgent for PhaserHost. Single source of truth. */
function toWorldAgent(a: WorldAgentsResponse["agents"][number]): import("@/lib/phaser/WorldScene").WorldAgent {
  return {
    id: a.id,
    display_name: a.display_name,
    canonical_id: a.canonical_id,
    sprite_url: a.sprite_url,
    portrait_url: a.portrait_url,
    sprite_sheet_url: a.sprite_sheet_url ?? null,
    tile_x: a.tile_x,
    tile_y: a.tile_y,
    placeholder_sprite_url: pickPlaceholder(a.id),
    personality: a.personality_anim ?? undefined,
  };
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const sec = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
}

type MeResponse = {
  user: { id: string; email: string | null; role: string };
  profile: {
    id: string;
    display_name: string | null;
    bio: string | null;
    palette_index: number | null;
    created_at: string;
  } | null;
  home_world: { id: string; slug: string } | null;
};

type WorldsMeResponse = {
  id: string;
  slug: string;
  display_name: string | null;
  tile_w: number;
  tile_h: number;
  bg_palette: number;
  owner_user_id: string;
};

type WorldAgentsResponse = {
  world_id: string;
  owner_user_id: string;
  mode: "own" | "visit";
  agents: Array<{
    id: string;
    display_name: string;
    subtitle: string | null;
    canonical_id: string | null;
    sprite_url: string | null;
    portrait_url: string | null;
    sprite_sheet_url: string | null;
    tile_x: number;
    tile_y: number;
    facing: number;
    tint: string | null;
    personality_anim: Record<string, unknown> | null;
  }>;
};

type Toast = {
  agent_id: string;
  display_name: string;
  canonical_id: string | null;
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

export default function WorldPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const meRef = useRef<MeResponse | null>(null);
  const [agents, setAgents] = useState<WorldAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [consultOpen, setConsultOpen] = useState(false);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [societyOpen, setSocietyOpen] = useState(false);
  const [worldsOpen, setWorldsOpen] = useState(false);
  const [roomOpen, setRoomOpen] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeGroupName, setActiveGroupName] = useState<string | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [profileAgentId, setProfileAgentId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = useIsMobile();
  const [pendingCount, setPendingCount] = useState(0);
  const [recentVisitors, setRecentVisitors] = useState<
    Array<{ visitor_user_id: string; visitor_display_name: string; last_visit: string }>
  >([]);

  // Engine auto-tick
  const [engineOn, setEngineOn] = useState<boolean | null>(null);
  const [togglingEngine, setTogglingEngine] = useState(false);

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

  useEffect(() => {
    (async () => {
      const auth = await fetchSession();
      if (!auth) {
        router.replace("/login?next=/world");
        return;
      }

      try {
        const meRes = await apiGet<MeResponse>("/api/me");
        setMe(meRes);
        meRef.current = meRes;
        if (!meRes.profile?.display_name) {
          router.replace("/onboarding/name");
          return;
        }
      } catch (err: unknown) {
        const msg =
          err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
        setError(`/api/me failed: ${msg}`);
        return;
      }

      // Fetch via the backend, not direct Supabase. /world/[username]
      // (visit mode, step 9) will use the same /api/worlds/{id}/agents
      // endpoint — keeping one code path means RLS rules and response
      // shape live in one place.
      let world: WorldsMeResponse;
      let agentsRes: WorldAgentsResponse;
      try {
        world = await apiGet<WorldsMeResponse>("/api/worlds/me");
      } catch (err: unknown) {
        const msg =
          err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
        setError(`/api/worlds/me failed: ${msg}`);
        return;
      }
      try {
        agentsRes = await apiGet<WorldAgentsResponse>(
          `/api/worlds/${encodeURIComponent(world.id)}/agents`,
        );
      } catch (err: unknown) {
        const msg =
          err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
        setError(`/api/worlds/{id}/agents failed: ${msg}`);
        return;
      }
      setAgents(
        agentsRes.agents.map(toWorldAgent),
      );

      // Pending-friend-request badge count for the HUD.
      try {
        const p = await apiGet<{ incoming: unknown[] }>("/api/friends/pending");
        setPendingCount(p.incoming.length);
      } catch {
        /* ignore — badge is best-effort */
      }

      // Recent visitors panel (refreshed every 30s by the polling effect).
      try {
        const v = await apiGet<{ visitors: typeof recentVisitors }>(
          "/api/visitors/recent",
        );
        setRecentVisitors(v.visitors);
      } catch {
        /* ignore */
      }
    })();
  }, [router]);

  // Poll recent visitors every 30s — owner-side feed of who's chatting
  // with their agents. Cheap query, runs only on the home world.
  useEffect(() => {
    if (!me?.profile?.id) return;
    const t = setInterval(async () => {
      try {
        const v = await apiGet<{ visitors: typeof recentVisitors }>(
          "/api/visitors/recent",
        );
        setRecentVisitors(v.visitors);
      } catch {
        /* ignore */
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [me]);

  // Engine auto-tick: fetch engine status and auto-enable if off.
  useEffect(() => {
    if (!me?.profile?.display_name) return;
    const username = me.profile.display_name;
    (async () => {
      try {
        const res = await apiGet<{ engine_enabled: boolean; effective_state: string }>(
          `/api/worlds/by-username/${encodeURIComponent(username)}/engine`,
        );
        setEngineOn(res.engine_enabled);
        // Auto-enable if currently off
        if (!res.engine_enabled) {
          const updated = await apiPatch<{ engine_enabled: boolean }>(
            `/api/worlds/by-username/${encodeURIComponent(username)}/engine`,
            { enabled: true },
          );
          setEngineOn(updated.engine_enabled);
        }
      } catch {
        /* visitors get 403; ignore */
      }
    })();
  }, [me?.profile?.display_name]);

  const toggleEngine = useCallback(async () => {
    if (!me?.profile?.display_name || engineOn === null || togglingEngine) return;
    setTogglingEngine(true);
    try {
      const res = await apiPatch<{ engine_enabled: boolean }>(
        `/api/worlds/by-username/${encodeURIComponent(me.profile.display_name)}/engine`,
        { enabled: !engineOn },
      );
      setEngineOn(res.engine_enabled);
    } catch {
      /* ignore */
    } finally {
      setTogglingEngine(false);
    }
  }, [me?.profile?.display_name, engineOn, togglingEngine]);

  // Poll for sprite_ready: while any agent is still missing a
  // sprite_url (background Gemini job in flight), refetch every 4s up
  // to ~90s. When the URL lands the Phaser scene re-spawns via the
  // PhaserHost agents-prop effect. Real WS push lands in step 7.
  //
  // The effect runs only when `me` flips from null → loaded so we don't
  // spawn overlapping timer chains on every setAgents.
  const agentsSnapshotRef = useRef("");
  useEffect(() => {
    if (!me?.home_world?.id) return;
    const worldId = me.home_world.id;
    let cancelled = false;
    let elapsed = 0;
    const intervalMs = 4_000;
    const maxMs = 120_000;

    const tick = async () => {
      if (cancelled) return;
      try {
        const fresh = await apiGet<WorldAgentsResponse>(
          `/api/worlds/${encodeURIComponent(worldId)}/agents`,
        );
        if (cancelled) return;
        const mapped = fresh.agents.map(toWorldAgent);
        // Only update state (and trigger a Phaser scene restart) when
        // something actually changed — otherwise we flicker + reset the
        // camera zoom on every poll tick.
        const snap = JSON.stringify(mapped);
        if (snap !== agentsSnapshotRef.current) {
          agentsSnapshotRef.current = snap;
          setAgents(mapped);
        }
        // Keep polling until the self-agent has a sprite_sheet_url
        // (the animated 7×4 spritesheet from Step 2 of the Gemini
        // pipeline). Portrait alone isn't enough for the player sprite.
        const stillMissing = fresh.agents.some(
          (a) => a.canonical_id === null && !a.sprite_sheet_url,
        );
        if (!stillMissing) return; // Done.
      } catch {
        /* keep polling on transient errors */
      }
      elapsed += intervalMs;
      if (elapsed < maxMs) setTimeout(tick, intervalMs);
    };
    const t = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [me]);

  // Bridge: Phaser dispatches `phaser:agent-tap` on window when a sprite
  // is clicked, and `phaser:map-tap` when the user clicks an empty area
  // (which also breaks the camera-follow lock in the scene). For step 3
  // this just opens/closes the toast; step 7 swaps it for <ChatDrawer>.
  useEffect(() => {
    // Click on sprite → open profile panel.
    const onTap = (e: Event) => {
      const detail = (e as CustomEvent).detail as Toast | undefined;
      if (!detail) return;
      setProfileAgentId(detail.agent_id);
    };
    // Z key near agent → open RPG chat dialog.
    const onChat = (e: Event) => {
      const detail = (e as CustomEvent).detail as Toast | undefined;
      if (!detail) return;
      setToast(detail);
    };
    const onMapTap = () => { setToast(null); setProfileAgentId(null); };
    // Shadow companion click → open chat with the specific agent
    // the companion represents (passed via event detail).
    const onShadowChat = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        id: string;
        display_name: string;
        canonical_id: string | null;
      } | undefined;
      if (!detail) return;
      setToast({
        agent_id: detail.id,
        display_name: detail.display_name,
        canonical_id: detail.canonical_id,
      });
    };
    const onBPress = () => { setToast(null); setProfileAgentId(null); };
    // A-press near agent triggers a world tick so agents chat with each other.
    const tickingRef = { current: false };
    const onTriggerTick = async () => {
      if (tickingRef.current) return;
      const username = meRef.current?.profile?.display_name;
      if (!username) return;
      tickingRef.current = true;
      try {
        await apiPost(`/api/worlds/by-username/${encodeURIComponent(username)}/tick`, {});
      } catch { /* non-critical */ }
      tickingRef.current = false;
    };
    window.addEventListener("phaser:agent-tap", onTap);
    window.addEventListener("phaser:agent-chat", onChat);
    window.addEventListener("phaser:map-tap", onMapTap);
    window.addEventListener("phaser:b-press", onBPress);
    window.addEventListener("shadow:open-chat", onShadowChat);
    window.addEventListener("phaser:trigger-tick", onTriggerTick);
    return () => {
      window.removeEventListener("phaser:agent-tap", onTap);
      window.removeEventListener("phaser:agent-chat", onChat);
      window.removeEventListener("phaser:map-tap", onMapTap);
      window.removeEventListener("phaser:b-press", onBPress);
      window.removeEventListener("shadow:open-chat", onShadowChat);
      window.removeEventListener("phaser:trigger-tick", onTriggerTick);
    };
  }, []);

  const resetCamera = () => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("phaser:reset-camera"));
    setToast(null);
  };

  const signOut = () => {
    logout();
    router.replace("/login");
  };

  // ── Search ───────────────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      audio.play().then(() => setBgmPlaying(true)).catch(() => {
        // Browser may block autoplay — user interaction required
        setBgmPlaying(false);
      });
    }
  }, [bgmPlaying]);

  const handleSearchSelect = useCallback((result: SearchResult) => {
    setSearchOpen(false);
    setSearchQuery("");
    if (result.type === "agent") {
      // Open chat with this agent if it's in our world
      const localAgent = agents?.find((a) => a.id === result.id);
      if (localAgent) {
        setToast({
          agent_id: localAgent.id,
          display_name: localAgent.display_name,
          canonical_id: localAgent.canonical_id,
        });
      }
    } else {
      // Navigate to profile's world
      window.location.href = `/world/${encodeURIComponent(result.display_name)}`;
    }
  }, [agents]);

  if (error) {
    return (
      <main className="relative h-dvh w-full overflow-hidden bg-[#0c1626]">
        <BrandChip />
        <div className="absolute inset-0 flex items-center justify-center px-4">
          <div className="max-w-lg border-[3px] border-[#1f2a3c] bg-[#f7ddd7] p-4 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24] shadow-[4px_4px_0_#1f2a3c]">
            {error}
          </div>
        </div>
      </main>
    );
  }

  if (!me || agents === null) {
    return (
      <main className="relative h-dvh w-full overflow-hidden bg-[#0c1626]">
        <BrandChip />
        <div className="absolute inset-0 flex items-center justify-center px-4">
          <div className="font-mono text-sm uppercase tracking-wider text-[#dcecf4]">
            Loading your world…
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#0c1626]">
      {/* The pixel canvas fills the entire viewport — the map IS the page.
          Self-agent (canonical_id=null) becomes the player sprite, not an NPC. */}
      <PhaserHost
        agents={agents.filter((a) => a.canonical_id !== null)}
        mode="own"
        playerName={me.profile?.display_name ?? "You"}
        playerSpriteUrl={agents.find((a) => a.canonical_id === null)?.portrait_url ?? null}
        playerSpriteType="portrait"
      />

      {isMobile ? (
        <BrandChip compact />
      ) : (
        <BrandChip subtitle={`${me.profile?.display_name || "—"} · ${agents.length} agent${agents.length === 1 ? "" : "s"}`} />
      )}

      {!isMobile && <WorldZoomControls />}

      {/* HUD: top-right — mobile: compact BGM + Menu; desktop: full strip */}
      <div className="fixed top-3 right-3 z-30 sm:top-4 sm:right-4">
        {isMobile ? (
          <div className="flex flex-col items-end gap-2">
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
            <button
              type="button"
              onClick={() => setSocietyOpen((s) => !s)}
              aria-pressed={societyOpen}
              className={
                "flex h-8 items-center border-[3px] border-[#1f2a3c] px-3 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (societyOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#f6f4ea] text-[#1f2a3c]")
              }
            >
              Chat Room
            </button>
          </div>
        ) : (
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
                          <span className="font-mono text-[10px] font-bold text-[#1f2a3c]">
                            {r.display_name.charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-[11px] font-bold text-[#1f2a3c]">{r.display_name}</span>
                          <span className={`shrink-0 px-1 py-0.5 font-mono text-[8px] font-bold uppercase ${
                            r.type === "profile" ? "bg-[#dcecf4] text-[#425166]" : "bg-[#e8d6ff] text-[#5a3d7a]"
                          }`}>
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
              Chat Room
            </button>
            <button
              type="button"
              onClick={() => setWorldsOpen((s) => !s)}
              className={
                "border-[3px] border-[#1f2a3c] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] " +
                (worldsOpen ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#b8a4d6] text-[#1f2a3c]")
              }
            >
              Worlds
            </button>
            <Link
              href="/friends"
              className="relative border-[3px] border-[#1f2a3c] bg-[#d4cbbe] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
            >
              Friends
              {pendingCount > 0 && (
                <span className="absolute -right-2 -top-2 inline-flex h-5 min-w-[20px] items-center justify-center border-[2px] border-[#1f2a3c] bg-[#ffe17d] px-1 font-mono text-[10px] font-bold leading-none">
                  {pendingCount}
                </span>
              )}
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
                  <Link
                    href="/profile"
                    className="border-[2px] border-[#1f2a3c] bg-[#e8f1ff] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[#1f2a3c]"
                  >
                    Profile
                  </Link>
                  <button
                    type="button"
                    onClick={() => { setSettingsOpen(false); setIngestOpen(true); }}
                    className="border-[2px] border-[#1f2a3c] bg-[#d6f4d6] px-2 py-1 text-left font-mono text-[10px] font-bold uppercase text-[#1f2a3c]"
                  >
                    + Ingest
                  </button>
                  <Link
                    href="/onboarding/photo"
                    className="border-[2px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[#1f2a3c]"
                  >
                    Photo
                  </Link>
                  {(() => {
                    const self = agents.find((a) => a.canonical_id === null);
                    if (!self || self.sprite_sheet_url) return null;
                    return (
                      <button
                        type="button"
                        onClick={async () => {
                          setSettingsOpen(false);
                          try {
                            await apiPost(`/api/sprites/${self.id}/retry-sheet`, {});
                          } catch { /* ignore */ }
                        }}
                        className="border-[2px] border-[#1f2a3c] bg-[#dcecf4] px-2 py-1 text-left font-mono text-[10px] font-bold uppercase text-[#1f2a3c]"
                      >
                        Regen Sprite
                      </button>
                    );
                  })()}
                  {engineOn !== null && (
                    <button
                      type="button"
                      onClick={toggleEngine}
                      disabled={togglingEngine}
                      className={`border-[2px] border-[#1f2a3c] px-2 py-1 text-left font-mono text-[10px] font-bold uppercase disabled:opacity-60 ${
                        engineOn ? "bg-[#d6f4d6] text-[#1f2a3c]" : "bg-[#f6f4ea] text-[#7f8b98]"
                      }`}
                    >
                      Auto-tick: {engineOn ? "on" : "off"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={signOut}
                    className="border-[2px] border-[#1f2a3c] bg-[#f7ddd7] px-2 py-1 text-left font-mono text-[10px] font-bold uppercase text-[#1f2a3c]"
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

      </div>

      {/* Mobile menu — full-width sheet with search + grouped sections.
          Lives outside the top-right HUD container so it can span the
          screen without inheriting that container's content-width. */}
      {isMobile && menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-30 bg-[rgba(12,22,38,0.55)] backdrop-blur-sm"
          />
          <div className="fixed inset-x-3 top-14 z-40 max-h-[calc(100dvh-4.5rem)] overflow-y-auto border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.99)] p-3 shadow-[4px_4px_0_#1f2a3c]">
            {/* Search */}
            <div className="relative mb-3">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => searchResults.length > 0 && setSearchOpen(true)}
                placeholder="Search people, agents…"
                className="w-full border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 font-mono text-[12px] text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
              />
              {searchOpen && searchResults.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[4px_4px_0_#1f2a3c]">
                  {searchResults.map((r) => (
                    <button
                      key={`${r.type}-${r.id}`}
                      type="button"
                      onClick={() => { handleSearchSelect(r); setMenuOpen(false); }}
                      className="flex w-full items-center gap-2 border-b border-[#e8e2d4] px-3 py-2 text-left hover:bg-[#e8f1ff]"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center border-[2px] border-[#1f2a3c] bg-[#dcecf4]">
                        {r.type === "agent" && r.sprite_url ? (
                          <SpriteFrame src={r.sprite_url} sheet="generated" frame={0} size={1} title={r.display_name} />
                        ) : r.photo_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.photo_url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="font-mono text-[10px] font-bold text-[#1f2a3c]">
                            {r.display_name.charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-[11px] font-bold text-[#1f2a3c]">{r.display_name}</span>
                          <span className={`shrink-0 px-1 py-0.5 font-mono text-[8px] font-bold uppercase ${
                            r.type === "profile" ? "bg-[#dcecf4] text-[#425166]" : "bg-[#e8d6ff] text-[#5a3d7a]"
                          }`}>
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
            </div>

            {/* Section: Chat */}
            <p className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-[#637387]">Chat</p>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { setMenuOpen(false); setSocietyOpen(true); }}
                className="border-[2px] border-[#1f2a3c] bg-[#b8a4d6] px-3 py-2.5 font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                Chat Room
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); setWorldsOpen(true); }}
                className="border-[2px] border-[#1f2a3c] bg-[#e8d6ff] px-3 py-2.5 font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                Worlds
              </button>
            </div>

            {/* Section: Explore */}
            <p className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-[#637387]">Explore</p>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { setMenuOpen(false); setGraphOpen(true); }}
                className="border-[2px] border-[#1f2a3c] bg-[#b8a4d6] px-3 py-2.5 font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                Graph
              </button>
              <Link
                href="/friends"
                onClick={() => setMenuOpen(false)}
                className="relative border-[2px] border-[#1f2a3c] bg-[#d4cbbe] px-3 py-2.5 text-center font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                Friends
                {pendingCount > 0 && (
                  <span className="absolute -right-2 -top-2 inline-flex h-5 min-w-[20px] items-center justify-center border-[2px] border-[#1f2a3c] bg-[#ffe17d] px-1 font-mono text-[10px] font-bold leading-none">
                    {pendingCount}
                  </span>
                )}
              </Link>
            </div>

            {/* Section: You */}
            <p className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-[#637387]">You</p>
            <div className="grid grid-cols-2 gap-2">
              <Link
                href="/profile"
                onClick={() => setMenuOpen(false)}
                className="border-[2px] border-[#1f2a3c] bg-[#c4d8eb] px-3 py-2.5 text-center font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                Profile
              </Link>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); setIngestOpen(true); }}
                className="border-[2px] border-[#1f2a3c] bg-[#d6f4d6] px-3 py-2.5 font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                + Ingest
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); signOut(); }}
                className="col-span-2 border-[2px] border-[#1f2a3c] bg-[#f7ddd7] px-3 py-2.5 text-left font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]"
              >
                Sign out
              </button>
            </div>
          </div>
        </>
      )}

      {/* On-screen D-pad + A/B game controls — hide when any
          panel/menu/dialog is open so the chat input + drawer
          buttons aren't blocked by the bottom HUD on mobile. */}
      <GameControls
        hidden={
          roomOpen ||
          societyOpen ||
          worldsOpen ||
          graphOpen ||
          consultOpen ||
          ingestOpen ||
          menuOpen ||
          settingsOpen ||
          !!toast ||
          !!profileAgentId ||
          !!editingAgentId
        }
      />


      {/* Posts feed + Inner thoughts panels removed — focus is on
          live room chat / DMs in worlds. Backend endpoints + tables
          remain (engine_loop is gated off via DISABLE_ENGINE_LOOP). */}

      {/* Recent visitors — hidden on mobile */}
      {!isMobile && recentVisitors.length > 0 && (
        <div className="fixed bottom-16 right-3 z-20 w-[min(260px,calc(100vw-1.5rem))] sm:bottom-20 sm:right-4">
          <div className="border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] p-3 text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c]">
            <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]">
              Recent visitors
            </p>
            <ul className="space-y-1">
              {recentVisitors.slice(0, 5).map((v) => (
                <li
                  key={v.visitor_user_id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="truncate text-sm font-bold leading-tight">
                    {v.visitor_display_name}
                  </span>
                  <span className="font-mono text-[10px] uppercase text-[#7f8b98]">
                    {relativeTime(v.last_visit)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* RPG dialog — Pokemon-style text box when you talk to an agent. */}
      {toast && (
        <RPGDialog
          agentId={toast.agent_id}
          agentDisplayName={toast.display_name}
          canonicalId={toast.canonical_id}
          agentSpriteUrl={
            agents.find((a) => a.id === toast.agent_id)?.sprite_url ||
            agents.find((a) => a.id === toast.agent_id)?.placeholder_sprite_url ||
            "/team-office/characters/char_0.png"
          }
          agentPortraitUrl={
            agents.find((a) => a.id === toast.agent_id)?.portrait_url ?? null
          }
          onClose={resetCamera}
        />
      )}

      {/* Agent profile panel — click on a sprite to open. */}
      {profileAgentId && (
        <AgentProfilePanel
          agentId={profileAgentId}
          fallbackSpriteUrl={
            agents.find((a) => a.id === profileAgentId)?.sprite_url ||
            agents.find((a) => a.id === profileAgentId)?.placeholder_sprite_url ||
            "/team-office/characters/char_0.png"
          }
          onClose={() => setProfileAgentId(null)}
        />
      )}

      {/* Sprite sheet viewer + editor — triggered from ChatDrawer's "Sprite" button. */}
      {editingAgentId && (() => {
        const agent = agents.find((a) => a.id === editingAgentId);
        return (
          <SpriteSheetViewer
            agentId={editingAgentId}
            displayName={agent?.display_name ?? "Agent"}
            portraitUrl={agent?.portrait_url ?? null}
            spriteSheetUrl={agent?.sprite_sheet_url ?? null}
            spriteUrl={agent?.sprite_url ?? null}
            onClose={() => setEditingAgentId(null)}
            onUpdated={async () => {
              try {
                const fresh = await apiGet<WorldAgentsResponse>(
                  `/api/worlds/${encodeURIComponent(me?.home_world?.id ?? "")}/agents`,
                );
                setAgents(
                  fresh.agents.map(toWorldAgent),
                );
              } catch {
                /* best-effort refresh */
              }
            }}
          />
        );
      })()}

      {/* In-world graph overlay — Phaser stays in the background, the
          graph layers on top with brutalist chrome + ESC to close.
          Clicking a hub's "Open chat" button hands off to the existing
          ChatDrawer (via the same `setToast` path the canvas uses). */}
      {graphOpen && (
        <WorldGraphOverlay
          onClose={() => setGraphOpen(false)}
          worldAgents={agents}
          onOpenAgent={(agentId) => {
            const a = agents.find((x) => x.id === agentId);
            if (a) {
              setToast({
                agent_id: a.id,
                display_name: a.display_name,
                canonical_id: a.canonical_id,
              });
            }
          }}
        />
      )}

      {/* WorldConsultDrawer — "Ask my world" runs Router → Answers →
          Verdict over the user's home-world agents. */}
      {consultOpen && (
        <WorldConsultDrawer
          agents={agents.map((a) => ({
            id: a.id,
            display_name: a.display_name,
            sprite_url: a.sprite_url,
            placeholder_sprite_url: a.placeholder_sprite_url,
          }))}
          onClose={() => setConsultOpen(false)}
        />
      )}

      {/* Debug: log Room render gate */}
      {(() => { if (roomOpen) console.log("[ROOM] gate check — activeGroupId:", activeGroupId, "roomOpen:", roomOpen); return null; })()}
      {activeGroupId && (
        <WorldRoomChat
          open={roomOpen}
          onClose={() => setRoomOpen(false)}
          worldGroupId={activeGroupId}
          worldGroupName={activeGroupName ?? "Room"}
          myAgents={agents.map((a) => ({ id: a.id, display_name: a.display_name }))}
          agentsById={new Map(agents.map((a) => [a.id, { id: a.id, display_name: a.display_name }]))}
          myUserId={me?.user?.id ?? null}
          myDisplayName={me?.profile?.display_name ?? null}
          membersByUserId={new Map()}
        />
      )}

      <SocietyFeed
        open={societyOpen}
        onClose={() => setSocietyOpen(false)}
        ownerUsername={me?.profile?.display_name ?? null}
        agentsById={
          new Map(
            agents.map((a) => [a.id, { id: a.id, display_name: a.display_name }]),
          )
        }
        worldGroupId={activeGroupId}
        worldGroupName={activeGroupName}
        worldId={activeGroupId ? null : me?.home_world?.id ?? null}
      />

      <WorldGroupsDrawer
        open={worldsOpen}
        onClose={() => setWorldsOpen(false)}
        hideHomeLink
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

      {/* WorldIngestDrawer — "+ Ingest" uploads a chat/bio and inserts a
          new agent into public.agents. On done we refetch the agents
          list so the new sprite appears on the Phaser canvas. */}
      {ingestOpen && me?.home_world?.id && (
        <WorldIngestDrawer
          onClose={() => setIngestOpen(false)}
          onIngested={async () => {
            try {
              const fresh = await apiGet<WorldAgentsResponse>(
                `/api/worlds/${encodeURIComponent(me.home_world!.id!)}/agents`,
              );
              setAgents(fresh.agents.map(toWorldAgent));
            } catch {
              /* ignore — drawer's Close button still works */
            }
          }}
        />
      )}

    </main>
  );
}
