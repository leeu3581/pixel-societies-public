"use client";

import { useEffect, useRef, useState } from "react";

type PixelOfficeAgent = {
  id: string;
  name: string;
  role: string;
  description: string;
  color: string;
};

type OfficeInstance = {
  load: () => Promise<void>;
  start: () => void;
  stop?: () => void;
  destroy?: () => void;
  showBubble?: (agentId: string, text: string, durationMs?: number) => void;
};

type PixelOfficeCtor = new (opts: {
  canvas: HTMLCanvasElement;
  agents: PixelOfficeAgent[];
  onAgentClick?: (agent: PixelOfficeAgent) => void;
  fullscreen?: boolean;
  fitMode?: "contain" | null;
  layoutSrc?: string | null;
  heroSrc?: string | null;
}) => OfficeInstance;

export default function PixelOffice({
  agents,
  onAgentClick,
  fitMode,
  layoutSrc,
}: {
  agents: PixelOfficeAgent[];
  onAgentClick: (agent: PixelOfficeAgent) => void;
  fitMode?: "contain";
  layoutSrc?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const officeRef = useRef<OfficeInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!canvasRef.current || agents.length === 0) return;
    let cancelled = false;

    (async () => {
      try {
        const mod = (await import("./office-engine.js")) as {
          PixelOffice: PixelOfficeCtor;
        };
        if (cancelled || !canvasRef.current) return;
        const office = new mod.PixelOffice({
          canvas: canvasRef.current,
          agents,
          onAgentClick,
          fullscreen: !fitMode,
          fitMode: fitMode ?? null,
          layoutSrc: layoutSrc ?? null,
        });
        await office.load();
        if (cancelled) return;
        office.start();
        officeRef.current = office;
        requestAnimationFrame(() => {
          if (cancelled) return;
          setLoading(false);
          // Centre the horizontal scroll on load so the visitor lands
          // looking at the middle of the cityscape instead of the left
          // edge. Only runs once, then the user can scroll freely.
          const s = scrollerRef.current;
          if (s) {
            const max = s.scrollWidth - s.clientWidth;
            if (max > 0) s.scrollLeft = Math.round(max / 2);
          }
        });
      } catch (err) {
        console.error("Pixel office failed to load:", err);
        setError(err instanceof Error ? err.message : "Failed to load office");
      }
    })();

    return () => {
      cancelled = true;
      if (officeRef.current?.stop) officeRef.current.stop();
      if (officeRef.current?.destroy) officeRef.current.destroy();
      officeRef.current = null;
    };
  }, [agents, onAgentClick, fitMode, layoutSrc]);

  if (error) return null;

  return (
    <div
      ref={scrollerRef}
      className={
        fitMode === "contain"
          ? "fixed inset-0 flex items-center justify-center overflow-hidden bg-black"
          : "fixed inset-0 overflow-x-auto overflow-y-hidden bg-black"
      }
    >
      <canvas
        ref={canvasRef}
        className={fitMode === "contain" ? "block" : "block h-dvh"}
      />
      {loading && (
        <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-black">
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-[color-mix(in_srgb,var(--primary)_40%,transparent)] border-t-[var(--primary)]"
            aria-hidden
          />
          <div className="text-white text-sm">Loading Crowdsource Intelligence…</div>
        </div>
      )}
    </div>
  );
}
