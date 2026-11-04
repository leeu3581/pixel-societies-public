"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Tile = 0 | 1 | 2 | 3 | 4;

type Layout = {
  version?: number;
  image: string;
  imageWidth: number;
  imageHeight: number;
  layoutRevision?: number;
  tileLegend?: Record<string, string>;
  tileCols?: number;
  tileRows?: number;
  tileWidth?: number;
  tileHeight?: number;
  tiles?: number[];
  walkableZones?: unknown[];
  [k: string]: unknown;
};

type Brush = { value: Tile; label: string; key: string; rgba: string; swatch: string };

const BRUSHES: Brush[] = [
  { value: 0, label: "Floor",  key: "1", rgba: "rgba(0,0,0,0)",            swatch: "#f6f4ea" },
  { value: 1, label: "Wall",   key: "2", rgba: "rgba(220, 38, 38, 0.55)",  swatch: "#dc2626" },
  { value: 2, label: "Grass",  key: "3", rgba: "rgba(22, 101, 52, 0.55)",  swatch: "#166534" },
  { value: 3, label: "Water",  key: "4", rgba: "rgba(37, 99, 235, 0.55)",  swatch: "#2563eb" },
  { value: 4, label: "Portal", key: "5", rgba: "rgba(168, 85, 247, 0.65)", swatch: "#a855f7" },
];

const TILE_LEGEND: Record<string, string> = {
  "0": "floor — walkable path, plaza, lawn, or open courtyard",
  "1": "building / wall — impassable structure",
  "2": "off-island grass / forest border — impassable",
  "3": "water / canal — impassable",
  "4": "portal entryway — agents teleport between paired portal cells (pairing wired separately)",
};

const PRESETS: ReadonlyArray<{ cols: number; rows: number; label?: string }> = [
  { cols: 32,  rows: 14,  label: "coarse" },
  { cols: 64,  rows: 28 },
  { cols: 128, rows: 56 },
  { cols: 256, rows: 112, label: "default" },
  { cols: 384, rows: 168, label: "fine" },
  { cols: 528, rows: 224, label: "ultra" },
];

const DEFAULT_COLS = 256;
const DEFAULT_ROWS = 112;

function clampTile(t: number): Tile {
  return t === 1 || t === 2 || t === 3 || t === 4 ? t : 0;
}

// Nearest-neighbor resample so switching grid resolution preserves work.
// Upscaling (coarse → fine) turns each fat cell into a block of same-value
// fine cells, which is exactly the "rough-in then detail" workflow.
// Downscaling samples each coarse cell from the center of its source region,
// so isolated fine paint may drop out — that's expected when reducing detail.
function resampleTiles(
  src: Tile[],
  srcCols: number,
  srcRows: number,
  dstCols: number,
  dstRows: number,
): Tile[] {
  if (srcCols === dstCols && srcRows === dstRows) return src.slice();
  const out: Tile[] = new Array(dstCols * dstRows);
  for (let r = 0; r < dstRows; r++) {
    const sr = Math.min(srcRows - 1, Math.floor(((r + 0.5) * srcRows) / dstRows));
    for (let c = 0; c < dstCols; c++) {
      const sc = Math.min(srcCols - 1, Math.floor(((c + 0.5) * srcCols) / dstCols));
      out[r * dstCols + c] = src[sr * srcCols + sc] ?? 0;
    }
  }
  return out;
}

export default function MapEditorPage() {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [brush, setBrush] = useState<Tile>(1);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  const lastPaintedRef = useRef<number>(-1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/layout", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as Layout;
        if (cancelled) return;
        setLayout(d);
        const c = Number(d.tileCols);
        const rw = Number(d.tileRows);
        if (
          Number.isFinite(c) &&
          Number.isFinite(rw) &&
          Array.isArray(d.tiles) &&
          d.tiles.length === c * rw
        ) {
          setCols(c);
          setRows(rw);
          setTiles(d.tiles.map((t) => clampTile(Number(t))));
        } else {
          setTiles(Array.from({ length: DEFAULT_COLS * DEFAULT_ROWS }, () => 0 as Tile));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onUp = () => {
      draggingRef.current = false;
      lastPaintedRef.current = -1;
    };
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const idx = ["1", "2", "3", "4", "5"].indexOf(e.key);
      if (idx >= 0) {
        setBrush(idx as Tile);
        return;
      }
      if (e.key === "g" || e.key === "G") setShowGrid((v) => !v);
      if (e.key === "o" || e.key === "O") setShowOverlay((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Render tile overlay to a canvas at native cell resolution (1 px per cell).
  // CSS scales it up to image size with image-rendering: pixelated, so even
  // 528×224 = 118k cells redraws in <2 ms.
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || tiles.length !== cols * rows) return;
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cols, rows);
    for (let i = 0; i < tiles.length; i++) {
      const v = tiles[i];
      if (v === 0) continue;
      ctx.fillStyle = BRUSHES[v].rgba;
      const col = i % cols;
      const row = (i - col) / cols;
      ctx.fillRect(col, row, 1, 1);
    }
  }, [tiles, cols, rows]);

  const paintIndex = useCallback(
    (idx: number) => {
      if (idx === lastPaintedRef.current) return;
      lastPaintedRef.current = idx;
      setTiles((prev) => {
        if (prev[idx] === brush) return prev;
        const next = prev.slice();
        next[idx] = brush;
        return next;
      });
      setDirty(true);
    },
    [brush],
  );

  const paintAtClient = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const fx = (clientX - rect.left) / rect.width;
      const fy = (clientY - rect.top) / rect.height;
      if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return;
      const col = Math.min(cols - 1, Math.max(0, Math.floor(fx * cols)));
      const row = Math.min(rows - 1, Math.max(0, Math.floor(fy * rows)));
      paintIndex(row * cols + col);
    },
    [cols, rows, paintIndex],
  );

  const changeResolution = (newCols: number, newRows: number) => {
    if (newCols === cols && newRows === rows) return;
    const downsample = newCols < cols || newRows < rows;
    if (
      downsample &&
      tiles.some((t) => t !== 0) &&
      !confirm("Lowering grid resolution will sample one value per coarse cell — fine detail may be lost. Continue?")
    ) {
      return;
    }
    setTiles((prev) => resampleTiles(prev, cols, rows, newCols, newRows));
    setCols(newCols);
    setRows(newRows);
    setDirty(true);
  };

  const fillAll = (v: Tile) => {
    if (!confirm(`Fill the whole grid with ${BRUSHES[v].label}?`)) return;
    setTiles((prev) => prev.map(() => v));
    setDirty(true);
  };

  const reload = async () => {
    if (dirty && !confirm("Discard unsaved changes and reload from disk?")) return;
    try {
      const r = await fetch("/api/layout", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as Layout;
      setLayout(d);
      const c = Number(d.tileCols);
      const rw = Number(d.tileRows);
      if (
        Number.isFinite(c) &&
        Number.isFinite(rw) &&
        Array.isArray(d.tiles) &&
        d.tiles.length === c * rw
      ) {
        setCols(c);
        setRows(rw);
        setTiles(d.tiles.map((t) => clampTile(Number(t))));
      }
      setDirty(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "reload failed");
    }
  };

  const save = async () => {
    if (!layout || saving) return;
    setSaving(true);
    setError(null);
    try {
      const tileWidth = layout.imageWidth / cols;
      const tileHeight = layout.imageHeight / rows;
      const updated: Layout = {
        ...layout,
        layoutRevision: (Number(layout.layoutRevision) || 0) + 1,
        tileLegend: TILE_LEGEND,
        tileCols: cols,
        tileRows: rows,
        tileWidth: Math.round(tileWidth * 1000) / 1000,
        tileHeight: Math.round(tileHeight * 1000) / 1000,
        tiles: tiles.slice(),
      };
      const resp = await fetch("/api/layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${body}`);
      }
      setLayout(updated);
      setDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  const counts = useMemo(() => {
    const c: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const t of tiles) c[t] = (c[t] ?? 0) + 1;
    return c;
  }, [tiles]);

  if (error && !layout) {
    return <div className="p-8 text-[#dc2626]">Failed to load layout: {error}</div>;
  }
  if (!layout) {
    return <div className="p-8 text-[#0a0f1a]">Loading layout…</div>;
  }

  const tileWidthPx = layout.imageWidth / cols;
  const tileHeightPx = layout.imageHeight / rows;
  const showGridLines = showGrid && cols <= 96;

  return (
    <div className="min-h-screen bg-[#eef0fb] p-6 text-[#0a0f1a]">
      <div className="mx-auto max-w-[1800px]">
        <header className="mb-4 flex items-baseline gap-4">
          <h1 className="text-2xl font-bold">Map Editor</h1>
          <span className="text-[12px] opacity-70">
            {layout.image} · {layout.imageWidth}×{layout.imageHeight} · grid {cols}×{rows}
            {" "}· tile {tileWidthPx.toFixed(1)}×{tileHeightPx.toFixed(1)} px
            {" "}· rev {layout.layoutRevision ?? 0}
          </span>
        </header>

        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-sm border-[3px] border-[#1f2a3c] bg-[#f6f4ea] p-3 shadow-[3px_3px_0_#1f2a3c]">
          <div className="flex flex-wrap gap-1">
            {BRUSHES.map((b) => (
              <button
                key={b.value}
                onClick={() => setBrush(b.value)}
                className={`flex items-center gap-2 rounded-sm border-[2px] border-[#1f2a3c] px-3 py-1.5 text-[12px] font-bold ${
                  brush === b.value
                    ? "bg-[#1f2a3c] text-[#f6f4ea]"
                    : "bg-white hover:bg-[#fef3c7]"
                }`}
              >
                <span
                  className="inline-block h-3 w-3 rounded-sm border border-[#1f2a3c]"
                  style={{ background: b.swatch }}
                />
                {b.label}
                <span className="opacity-60">[{b.key}]</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1 border-l-[2px] border-[#1f2a3c] pl-3">
            <span className="text-[11px] uppercase tracking-wide opacity-70">Grid</span>
            {PRESETS.map((p) => (
              <button
                key={`${p.cols}x${p.rows}`}
                onClick={() => changeResolution(p.cols, p.rows)}
                className={`rounded-sm border-[2px] border-[#1f2a3c] px-2.5 py-1 text-[12px] font-bold ${
                  cols === p.cols && rows === p.rows
                    ? "bg-[#1f2a3c] text-[#f6f4ea]"
                    : "bg-white hover:bg-[#fef3c7]"
                }`}
                title={p.label}
              >
                {p.cols}×{p.rows}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowGrid((v) => !v)}
            className="rounded-sm border-[2px] border-[#1f2a3c] bg-white px-3 py-1 text-[12px] font-bold hover:bg-[#fef3c7]"
            title="Toggle grid lines [G] (only shown at ≤96 cols)"
          >
            Grid: {showGrid ? "on" : "off"}
          </button>
          <button
            onClick={() => setShowOverlay((v) => !v)}
            className="rounded-sm border-[2px] border-[#1f2a3c] bg-white px-3 py-1 text-[12px] font-bold hover:bg-[#fef3c7]"
            title="Toggle painted overlay [O]"
          >
            Overlay: {showOverlay ? "on" : "off"}
          </button>
          <button
            onClick={() => fillAll(0)}
            className="rounded-sm border-[2px] border-[#1f2a3c] bg-white px-3 py-1 text-[12px] font-bold hover:bg-[#fef3c7]"
          >
            Clear all
          </button>
          <button
            onClick={reload}
            className="rounded-sm border-[2px] border-[#1f2a3c] bg-white px-3 py-1 text-[12px] font-bold hover:bg-[#fef3c7]"
          >
            Reload
          </button>

          <div className="ml-auto flex items-center gap-3">
            {dirty ? (
              <span className="text-[11px] font-bold uppercase text-[#dc2626]">unsaved</span>
            ) : savedAt ? (
              <span className="text-[11px] uppercase text-[#15803d]">saved</span>
            ) : null}
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="rounded-sm border-[2px] border-[#1f2a3c] bg-[#1f2a3c] px-4 py-1.5 text-[12px] font-bold text-[#f6f4ea] hover:bg-black disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-sm border-[3px] border-[#dc2626] bg-[#fee2e2] p-3 text-[12px]">
            {error}
          </div>
        )}

        <div className="mb-2 text-[11px] opacity-70">
          Floor: {counts[0]} · Wall: {counts[1]} · Grass: {counts[2]} · Water: {counts[3]} · Portal: {counts[4]} · Total: {tiles.length}
        </div>

        <div
          className="relative w-full select-none rounded-sm border-[3px] border-[#1f2a3c] bg-black shadow-[3px_3px_0_#1f2a3c]"
          style={{ aspectRatio: `${layout.imageWidth} / ${layout.imageHeight}` }}
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            draggingRef.current = true;
            lastPaintedRef.current = -1;
            paintAtClient(e.clientX, e.clientY);
          }}
          onMouseMove={(e) => {
            if (draggingRef.current) paintAtClient(e.clientX, e.clientY);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={layout.image}
            alt="map"
            className="absolute inset-0 h-full w-full"
            draggable={false}
          />
          {showOverlay && (
            <canvas
              ref={overlayCanvasRef}
              className="absolute inset-0 h-full w-full"
              style={{ imageRendering: "pixelated", cursor: "crosshair" }}
            />
          )}
          {showGridLines && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage:
                  "linear-gradient(to right, rgba(0,0,0,0.18) 1px, transparent 1px)," +
                  "linear-gradient(to bottom, rgba(0,0,0,0.18) 1px, transparent 1px)",
                backgroundSize: `${100 / cols}% 100%, 100% ${100 / rows}%`,
              }}
            />
          )}
        </div>

        <p className="mt-3 text-[11px] opacity-70">
          Click & drag to paint with the selected brush.
          {" "}1/2/3/4/5 switch brush · G toggles grid lines (only shown at ≤96 cols) · O toggles painted overlay.
          {" "}Switching resolution preserves your paint (fine cells inherit the coarse cell they sit in; downscaling drops detail). Save writes back to{" "}
          <code>public/team-office/default-layout-1.json</code>.
        </p>
      </div>
    </div>
  );
}
