"use client";

// Zoom +/- controls with liquid glass (glassmorphism) styling,
// consistent with GameControls.

function dispatchZoom(type: "phaser:zoom-in" | "phaser:zoom-out") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(type));
}

const GLASS =
  "select-none border border-white/20 " +
  "bg-gradient-to-br from-white/[0.14] to-white/[0.04] " +
  "shadow-[0_8px_32px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-1px_0_rgba(0,0,0,0.06)] " +
  "backdrop-blur-[20px] backdrop-saturate-[180%] " +
  "active:from-white/[0.22] active:to-white/[0.10] " +
  "transition-colors duration-75";

export default function WorldZoomControls() {
  return (
    <div className="fixed left-4 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1.5">
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => dispatchZoom("phaser:zoom-in")}
        className={`${GLASS} flex h-10 w-10 items-center justify-center rounded-xl`}
      >
        <span className="text-white/80 text-lg font-bold leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]">+</span>
      </button>
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => dispatchZoom("phaser:zoom-out")}
        className={`${GLASS} flex h-10 w-10 items-center justify-center rounded-xl`}
      >
        <span className="text-white/80 text-lg font-bold leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]">−</span>
      </button>
    </div>
  );
}
