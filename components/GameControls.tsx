"use client";

// On-screen D-pad + A/B buttons with liquid glass (glassmorphism) styling.
// Dispatches `game:input` CustomEvents on window so the Phaser WorldScene
// can read them alongside keyboard input. Works on both touch and mouse.

import { useCallback, useEffect, useRef } from "react";

/** Dispatch an input event that WorldScene listens for. */
function send(key: string, pressed: boolean) {
  window.dispatchEvent(
    new CustomEvent("game:input", { detail: { key, pressed } }),
  );
}

type DpadDir = "up" | "down" | "left" | "right";

// Shared glass styling — Tailwind classes applied to every control button.
const GLASS =
  "select-none border border-white/20 " +
  "bg-gradient-to-br from-white/[0.14] to-white/[0.04] " +
  "shadow-[0_8px_32px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-1px_0_rgba(0,0,0,0.06)] " +
  "backdrop-blur-[20px] backdrop-saturate-[180%] " +
  "active:from-white/[0.22] active:to-white/[0.10] " +
  "transition-colors duration-75";

/**
 * A single directional arrow button. Uses touch events (not click) to
 * avoid the 300 ms tap delay and to properly track press/release.
 */
function DpadButton({
  dir,
  children,
  className,
}: {
  dir: DpadDir;
  children: React.ReactNode;
  className?: string;
}) {
  const pressed = useRef(false);

  const down = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      e.preventDefault();
      if (!pressed.current) {
        pressed.current = true;
        send(dir, true);
      }
    },
    [dir],
  );

  const up = useCallback(() => {
    if (pressed.current) {
      pressed.current = false;
      send(dir, false);
    }
  }, [dir]);

  // Safety: release on unmount.
  useEffect(() => () => { if (pressed.current) send(dir, false); }, [dir]);

  return (
    <button
      type="button"
      aria-label={dir}
      onTouchStart={down}
      onTouchEnd={up}
      onTouchCancel={up}
      onMouseDown={down}
      onMouseUp={up}
      onMouseLeave={up}
      className={`${GLASS} ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

/** Action button (A or B). */
function ActionButton({
  label,
  inputKey,
  size,
  className,
}: {
  label: string;
  inputKey: "a" | "b";
  size: string;
  className?: string;
}) {
  const pressed = useRef(false);

  const down = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      e.preventDefault();
      if (!pressed.current) {
        pressed.current = true;
        send(inputKey, true);
      }
    },
    [inputKey],
  );

  const up = useCallback(() => {
    if (pressed.current) {
      pressed.current = false;
      send(inputKey, false);
    }
  }, [inputKey]);

  useEffect(() => () => { if (pressed.current) send(inputKey, false); }, [inputKey]);

  return (
    <button
      type="button"
      aria-label={`Button ${label}`}
      onTouchStart={down}
      onTouchEnd={up}
      onTouchCancel={up}
      onMouseDown={down}
      onMouseUp={up}
      onMouseLeave={up}
      className={`${GLASS} rounded-full ${size} flex items-center justify-center ${className ?? ""}`}
    >
      <span className="text-white/80 font-bold text-lg leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]">
        {label}
      </span>
    </button>
  );
}

export default function GameControls({ hidden = false }: { hidden?: boolean } = {}) {
  // Prevent touch scrolling on the control areas.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const prevent = (e: TouchEvent) => e.preventDefault();
    el.addEventListener("touchmove", prevent, { passive: false });
    return () => el.removeEventListener("touchmove", prevent);
  }, []);

  if (hidden) return null;

  return (
    <div
      ref={containerRef}
      className="fixed bottom-0 left-0 right-0 z-40 pointer-events-none pb-6 px-4 sm:px-6"
    >
      <div className="flex items-end justify-between max-w-2xl mx-auto">
        {/* ── D-pad ─────────────────────────────────────────────── */}
        <div className="pointer-events-auto relative w-[136px] h-[136px]">
          {/* Up */}
          <DpadButton
            dir="up"
            className="absolute top-0 left-1/2 -translate-x-1/2 w-[44px] h-[44px] rounded-t-xl rounded-b-lg flex items-center justify-center"
          >
            <svg width="18" height="12" viewBox="0 0 18 12" className="fill-white/70 drop-shadow-sm">
              <path d="M9 0L18 12H0z" />
            </svg>
          </DpadButton>

          {/* Down */}
          <DpadButton
            dir="down"
            className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[44px] h-[44px] rounded-b-xl rounded-t-lg flex items-center justify-center"
          >
            <svg width="18" height="12" viewBox="0 0 18 12" className="fill-white/70 drop-shadow-sm rotate-180">
              <path d="M9 0L18 12H0z" />
            </svg>
          </DpadButton>

          {/* Left */}
          <DpadButton
            dir="left"
            className="absolute left-0 top-1/2 -translate-y-1/2 w-[44px] h-[44px] rounded-l-xl rounded-r-lg flex items-center justify-center"
          >
            <svg width="12" height="18" viewBox="0 0 12 18" className="fill-white/70 drop-shadow-sm">
              <path d="M0 9L12 0v18z" />
            </svg>
          </DpadButton>

          {/* Right */}
          <DpadButton
            dir="right"
            className="absolute right-0 top-1/2 -translate-y-1/2 w-[44px] h-[44px] rounded-r-xl rounded-l-lg flex items-center justify-center"
          >
            <svg width="12" height="18" viewBox="0 0 12 18" className="fill-white/70 drop-shadow-sm rotate-180">
              <path d="M0 9L12 0v18z" />
            </svg>
          </DpadButton>

          {/* Center dot */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[40px] h-[40px] rounded-lg bg-white/[0.06] border border-white/10" />
        </div>

        {/* ── A & B buttons ─────────────────────────────────────── */}
        <div className="pointer-events-auto flex items-center gap-3">
          <ActionButton
            label="X"
            inputKey="b"
            size="w-[52px] h-[52px]"
            className="mb-8"
          />
          <ActionButton
            label="Z"
            inputKey="a"
            size="w-[60px] h-[60px]"
            className="mb-2"
          />
        </div>
      </div>
    </div>
  );
}
