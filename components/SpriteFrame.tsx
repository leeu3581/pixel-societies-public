"use client";

// Render a SINGLE frame from a sprite sheet. Bundled placeholders are
// 7×3 sheets; generated Ai-Engine v2 sprites are 8×4 sheets. Without
// this component most UI surfaces render the whole sheet stretched into
// a portrait box.
//
// Phaser draws frame 0 (down-facing idle) by default; we mirror that
// in HTML with background-position. Pure CSS — no canvas, no
// JavaScript per-frame swap.

import type { CSSProperties } from "react";

const FRAME_W = 16;
const FRAME_H = 32;

type Props = {
  src: string;
  /** Display scale. 1 → 16×32, 2 → 32×64, 4 → 64×128, etc. */
  size?: number;
  /** Frame index 0..20. Default 0 = down-facing idle. */
  frame?: number;
  /** Defaults to auto-detecting generated Supabase sprite URLs. */
  sheet?: "placeholder" | "generated" | "auto";
  /** Extra pixels to shift the background up (positive = show more head). */
  nudgeUp?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
};

export default function SpriteFrame({
  src,
  size = 2,
  frame = 0,
  sheet = "auto",
  nudgeUp = 0,
  className = "",
  style,
  title,
}: Props) {
  const resolvedSheet =
    sheet === "auto"
      ? src.includes("/storage/v1/object/public/sprites/")
        ? "generated"
        : "placeholder"
      : sheet;
  const sheetCols = 7; // Both placeholder and generated are now 7 columns.
  const sheetRows = resolvedSheet === "generated" ? 4 : 3;
  const col = frame % sheetCols;
  const row = Math.floor(frame / sheetCols);
  const w = FRAME_W * size;
  const h = FRAME_H * size;
  return (
    <div
      role="img"
      aria-label={title}
      title={title}
      className={className}
      style={{
        width: w,
        height: h,
        backgroundImage: `url(${src})`,
        backgroundSize: `${sheetCols * w}px ${sheetRows * h}px`,
        backgroundPosition: `-${col * w}px -${Math.max(0, row * h - nudgeUp)}px`,
        backgroundRepeat: "no-repeat",
        imageRendering: "pixelated",
        ...style,
      }}
    />
  );
}
