"use client";

// React wrapper that owns the Phaser Game lifecycle. Mounts on its
// container <div>, tears down cleanly on unmount, and re-mounts when the
// agents prop changes (cheap because there are only a handful of agents).
//
// Imported via next/dynamic({ ssr: false }) so Phaser only ever runs in
// the browser — Phaser pulls in canvas/WebGL globals that don't exist in
// Node and would break Next's RSC compile.

import { useEffect, useRef, useState } from "react";
// Namespace import: phaser doesn't ship a default export under
// webpack-mode builds (Next.js 16 + `next build --webpack`).
import * as Phaser from "phaser";
import {
  TILE_SIZE,
  WorldAgent,
  WorldMode,
  WorldScene,
} from "@/lib/phaser/WorldScene";

type Props = {
  agents: WorldAgent[];
  mode?: WorldMode;
  playerName?: string;
  /** URL for the player's own sprite (portrait or spritesheet).
   *  When set, replaces the default char_0.png stock sprite. */
  playerSpriteUrl?: string | null;
  /** Whether playerSpriteUrl is a portrait (single image) or sheet. */
  playerSpriteType?: "portrait" | "sheet" | null;
};

export default function PhaserHost({ agents, mode = "own", playerName, playerSpriteUrl, playerSpriteType }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [ready, setReady] = useState(false);
  // Track whether the game-creation effect has run this mount cycle so
  // the agents-change effect can skip its first invocation — the game
  // creation effect already passed the initial agents to the scene. A
  // spurious restart during preload is what caused the green "missing
  // texture" diamonds: the restart interrupted in-flight asset loads,
  // and the dedup Set (`__queued_keys`) prevented them from re-queuing.
  const mountedRef = useRef(false);

  // Listen for the scene-ready event fired after create() finishes.
  useEffect(() => {
    const onReady = () => setReady(true);
    window.addEventListener("phaser:scene-ready", onReady);
    return () => window.removeEventListener("phaser:scene-ready", onReady);
  }, []);

  // (No global capture-phase keyboard guard here — `removeCapture`
  // on WorldScene already stops Phaser preventDefault'ing the keys
  // we care about, and individual inputs handle their own
  // stopPropagation for redundancy. A capture-phase guard would
  // also block React's event delegation, breaking Enter-to-send in
  // the room chat.)

  useEffect(() => {
    if (!hostRef.current) return;
    if (gameRef.current) return; // Strict-mode double-invoke guard.

    // Scale.RESIZE means the canvas always matches the parent's pixel
    // dims; the camera handles "fit the world in" via getOverviewZoom().
    const w = hostRef.current.clientWidth || window.innerWidth;
    const h = hostRef.current.clientHeight || window.innerHeight;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: hostRef.current,
      width: w,
      height: h,
      backgroundColor: "#0c1626",
      pixelArt: true,
      roundPixels: true,
      fps: { target: 60 },
      input: { keyboard: true },
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.NO_CENTER,
      },
    });

    game.scene.add("WorldScene", WorldScene, true, { agents, mode, playerName, playerSpriteUrl, playerSpriteType });

    gameRef.current = game;
    mountedRef.current = true;

    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
      mountedRef.current = false;
    };
    // We deliberately mount once and rely on scene.restart() to refresh
    // the agents list (see effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the agents list changes (e.g. a sprite_url just landed), restart
  // the running scene with new data. Skip the very first invocation —
  // the game creation effect already started the scene with these agents.
  // Also skip if the serialized data is identical (guards against parent
  // components passing a new array reference with unchanged data).
  const skipNextRestart = useRef(true);
  const prevSnapshotRef = useRef("");
  useEffect(() => {
    if (skipNextRestart.current) {
      skipNextRestart.current = false;
      prevSnapshotRef.current = JSON.stringify(agents);
      return;
    }
    const snap = JSON.stringify(agents);
    if (snap === prevSnapshotRef.current) return;
    prevSnapshotRef.current = snap;

    setReady(false); // re-show loading overlay during restart
    const game = gameRef.current;
    if (!game) return;
    const scene = game.scene.getScene("WorldScene");
    if (!scene) return;
    scene.scene.restart({ agents, mode, playerName, playerSpriteUrl, playerSpriteType });
  }, [agents, mode, playerName, playerSpriteUrl, playerSpriteType]);

  return (
    <>
      <div
        ref={hostRef}
        className="absolute inset-0 bg-[#0c1626]"
        style={{ imageRendering: "pixelated" }}
        aria-label="Pixel world"
      />
      {/* Loading overlay — covers the canvas until assets are painted. */}
      {!ready && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0c1626]">
          <div className="flex flex-col items-center gap-3">
            <div className="h-3 w-32 overflow-hidden border-[3px] border-[#1f2a3c] bg-[#1a2636] shadow-[3px_3px_0_#0a1018]">
              <div className="h-full w-full origin-left animate-pulse bg-[#ffe17d]" />
            </div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#637387]">
              Loading world...
            </p>
          </div>
        </div>
      )}
    </>
  );
}

// Re-export so callers don't need a separate import line.
export type { WorldAgent };
export { TILE_SIZE };
