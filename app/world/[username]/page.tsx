"use client";

// Visit-mode page — `/world/[username]`. Mirrors `/world` but reads
// another user's world by display_name. The backend's
// /api/worlds/by-username/{username} returns 403 if the caller isn't
// friends, which we surface as a "you need to be friends" panel.
//
// All drag-on-agent affordances (none in v0) plus future agent.move WS
// outbound calls go through the `mode='visit'` flag the backend echoes
// back. Tap-to-chat still works — ChatDrawer opens with mode='visit'
// from the WS history frame.

import dynamic from "next/dynamic";
import Link from "next/link";
import { use as usePromise, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchSession } from "@/lib/authClient";
import { apiGet, ApiError } from "@/lib/api";
import BrandChip from "@/components/BrandChip";
import AgentProfilePanel from "@/components/AgentProfilePanel";
import RPGDialog from "@/components/RPGDialog";
import WorldZoomControls from "@/components/WorldZoomControls";
import GameControls from "@/components/GameControls";
import type { WorldAgent } from "@/components/PhaserHost";

const PhaserHost = dynamic(() => import("@/components/PhaserHost"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-[#0c1626] font-mono text-xs uppercase tracking-wider text-[#dcecf4]">
      Loading canvas…
    </div>
  ),
});

const MAP_BG = "/onboarding/map-bg.png";

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

type WorldsByUsernameResponse = {
  id: string;
  slug: string;
  display_name: string | null;
  tile_w: number;
  tile_h: number;
  bg_palette: number;
  owner_user_id: string;
  owner_display_name: string;
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
  }>;
};

type Tap = {
  agent_id: string;
  display_name: string;
  canonical_id: string | null;
};

type Props = { params: Promise<{ username: string }> };

export default function VisitWorldPage({ params }: Props) {
  // Next 15+ requires unwrapping params with React.use().
  const { username } = usePromise(params);
  const router = useRouter();
  const [world, setWorld] = useState<WorldsByUsernameResponse | null>(null);
  const [agents, setAgents] = useState<WorldAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tap, setTap] = useState<Tap | null>(null);
  const [profileAgentId, setProfileAgentId] = useState<string | null>(null);
  const [mode, setMode] = useState<"own" | "visit" | null>(null);
  const [visitorName, setVisitorName] = useState("You");
  const [playerSprite, setPlayerSprite] = useState<{ url: string; type: "portrait" | "sheet" } | null>(null);

  // BGM
  const [bgmPlaying, setBgmPlaying] = useState(true);
  const bgmRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    (async () => {
      const auth = await fetchSession();
      if (!auth) {
        router.replace(`/login?next=/world/${encodeURIComponent(username)}`);
        return;
      }

      // Fetch visitor's display name + own sprite for the player character.
      try {
        const meRes = await apiGet<{ profile: { display_name: string | null } | null; home_world: { id: string } | null }>("/api/me");
        if (meRes.profile?.display_name) setVisitorName(meRes.profile.display_name);
        if (meRes.home_world?.id) {
          const { agents: myAgents } = await apiGet<{ agents: Array<{ canonical_id: string | null; sprite_url: string | null; portrait_url: string | null }> }>(
            `/api/worlds/${meRes.home_world.id}/agents`,
          );
          const self = myAgents.find((a: { canonical_id: string | null }) => a.canonical_id === null) as { sprite_sheet_url?: string | null } | undefined;
          if (self?.sprite_sheet_url) setPlayerSprite({ url: self.sprite_sheet_url, type: "sheet" });
        }
      } catch { /* best-effort */ }

      let w: WorldsByUsernameResponse;
      try {
        w = await apiGet<WorldsByUsernameResponse>(
          `/api/worlds/by-username/${encodeURIComponent(username)}`,
        );
        setWorld(w);
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 403) {
            setError(
              `You need to be friends with @${username} to visit their world. Send them a friend request from /friends.`,
            );
          } else if (err.status === 404) {
            setError(`No profile found for @${username}.`);
          } else {
            setError(`${err.status}: ${err.message}`);
          }
        } else {
          setError(String(err));
        }
        return;
      }

      try {
        const a = await apiGet<WorldAgentsResponse>(
          `/api/worlds/${encodeURIComponent(w.id)}/agents`,
        );
        setMode(a.mode);
        setAgents(
          a.agents.map((row) => ({
            id: row.id,
            display_name: row.display_name,
            canonical_id: row.canonical_id,
            sprite_url: row.sprite_url,
            portrait_url: row.portrait_url ?? null,
            sprite_sheet_url: row.sprite_sheet_url ?? null,
            tile_x: row.tile_x,
            tile_y: row.tile_y,
            placeholder_sprite_url: pickPlaceholder(row.id),
          })),
        );
      } catch (err) {
        const msg =
          err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
        setError(`agents query failed: ${msg}`);
      }
    })();
  }, [router, username]);

  // Same Phaser → React event bridge as own-world page.
  useEffect(() => {
    // Click on sprite → open profile panel.
    const onTap = (e: Event) => {
      const detail = (e as CustomEvent).detail as Tap | undefined;
      if (!detail) return;
      setProfileAgentId(detail.agent_id);
    };
    // Z key near agent → open RPG chat dialog.
    const onChat = (e: Event) => {
      const detail = (e as CustomEvent).detail as Tap | undefined;
      if (!detail) return;
      setTap(detail);
    };
    const onMapTap = () => { setTap(null); setProfileAgentId(null); };
    const onBPress = () => { setTap(null); setProfileAgentId(null); };
    window.addEventListener("phaser:agent-tap", onTap);
    window.addEventListener("phaser:agent-chat", onChat);
    window.addEventListener("phaser:map-tap", onMapTap);
    window.addEventListener("phaser:b-press", onBPress);
    return () => {
      window.removeEventListener("phaser:agent-tap", onTap);
      window.removeEventListener("phaser:agent-chat", onChat);
      window.removeEventListener("phaser:map-tap", onMapTap);
      window.removeEventListener("phaser:b-press", onBPress);
    };
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

  const resetCamera = () => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("phaser:reset-camera"));
    setTap(null);
  };

  const bgStyle = {
    backgroundImage: `linear-gradient(rgba(12, 22, 38, 0.78), rgba(12, 22, 38, 0.86)), url(${MAP_BG})`,
    backgroundPosition: "center top",
    backgroundSize: "cover",
  } as const;

  if (error) {
    return (
      <main
        className="relative h-dvh w-full overflow-hidden bg-[#0c1626]"
        style={bgStyle}
      >
        <BrandChip />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
          <div className="max-w-lg border-[3px] border-[#1f2a3c] bg-[#f7ddd7] p-4 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24] shadow-[4px_4px_0_#1f2a3c]">
            {error}
          </div>
          <div className="flex gap-2">
            <Link
              href="/friends"
              className="border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-3 py-2 font-mono text-[11px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
            >
              Friends
            </Link>
            <Link
              href="/world"
              className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2 font-mono text-[11px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
            >
              Your world
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (!world || agents === null) {
    return (
      <main
        className="relative h-dvh w-full overflow-hidden bg-[#0c1626]"
        style={bgStyle}
      >
        <BrandChip />
        <div className="absolute inset-0 flex items-center justify-center px-4">
          <div className="font-mono text-sm uppercase tracking-wider text-[#dcecf4]">
            Loading {world?.owner_display_name || username}'s world…
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#0c1626]">
      <PhaserHost agents={agents} mode="visit" playerName={visitorName} />

      <BrandChip />
      <WorldZoomControls />

      {/* Top-center "Visiting" pill — distinct from own-world chrome */}
      <div className="fixed top-3 left-1/2 z-30 -translate-x-1/2 sm:top-4">
        <div className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c]">
          Visiting · {world.owner_display_name}
        </div>
      </div>

      {/* Top-right HUD — consistent with /world */}
      <div className="fixed top-3 right-3 z-30 sm:top-4 sm:right-4">
        <div className="flex items-center gap-2">
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
            href="/worlds"
            className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-1.5 font-mono text-[10px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]"
          >
            All worlds
          </Link>
          <Link
            href="/world"
            className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
          >
            My World
          </Link>
          <Link
            href="/friends"
            className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
          >
            Friends
          </Link>
        </div>
      </div>

      {/* Posts feed removed — focus shifted to live room chat. */}

      {/* On-screen D-pad + A/B game controls */}
      <GameControls />


      {/* Back-to-overview button when focused */}
      {tap && (
        <div className="fixed top-16 left-1/2 z-30 -translate-x-1/2 sm:top-20">
          <button
            type="button"
            onClick={resetCamera}
            className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-2 font-mono text-xs font-bold uppercase tracking-[0.16em] text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c]"
          >
            ← Back to overview
          </button>
        </div>
      )}

      {tap && (
        <RPGDialog
          agentId={tap.agent_id}
          agentDisplayName={tap.display_name}
          canonicalId={tap.canonical_id}
          agentSpriteUrl={
            agents.find((a) => a.id === tap.agent_id)?.sprite_url ||
            agents.find((a) => a.id === tap.agent_id)?.placeholder_sprite_url ||
            "/team-office/characters/char_0.png"
          }
          agentPortraitUrl={
            agents.find((a) => a.id === tap.agent_id)?.portrait_url ?? null
          }
          onClose={resetCamera}
        />
      )}

      {profileAgentId && (
        <AgentProfilePanel
          agentId={profileAgentId}
          fallbackSpriteUrl={
            agents?.find((a) => a.id === profileAgentId)?.sprite_url ||
            agents?.find((a) => a.id === profileAgentId)?.placeholder_sprite_url ||
            "/team-office/characters/char_0.png"
          }
          onClose={() => setProfileAgentId(null)}
        />
      )}

      {mode && mode !== "visit" && (
        // Backend disagrees with the URL — shouldn't happen but useful in
        // case someone navigates to /world/<their-own-name>.
        <div className="fixed bottom-20 left-1/2 z-30 -translate-x-1/2 border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#6d2d24] shadow-[3px_3px_0_#1f2a3c]">
          That's your own world.{" "}
          <Link href="/world" className="underline">
            Go home
          </Link>
        </div>
      )}
    </main>
  );
}
