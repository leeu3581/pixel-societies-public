"use client";

// In-world graph overlay. Mounts on top of the Phaser canvas in
// /world so the user never leaves their gallery to view their wiki
// graph. Brutalist pixel-societies chrome (3px border, mono uppercase
// chips, hard shadow) — no a social virtual world editorial cream.
//
// Reads /api/me/world-graph (the same DB-backed endpoint /graph uses);
// renders a force-directed canvas with click-to-focus + group toggles.
// Lighter than /graph (no markdown preview drawer, no semantic search
// — that lives on the dedicated /graph page).

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiGet, ApiError } from "@/lib/api";
import { apiUrl } from "@/lib/backend";
import { photoForAgent } from "@/lib/profile-photos";
import type { WorldAgent } from "@/components/PhaserHost";
import MarkdownPreview from "@/components/MarkdownPreview";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d").then((module) => module.default<GraphNode, GraphLink>), { ssr: false });

type GraphNode = {
  id: string;
  label: string;
  group: "hub" | "personality" | "topic" | "external";
  color: string;
  agentId?: string;
  agentName?: string;
  size: number;
  privateMemory?: boolean;
  photoUrl?: string;
  markdown?: string;
  insightId?: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
};

type GraphLink = { source: string | GraphNode; target: string | GraphNode };
type GraphData = { nodes: GraphNode[]; links: GraphLink[] };

const GROUPS: Array<{ id: GraphNode["group"]; label: string }> = [
  { id: "hub", label: "People" },
  { id: "personality", label: "Personalities" },
  { id: "topic", label: "Topics" },
  { id: "external", label: "External" },
];

type Props = {
  onClose: () => void;
  // If provided, clicking a hub also opens the full AgentProfilePanel
  // / chat drawer in the parent /world page. Pass the world's agent
  // list so we can resolve canonical_id → row UUID.
  worldAgents?: WorldAgent[];
  onOpenAgent?: (agentId: string) => void;
};

export default function WorldGraphOverlay({ onClose, worldAgents, onOpenAgent }: Props) {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Set<GraphNode["group"]>>(
    () => new Set(GROUPS.map((g) => g.id)),
  );
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [pageMd, setPageMd] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [photos, setPhotos] = useState<Record<string, HTMLImageElement>>({});

  // Load graph
  useEffect(() => {
    apiGet<GraphData>("/api/me/world-graph")
      .then((d) => setData(d))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e)),
      );
  }, []);

  // Pre-load portrait photos for hub nodes so the canvas can draw them.
  useEffect(() => {
    if (!data) return;
    const map: Record<string, HTMLImageElement> = {};
    for (const n of data.nodes) {
      if (n.group !== "hub") continue;
      const url = n.photoUrl || photoForAgent(n.agentId);
      if (!url) continue;
      const img = new Image();
      img.src = url;
      map[n.id] = img;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize the existing canvas image cache
    setPhotos(map);
  }, [data]);

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Track container size
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const filtered: GraphData = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    const visible = new Set(
      data.nodes.filter((n) => active.has(n.group)).map((n) => n.id),
    );
    return {
      nodes: data.nodes.filter((n) => visible.has(n.id)),
      links: data.links.filter((l) => {
        const s = typeof l.source === "string" ? l.source : l.source.id;
        const t = typeof l.target === "string" ? l.target : l.target.id;
        return visible.has(s) && visible.has(t);
      }),
    };
  }, [data, active]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    if (data) for (const n of data.nodes) c[n.group] = (c[n.group] ?? 0) + 1;
    return c;
  }, [data]);

  // Set of node ids connected to the currently selected node — used to
  // light up topic + external labels around a hub when you click it.
  const neighbours = useMemo(() => {
    if (!data || !selected) return new Set<string>();
    const ids = new Set<string>();
    for (const l of data.links) {
      const sId = typeof l.source === "string" ? l.source : l.source.id;
      const tId = typeof l.target === "string" ? l.target : l.target.id;
      if (sId === selected.id) ids.add(tId);
      else if (tId === selected.id) ids.add(sId);
    }
    return ids;
  }, [data, selected]);

  // Topic + personality node labels grouped under the selected hub —
  // surfaces "Joon's pages" in the side card.
  const neighbourNodes = useMemo(() => {
    if (!data || !selected) return [] as GraphNode[];
    return data.nodes.filter((n) => neighbours.has(n.id));
  }, [data, selected, neighbours]);

  // Resolve a hub node's canonical_id → public.agents row id so we
  // can hand off to the parent's chat / profile drawer.
  const resolveAgentRowId = useCallback(
    (n: GraphNode): string | null => {
      if (!worldAgents) return null;
      // Custom hub nodes encode the row id directly in `agentId`.
      const direct = worldAgents.find((a) => a.id === n.agentId);
      if (direct) return direct.id;
      // Canonical hub: match by canonical_id, else by display_name.
      const byCanon = worldAgents.find((a) => a.canonical_id === n.agentId);
      if (byCanon) return byCanon.id;
      const byName = worldAgents.find(
        (a) => a.display_name.toLowerCase() === (n.agentName ?? "").toLowerCase(),
      );
      return byName ? byName.id : null;
    },
    [worldAgents],
  );

  const toggleGroup = (g: GraphNode["group"]) => {
    setActive((prev) => {
      const next = new Set(prev);
      next.has(g) ? next.delete(g) : next.add(g);
      return next;
    });
  };

  const onNodeClick = useCallback(
    (n: GraphNode) => {
      setSelected(n);
      const fg = fgRef.current;
      if (fg && typeof n.x === "number" && typeof n.y === "number") {
        fg.centerAt(n.x, n.y, 600);
        fg.zoom(2.4, 600);
      }
    },
    [],
  );

  // Fetch the wiki page markdown for the selected node. /api/wiki_page
  // is unauth-public and reads from backend/data/wikis/<id>.md. Custom
  // (non-canonical) hubs and external ghosts have no committed wiki —
  // skip silently in those cases.
  useEffect(() => {
    if (!selected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the existing preview when selection changes
      setPageMd(null);
      return;
    }
    if (selected.privateMemory) {
      setPageLoading(false);
      setPageMd(selected.markdown ?? null);
      return;
    }
    if (selected.group === "external" || selected.id.startsWith("_custom/")) {
      setPageMd(null);
      return;
    }
    let cancelled = false;
    setPageLoading(true);
    setPageMd(null);
    fetch(apiUrl(`/api/wiki_page?id=${encodeURIComponent(selected.id)}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { exists?: boolean; markdown?: string }) => {
        if (cancelled) return;
        setPageMd(d.exists && d.markdown ? d.markdown : null);
      })
      .catch(() => {
        if (cancelled) return;
        setPageMd(null);
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="ph-no-capture ph-mask fixed inset-3 z-40 flex flex-col border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] shadow-[6px_6px_0_#1f2a3c] backdrop-blur-sm sm:inset-4">
      {/* Header — stacks on mobile (title row + chip row), single row sm+. */}
      <header className="flex flex-col gap-2 border-b-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-3">
        {/* Title segment with always-visible close on mobile */}
        <div className="flex items-start justify-between gap-2 sm:items-center">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="border-[3px] border-[#1f2a3c] bg-[#e8d6ff] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] shadow-[3px_3px_0_#1f2a3c] sm:px-3 sm:py-2">
              ✦ Wiki graph
            </span>
            {data && (
              <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#637387] sm:text-[10px] sm:tracking-[0.16em]">
                {data.nodes.length} · {data.links.length}
                <span className="hidden sm:inline"> nodes · edges · live</span>
              </span>
            )}
          </div>
          {/* Mobile-only close — keeps a tappable target while filter chips wrap below */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] sm:hidden"
          >
            ✕
          </button>
        </div>

        {/* Filter chips + desktop close */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {GROUPS.map((g) => {
            const on = active.has(g.id);
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => toggleGroup(g.id)}
                title={`${counts[g.id] ?? 0} ${g.label.toLowerCase()}`}
                className={
                  "border-[2px] border-[#1f2a3c] px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] " +
                  (on ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#f6f4ea] text-[#1f2a3c]")
                }
              >
                {g.label} {counts[g.id] ?? 0}
              </button>
            );
          })}
          <button
            type="button"
            onClick={onClose}
            className="hidden border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] sm:inline-flex"
          >
            ✕ Close
          </button>
        </div>
      </header>

      {/* Body: canvas on the left, optional side panel on the right when
          a node is selected (full agent profile on hubs; just label
          context on topics). On mobile the side panel slides up from
          the bottom over the canvas instead of squeezing it. */}
      <div className="relative flex flex-1 min-h-0">

      {/* Canvas */}
      <div ref={wrapRef} className="relative flex-1 overflow-hidden bg-[linear-gradient(180deg,#dcecf4_0%,#f6f4ea_100%)]">
        {error && (
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div className="border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24] shadow-[3px_3px_0_#1f2a3c]">
              Graph load failed: {error}
            </div>
          </div>
        )}

        {!data && !error && (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-[11px] uppercase tracking-wider text-[#637387]">
            Loading…
          </div>
        )}

        {data && size.w > 0 && (
          <ForceGraph2D
            ref={fgRef}
            graphData={filtered}
            width={size.w}
            height={size.h}
            backgroundColor="rgba(0,0,0,0)"
            nodeRelSize={5}
            nodeId="id"
            nodeLabel={(n: GraphNode) => n.label}
            linkColor={() => "rgba(31,42,60,0.18)"}
            linkWidth={(l: GraphLink) => {
              const sId = typeof l.source === "string" ? l.source : l.source.id;
              const tId = typeof l.target === "string" ? l.target : l.target.id;
              if (selected && (sId === selected.id || tId === selected.id)) return 1.6;
              return 0.6;
            }}
            onNodeHover={(n: GraphNode | null) => setHovered(n)}
            onNodeClick={(n: GraphNode) => onNodeClick(n)}
            cooldownTicks={120}
            onEngineStop={() => fgRef.current?.zoomToFit?.(600, 60)}
            nodeCanvasObject={(node: GraphNode, ctx, scale) => {
              const x = node.x ?? 0;
              const y = node.y ?? 0;
              const r = node.size / Math.max(1, Math.sqrt(scale));

              // Hub nodes: portrait if available, else solid disc
              if (node.group === "hub" && photos[node.id]) {
                const img = photos[node.id];
                ctx.save();
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.closePath();
                ctx.clip();
                ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
                ctx.restore();
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.lineWidth = 2;
                ctx.strokeStyle = node.color;
                ctx.stroke();
              } else {
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fillStyle = node.color;
                ctx.fill();
                if (node.group === "hub") {
                  ctx.lineWidth = 2;
                  ctx.strokeStyle = "#1f2a3c";
                  ctx.stroke();
                }
              }

              // Label rules:
              // - hubs: always
              // - hovered or selected: always
              // - neighbour of selected: show too (so clicking Joon
              //   surfaces all his topic pages)
              const showLabel =
                node.group === "hub" ||
                hovered?.id === node.id ||
                selected?.id === node.id ||
                neighbours.has(node.id);
              if (showLabel) {
                ctx.font = `${Math.max(10, 11 / Math.sqrt(scale))}px ui-monospace, monospace`;
                ctx.fillStyle = "#1f2a3c";
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillText(node.label, x, y + r + 4);
              }
            }}
          />
        )}

      </div>

      {/* Right side panel: full profile + rendered wiki page when a
          node is selected. Hub click → portrait, name, connected pages
          list, Chat button + Joon.md (or hub markdown) inline. Topic
          click → parent agent + that topic's markdown. */}
      {selected && (
        <aside className="absolute inset-x-0 bottom-0 top-[40%] z-10 flex flex-col border-t-[3px] border-[#1f2a3c] bg-[#fffaf0] sm:relative sm:inset-auto sm:z-auto sm:w-[min(440px,40vw)] sm:min-w-[320px] sm:border-l-[3px] sm:border-t-0">
          {/* Side panel header */}
          <div className="flex items-center justify-between gap-2 border-b-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2">
            <span
              className={
                "border-[2px] border-[#1f2a3c] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.16em] shadow-[2px_2px_0_#1f2a3c] " +
                (selected.group === "hub"
                  ? "bg-[#ffe17d]"
                  : selected.group === "personality"
                    ? "bg-[#e8d6ff]"
                    : selected.group === "topic"
                      ? "bg-[#d6f4d6]"
                      : "bg-[#f6f4ea]")
              }
            >
              {selected.privateMemory ? "Private understanding" : selected.group}
            </span>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="border-[2px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-0.5 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c]"
            >
              ✕ Close
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {/* Hero — portrait + name + subtitle (hubs only) */}
            {selected.group === "hub" && (
              <div className="mb-4 flex items-start gap-3">
                {(selected.photoUrl || photoForAgent(selected.agentId)) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={(selected.photoUrl || photoForAgent(selected.agentId))!}
                    alt={selected.agentName ?? selected.label}
                    className="h-[88px] w-[88px] flex-none border-[3px] border-[#1f2a3c] object-cover shadow-[3px_3px_0_#1f2a3c]"
                  />
                ) : (
                  <div
                    className="h-[88px] w-[88px] flex-none border-[3px] border-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c]"
                    style={{ backgroundColor: selected.color }}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xl font-bold leading-tight text-[#1f2a3c]">
                    {selected.agentName ?? selected.label}
                  </div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[#7f8b98]">
                    {neighbourNodes.length} connected page
                    {neighbourNodes.length === 1 ? "" : "s"}
                  </div>
                  {onOpenAgent &&
                    (() => {
                      const rowId = resolveAgentRowId(selected);
                      if (!rowId) return null;
                      return (
                        <button
                          type="button"
                          onClick={() => {
                            onOpenAgent(rowId);
                            onClose();
                          }}
                          className="mt-2 border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
                        >
                          Open chat
                        </button>
                      );
                    })()}
                </div>
              </div>
            )}

            {/* Non-hub headline (topic / personality) */}
            {selected.group !== "hub" && (
              <div className="mb-3">
                <div className="text-lg font-bold leading-tight text-[#1f2a3c]">
                  {selected.label}
                </div>
                {selected.agentName && (
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#7f8b98]">
                    in {selected.agentName}&apos;s wiki
                  </div>
                )}
              </div>
            )}

            {selected.privateMemory && <a href="/profile#understanding" className="mb-3 block text-sm underline">Review, correct or approve this understanding</a>}
            {/* Wiki page markdown — the headline content the user wanted
                back from a social virtual world (Joon's bio, topics, key
                relationships, projects, recurring tensions, etc.) */}
            {pageLoading && (
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
                Loading wiki page…
              </div>
            )}
            {!pageLoading && pageMd && (
              <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-3 shadow-[3px_3px_0_#1f2a3c]">
                <MarkdownPreview text={pageMd} />
              </div>
            )}
            {!pageLoading && !pageMd && selected.group !== "external" && (
              <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
                No wiki page committed for this node.
              </p>
            )}

            {/* Connected pages list under hubs (always visible — clicking
                jumps to the page and re-fetches its markdown). */}
            {selected.group === "hub" && neighbourNodes.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]">
                  Connected pages
                </p>
                <div className="space-y-1">
                  {neighbourNodes.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => onNodeClick(n)}
                      className="flex w-full items-center gap-2 border-[1px] border-[#cdd5e0] bg-[#f6f4ea] px-2 py-1 text-left text-[11px] hover:bg-[#fffaf0]"
                    >
                      <span
                        className="inline-block h-2 w-2 flex-none rounded-full"
                        style={{ backgroundColor: n.color }}
                      />
                      <span className="truncate">{n.label}</span>
                      <span className="ml-auto flex-none font-mono text-[9px] uppercase text-[#7f8b98]">
                        {n.group}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      )}
      </div>
    </div>
  );
}
