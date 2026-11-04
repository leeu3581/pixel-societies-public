"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { apiUrl } from "@/lib/backend";
import { apiGet } from "@/lib/api";

// react-force-graph touches `window` immediately on import — load it
// client-only so Next's SSR doesn't choke.
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

type WikiPage = {
  id: string;
  exists: boolean;
  markdown: string;
  agent_id: string;
  stem: string;
};

// Small inline markdown renderer for the click-to-preview drawer.
// Handles the constructs the wiki actually uses: frontmatter, H1-H3,
// `-` bullets, `> blockquotes`, **bold**, *italic*, [[wikilink]],
// `inline code`. No tables / images / nested lists by design.
function MarkdownPreview({ text }: { text: string }) {
  // Strip leading frontmatter blocks (there can be more than one).
  let body = text;
  while (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end === -1) break;
    body = body.slice(end + 4).replace(/^\n+/, "");
  }

  const inlineRe = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[\[[^\]\n]+\]\]|`[^`\n]+`)/g;
  function inline(t: string, k0: string) {
    const out: React.ReactNode[] = [];
    let last = 0;
    let i = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineRe.exec(t)) !== null) {
      if (m.index > last) out.push(<span key={`${k0}-${i++}`}>{t.slice(last, m.index)}</span>);
      const tok = m[0];
      if (tok.startsWith("**")) {
        out.push(<strong key={`${k0}-${i++}`}>{tok.slice(2, -2)}</strong>);
      } else if (tok.startsWith("[[")) {
        const inner = tok.slice(2, -2);
        const display = inner.split("|")[1] || inner.split("|")[0];
        out.push(
          <span
            key={`${k0}-${i++}`}
            className="rounded-md bg-[var(--cream-soft)] px-1.5 py-[1px] font-mono text-[11px] text-[var(--ink)]"
          >
            {display}
          </span>,
        );
      } else if (tok.startsWith("`")) {
        out.push(
          <code
            key={`${k0}-${i++}`}
            className="rounded bg-[var(--cream-soft)] px-1 font-mono text-[11px]"
          >
            {tok.slice(1, -1)}
          </code>,
        );
      } else {
        out.push(<em key={`${k0}-${i++}`}>{tok.slice(1, -1)}</em>);
      }
      last = m.index + tok.length;
    }
    if (last < t.length) out.push(<span key={`${k0}-${i++}`}>{t.slice(last)}</span>);
    return out;
  }

  const lines = body.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{4,}\s+/.test(line)) {
      blocks.push(
        <h4
          key={key++}
          className="serif-display mt-3 mb-1 text-[12px] font-semibold uppercase tracking-wider text-[var(--ink-mute)]"
        >
          {line.replace(/^#+\s+/, "")}
        </h4>,
      );
      i++;
    } else if (line.startsWith("### ")) {
      blocks.push(
        <h3 key={key++} className="serif-display mt-3 mb-1 text-[14px] font-semibold text-[var(--ink)]">
          {line.slice(4)}
        </h3>,
      );
      i++;
    } else if (line.startsWith("## ")) {
      blocks.push(
        <h2 key={key++} className="serif-display mt-4 mb-1 text-[16px] font-semibold text-[var(--ink)]">
          {line.slice(3)}
        </h2>,
      );
      i++;
    } else if (line.startsWith("# ")) {
      blocks.push(
        <h1 key={key++} className="serif-display mt-2 mb-2 text-[20px] font-bold text-[var(--ink)]">
          {line.slice(2)}
        </h1>,
      );
      i++;
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul
          key={key++}
          className="my-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-[var(--ink-soft)]"
        >
          {items.map((it, idx) => (
            <li key={idx}>{inline(it, `b${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
    } else if (line.startsWith("> ")) {
      blocks.push(
        <blockquote
          key={key++}
          className="my-2 border-l-2 border-[rgba(26,20,16,0.18)] pl-3 text-[12px] italic text-[var(--ink-mute)]"
        >
          {inline(line.slice(2), `q${key}`)}
        </blockquote>,
      );
      i++;
    } else if (line.trim() === "") {
      i++;
    } else {
      const para: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !/^[#\->*]/.test(lines[i].trim())) {
        para.push(lines[i]);
        i++;
      }
      blocks.push(
        <p
          key={key++}
          className="my-2 text-[13px] leading-relaxed text-[var(--ink-soft)]"
        >
          {inline(para.join(" "), `p${key}`)}
        </p>,
      );
    }
  }
  return <div className="text-[var(--ink)]">{blocks}</div>;
}

type GraphLink = {
  source: string | GraphNode;
  target: string | GraphNode;
};

type GraphData = { nodes: GraphNode[]; links: GraphLink[] };

const GROUPS: Array<{ id: GraphNode["group"]; label: string }> = [
  { id: "hub", label: "People" },
  { id: "personality", label: "Personalities" },
  { id: "topic", label: "Topics" },
  { id: "external", label: "External" },
];

function linkEnd(end: string | GraphNode): string {
  return typeof end === "string" ? end : end.id;
}

// Render-radius per node — slightly larger than the physics size so
// labels and glows have room.
function radiusFor(n: GraphNode): number {
  if (n.group === "hub") return 14;
  if (n.group === "personality") return 6;
  if (n.group === "topic") return 4.5;
  return 2.6; // external
}

// Tweak these to taste — they're what make the graph feel "alive".
const PHYSICS = {
  chargeStrength: -85,        // node-to-node repulsion
  linkDistance: 32,           // ideal edge length
  linkStrength: 0.18,         // how hard edges pull
  velocityDecay: 0.32,        // friction (lower = bouncier, higher = settles fast)
  warmupTicks: 80,            // simulate this many ticks before drawing
};

// Photo map moved to lib/profile-photos.ts (single source of truth
// shared with AgentProfilePanel and any future UI that wants the
// a social virtual world-style portrait alongside the pixel sprite).
import { PROFILE_PHOTOS } from "@/lib/profile-photos";

export default function GraphView({ backendHost }: { backendHost: string }) {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Set<GraphNode["group"]>>(
    () => new Set(GROUPS.map((g) => g.id)),
  );
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GraphNode[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  // Agent photo map: agentId → photo URL (from /api/agents + fallback)
  const [agentPhotos, setAgentPhotos] = useState<Record<string, string>>({});
  // Pre-loaded HTMLImageElement cache for canvas drawing
  const loadedImgs = useRef<Record<string, HTMLImageElement>>({});

  // Fetch the markdown for whichever node is currently selected.
  // External nodes (no underlying file) skip the fetch.
  // Custom/ingested nodes load persona_md from the agent profile API.
  useEffect(() => {
    if (!selected) {
      setPage(null);
      return;
    }
    if (selected.privateMemory) {
      setPageLoading(false);
      setPage({ id: selected.id, exists: true, markdown: selected.markdown ?? "", agent_id: selected.agentId ?? "", stem: selected.label });
      return;
    }
    if (selected.group === "external") {
      setPage({
        id: selected.id,
        exists: false,
        markdown: "",
        agent_id: "",
        stem: selected.label,
      });
      return;
    }
    let cancelled = false;
    setPageLoading(true);
    setPage(null);

    // Custom (ingested) agents live in DB, not on disk — fetch their
    // persona_md from the profile API instead of the wiki_page endpoint.
    if (selected.id.startsWith("_custom/") && selected.agentId) {
      apiGet<{ persona_md?: string }>(`/api/agents/${encodeURIComponent(selected.agentId)}/profile`)
        .then((profile) => {
          if (cancelled) return;
          const md = profile.persona_md || "";
          setPage({
            id: selected.id,
            exists: !!md,
            markdown: md,
            agent_id: selected.agentId || "",
            stem: selected.label,
          });
        })
        .catch(() => {
          if (!cancelled) setPage({
            id: selected.id,
            exists: false,
            markdown: "",
            agent_id: "",
            stem: selected.label,
          });
        })
        .finally(() => {
          if (!cancelled) setPageLoading(false);
        });
    } else {
      const url = apiUrl(`/api/wiki_page?id=${encodeURIComponent(selected.id)}`);
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((p: WikiPage) => {
          if (!cancelled) setPage(p);
        })
        .catch((e) => {
          if (!cancelled) setPage({
            id: selected.id,
            exists: false,
            markdown: `*(failed to load: ${e.message})*`,
            agent_id: "",
            stem: "",
          });
        })
        .finally(() => {
          if (!cancelled) setPageLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [selected, backendHost]);

  // ── Load + size ───────────────────────────────────────────────
  // /api/me/world-graph is DB-backed and scoped to the caller's home
  // world: nodes are agents in `public.agents`, edges are wikilinks
  // inside agents.persona_md that resolve to another agent in the
  // same world. Replaces the old static /api/graph filesystem read.
  useEffect(() => {
    apiGet<GraphData & { photos?: Record<string, string> }>("/api/me/world-graph")
      .then((d) => {
        setData(d);
        // Build photo map from the graph response + static fallbacks.
        const map: Record<string, string> = {};
        if (d.photos) {
          for (const [id, url] of Object.entries(d.photos)) {
            map[id] = url;
          }
        }
        for (const node of d.nodes) {
          if (node.photoUrl) map[node.agentId || node.id] = node.photoUrl;
        }
        // Merge static fallbacks for canonical agents.
        for (const [id, url] of Object.entries(PROFILE_PHOTOS)) {
          if (!map[id]) map[id] = url;
        }
        setAgentPhotos(map);
        // Pre-load each photo as an HTMLImageElement for canvas drawing.
        for (const [id, src] of Object.entries(map)) {
          if (!loadedImgs.current[id]) {
            const img = new Image();
            // Only set crossOrigin for local paths — Supabase storage
            // URLs sometimes fail CORS preflight with the attribute set,
            // and we don't need canvas export so taint is fine.
            if (src.startsWith("/")) img.crossOrigin = "anonymous";
            img.src = src;
            img.onload = () => {
              loadedImgs.current[id] = img;
              fgRef.current?.d3ReheatSimulation?.();
            };
            img.onerror = () => {
              // Retry without crossOrigin if it failed.
              const retry = new Image();
              retry.src = src;
              retry.onload = () => {
                loadedImgs.current[id] = retry;
                fgRef.current?.d3ReheatSimulation?.();
              };
            };
          }
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setSize({ w: Math.max(320, cr.width), h: Math.max(400, cr.height) });
      }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // ── Filter visible by group ───────────────────────────────────
  const visible = useMemo<GraphData | null>(() => {
    if (!data) return null;
    const keep = new Set(data.nodes.filter((n) => active.has(n.group)).map((n) => n.id));
    return {
      nodes: data.nodes.filter((n) => keep.has(n.id)),
      links: data.links.filter((l) => keep.has(linkEnd(l.source)) && keep.has(linkEnd(l.target))),
    };
  }, [data, active]);

  // ── Adjacency (for hover focus mode) ──────────────────────────
  const adjacency = useMemo<Map<string, Set<string>>>(() => {
    const m = new Map<string, Set<string>>();
    if (!visible) return m;
    for (const n of visible.nodes) m.set(n.id, new Set());
    for (const l of visible.links) {
      const s = linkEnd(l.source);
      const t = linkEnd(l.target);
      m.get(s)?.add(t);
      m.get(t)?.add(s);
    }
    return m;
  }, [visible]);

  const focus = hovered ?? selected;
  const focusNeighbors = useMemo<Set<string>>(() => {
    if (!focus) return new Set();
    const s = new Set<string>([focus.id]);
    adjacency.get(focus.id)?.forEach((n) => s.add(n));
    return s;
  }, [focus, adjacency]);

  // ── Tune physics once graph mounts ────────────────────────────
  useEffect(() => {
    if (!fgRef.current || !visible) return;
    const charge = fgRef.current.d3Force("charge");
    if (charge) charge.strength(PHYSICS.chargeStrength);
    const link = fgRef.current.d3Force("link");
    if (link) link.distance(PHYSICS.linkDistance).strength(PHYSICS.linkStrength);
  }, [visible]);

  const counts = useMemo(() => {
    if (!data) return {} as Record<string, number>;
    const c: Record<string, number> = {};
    for (const n of data.nodes) c[n.group] = (c[n.group] ?? 0) + 1;
    return c;
  }, [data]);

  const toggleGroup = (g: GraphNode["group"]) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  // ── Search (semantic via LLM) ──────────────────────────────────
  const zoomToResults = useCallback((matches: GraphNode[]) => {
    if (matches.length === 0 || !fgRef.current) return;
    if (matches.length === 1) {
      const m = matches[0];
      if (m.x != null && m.y != null) {
        fgRef.current.centerAt(m.x, m.y, 800);
        fgRef.current.zoom(3, 800);
      }
      setSelected(m);
    } else {
      const xs = matches.filter((m) => m.x != null).map((m) => m.x!);
      const ys = matches.filter((m) => m.y != null).map((m) => m.y!);
      if (xs.length > 0) {
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        fgRef.current.centerAt(cx, cy, 800);
        const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        const zoom = spread > 0 ? Math.min(4, Math.max(1.2, 300 / spread)) : 2.5;
        fgRef.current.zoom(zoom, 800);
      }
    }
  }, []);

  const runSemanticSearch = useCallback(async (q: string) => {
    if (!q.trim() || !visible) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    if (visible.nodes.some(n => n.privateMemory)) {
      const lower = q.toLowerCase();
      const matches = visible.nodes.filter(n => (n.label + " " + (n.markdown ?? "")).toLowerCase().includes(lower));
      setSearchResults(matches); setSearching(false); zoomToResults(matches); return;
    }
    setSearching(true);
    try {
      const r = await fetch(apiUrl("/api/graph/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          nodes: visible.nodes.map((n) => ({ id: n.id, label: n.label, group: n.group })),
        }),
      });
      if (!r.ok) throw new Error();
      const data = await r.json();
      const resultIds = new Set((data.results || []).map((r: { id: string }) => r.id));
      const matches = visible.nodes.filter((n) => resultIds.has(n.id));
      setSearchResults(matches);
      zoomToResults(matches);
    } catch {
      // Fallback to keyword search
      const lower = q.toLowerCase();
      const matches = visible.nodes.filter((n) =>
        n.label.toLowerCase().includes(lower) ||
        n.id.toLowerCase().includes(lower) ||
        (n.agentName?.toLowerCase().includes(lower))
      );
      setSearchResults(matches);
      zoomToResults(matches);
    } finally {
      setSearching(false);
    }
  }, [visible, backendHost, zoomToResults]);

  const handleSearchInput = useCallback((q: string) => {
    setSearchQuery(q);
    if (!q.trim()) {
      setSearchResults([]);
      setSearching(false);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      return;
    }
    // Debounce 600ms — gives user time to type before hitting LLM
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => runSemanticSearch(q), 600);
  }, [runSemanticSearch]);

  const searchResultIds = useMemo(() => new Set(searchResults.map((n) => n.id)), [searchResults]);

  // ── Drawing ───────────────────────────────────────────────────
  // Pre-cache an alpha factor per node based on the hover/selected state
  // so we don't recompute it inside the canvas hot path.
  const dimAlpha = (n: GraphNode): number => {
    // Search results glow at full alpha
    if (searchResultIds.size > 0) {
      return searchResultIds.has(n.id) ? 1 : 0.12;
    }
    if (!focus) return 1;
    if (focusNeighbors.has(n.id)) return 1;
    return 0.18;
  };

  const drawNode = useCallback(
    (n: GraphNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const r = radiusFor(n);
      const a = dimAlpha(n);
      const isFocus = focus?.id === n.id;
      const isNeighbor = focus && focus.id !== n.id && focusNeighbors.has(n.id);

      // Glow halo on hover/select
      if (isFocus) {
        const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 4);
        glow.addColorStop(0, n.color + "AA");
        glow.addColorStop(1, n.color + "00");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r * 4, 0, Math.PI * 2);
        ctx.fill();
      } else if (isNeighbor) {
        // Subtle ring on directly-connected nodes.
        ctx.strokeStyle = n.color + "55";
        ctx.lineWidth = 0.8 / scale;
        ctx.beginPath();
        ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Solid disc — alpha-modulated by focus state
      ctx.globalAlpha = a;

      // For hub nodes with a pre-loaded profile photo, draw the image
      // clipped to a circle instead of the flat colour disc.
      const agentImg = n.group === "hub" ? loadedImgs.current[n.agentId || n.id] : null;
      if (agentImg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(agentImg, x - r, y - r, r * 2, r * 2);
        ctx.restore();
      } else {
        ctx.fillStyle = n.color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        // Soft inner highlight to make it look 3D
        const inner = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, 0, x, y, r);
        inner.addColorStop(0, "rgba(255,255,255,0.45)");
        inner.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = inner;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Crisp outline
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = agentImg ? "rgba(26,20,16,0.25)" : "rgba(26,20,16,0.18)";
      ctx.lineWidth = (agentImg ? 0.8 : 0.5) / scale;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Labels — what to show, when:
      //   hubs        → always
      //   personality → when zoomed >= 1.0 or when in focus set
      //   topic       → when zoomed >= 1.6 or when in focus set
      //   external    → only when in focus set or zoomed >= 2.4
      const showLabel =
        n.group === "hub" ||
        (n.group === "personality" && (scale >= 1.0 || focusNeighbors.has(n.id))) ||
        (n.group === "topic" && (scale >= 1.6 || focusNeighbors.has(n.id))) ||
        (n.group === "external" && (scale >= 2.4 || focusNeighbors.has(n.id)));
      if (!showLabel) return;

      const fontSize =
        n.group === "hub"
          ? Math.max(11 / Math.sqrt(scale), 5)
          : Math.max(9 / Math.sqrt(scale), 3.5);
      ctx.font = `${n.group === "hub" ? 600 : 400} ${fontSize}px ui-sans-serif, system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const labelAlpha = focus
        ? focusNeighbors.has(n.id)
          ? 0.92
          : 0.06
        : n.group === "hub"
        ? 0.92
        : n.group === "personality"
        ? 0.7
        : n.group === "topic"
        ? 0.55
        : 0.42;
      // Subtle background pill for legibility on the cream bg.
      const text = n.label;
      const w = ctx.measureText(text).width;
      const padX = 3;
      const labelY = y + r + 2;
      ctx.globalAlpha = labelAlpha * 0.45;
      ctx.fillStyle = "#fdf9f0";
      const radius = (fontSize + 2) / 2;
      const left = x - w / 2 - padX;
      const right = x + w / 2 + padX;
      const top = labelY;
      const bot = labelY + fontSize + 1;
      ctx.beginPath();
      ctx.moveTo(left + radius, top);
      ctx.lineTo(right - radius, top);
      ctx.quadraticCurveTo(right, top, right, top + radius);
      ctx.lineTo(right, bot - radius);
      ctx.quadraticCurveTo(right, bot, right - radius, bot);
      ctx.lineTo(left + radius, bot);
      ctx.quadraticCurveTo(left, bot, left, bot - radius);
      ctx.lineTo(left, top + radius);
      ctx.quadraticCurveTo(left, top, left + radius, top);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = labelAlpha;
      ctx.fillStyle = "#1a1410";
      ctx.fillText(text, x, labelY);
      ctx.globalAlpha = 1;
    },
    [focus, focusNeighbors],
  );

  const linkColor = useCallback(
    (l: GraphLink) => {
      const s = linkEnd(l.source);
      const t = linkEnd(l.target);
      if (focus && (focusNeighbors.has(s) || focusNeighbors.has(t))) {
        return "rgba(26,20,16,0.55)";
      }
      return focus ? "rgba(26,20,16,0.05)" : "rgba(26,20,16,0.15)";
    },
    [focus, focusNeighbors],
  );

  const linkWidth = useCallback(
    (l: GraphLink) => {
      const s = linkEnd(l.source);
      const t = linkEnd(l.target);
      if (focus && (s === focus.id || t === focus.id)) return 1.4;
      return 0.45;
    },
    [focus],
  );

  // Tiny moving particles only on edges touching the focus node — gives
  // a subtle "alive" pulse without lighting up the whole graph.
  const linkParticles = useCallback(
    (l: GraphLink) => {
      if (!focus) return 0;
      const s = linkEnd(l.source);
      const t = linkEnd(l.target);
      return s === focus.id || t === focus.id ? 2 : 0;
    },
    [focus],
  );

  const onNodeClick = useCallback((node: GraphNode) => {
    setSelected(node);
    if (fgRef.current && node.x != null && node.y != null) {
      fgRef.current.centerAt(node.x, node.y, 600);
      fgRef.current.zoom(2.4, 600);
    }
  }, []);

  return (
    <main className="ph-no-capture ph-mask editorial-page min-h-screen px-6 py-10">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Link
              href="/world"
              className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] shadow-[3px_3px_0_#1f2a3c] hover:bg-[#fffaf0]"
            >
              ← World
            </Link>
            <div>
              <span className="border-[3px] border-[#1f2a3c] bg-[#e8d6ff] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] shadow-[3px_3px_0_#1f2a3c]">
                Pixel Societies · /graph
              </span>
              <h1 className="mt-3 font-bold text-[34px] leading-tight text-[#1f2a3c]">
                Wiki Graph
              </h1>
              <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-[#4f5c6d]">
                Every wiki page is a node, every <code className="font-mono text-[12px]">[[wikilink]]</code> is
                an edge. Hover to focus a colleague{"’"}s neighbourhood;
                click to zoom in.
              </p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {GROUPS.map((g) => {
              const on = active.has(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => toggleGroup(g.id)}
                  className={
                    "border-[3px] border-[#1f2a3c] px-3 py-1 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] " +
                    (on ? "bg-[#1f2a3c] text-[#fffaf0]" : "bg-[#f6f4ea] text-[#1f2a3c]")
                  }
                  title={`${counts[g.id] ?? 0} nodes`}
                >
                  {g.label} ({counts[g.id] ?? 0})
                </button>
              );
            })}
          </div>
        </header>

        {/* Search bar */}
        <div className="mb-4">
          <div className="relative">
            <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-mute)]" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="11" y1="11" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); runSemanticSearch(searchQuery); } }}
              placeholder="Ask a question — e.g. 'What interesting technologies are people working on?'"
              className="w-full rounded-2xl border border-[rgba(0,0,0,0.1)] bg-white py-2.5 pl-9 pr-10 text-[14px] text-[var(--ink)] placeholder:text-[var(--ink-mute)] focus:border-[rgba(0,0,0,0.25)] focus:outline-none"
            />
            {searching && (
              <div className="absolute right-10 top-1/2 -translate-y-1/2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--ink-mute)] border-t-transparent" />
              </div>
            )}
            {searchQuery && (
              <button
                type="button"
                onClick={() => { handleSearchInput(""); fgRef.current?.zoomToFit?.(600, 80); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ink-mute)] hover:text-[var(--ink)]"
              >
                ×
              </button>
            )}
          </div>
          {searchResults.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {searchResults.slice(0, 12).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onNodeClick(n)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(0,0,0,0.08)] bg-white px-2.5 py-1 text-[11px] font-medium text-[var(--ink)] transition hover:bg-[#f5f5f5]"
                >
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: n.color }} />
                  {n.label}
                </button>
              ))}
              {searchResults.length > 12 && (
                <span className="px-2 py-1 text-[11px] text-[var(--ink-mute)]">
                  +{searchResults.length - 12} more
                </span>
              )}
            </div>
          )}
        </div>

        <div
          ref={wrapRef}
          className="editorial-card relative overflow-hidden p-0"
          style={{
            height: "75vh",
            minHeight: 520,
            // Soft radial vignette so the canvas reads as a "depth field".
            backgroundImage:
              "radial-gradient(circle at 50% 45%, #fdf9f0 0%, #f5ead4 70%, #ebe0c8 100%)",
          }}
        >
          {error && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] text-[var(--accent-warn)]">
              Graph load failed: {error}
            </div>
          )}
          {!error && !visible && (
            <div className="absolute inset-0 flex items-center justify-center text-[13px] text-[var(--ink-mute)]">
              Loading the graph…
            </div>
          )}
          {visible && (
            <ForceGraph2D
              ref={fgRef}
              graphData={visible}
              width={size.w}
              height={size.h}
              backgroundColor="rgba(0,0,0,0)"
              enableNodeDrag
              warmupTicks={PHYSICS.warmupTicks}
              cooldownTicks={250}
              d3VelocityDecay={PHYSICS.velocityDecay}
              nodeRelSize={4}
              nodeVal={(n: GraphNode) => n.size}
              nodeCanvasObjectMode={() => "replace"}
              nodeCanvasObject={drawNode}
              nodePointerAreaPaint={(n: GraphNode, color, ctx) => {
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(n.x ?? 0, n.y ?? 0, radiusFor(n) + 4, 0, Math.PI * 2);
                ctx.fill();
              }}
              linkColor={linkColor}
              linkWidth={linkWidth}
              linkDirectionalParticles={linkParticles}
              linkDirectionalParticleSpeed={0.006}
              linkDirectionalParticleWidth={2.2}
              linkDirectionalParticleColor={() => "rgba(26,20,16,0.55)"}
              onNodeHover={(n) => setHovered((n as GraphNode) ?? null)}
              onNodeClick={(n) => onNodeClick(n as GraphNode)}
              onBackgroundClick={() => setSelected(null)}
            />
          )}

          {selected && (
            <aside className="absolute right-3 top-3 bottom-3 z-10 flex w-[420px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border border-[rgba(26,20,16,0.1)] bg-[var(--cream-card)]/95 shadow-[0_8px_24px_rgba(26,20,16,0.16)] backdrop-blur">
              <div className="border-b border-[rgba(26,20,16,0.06)] px-4 py-3">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ background: selected.color }}
                  />
                  <span className="eyebrow">{selected.group}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(null);
                      fgRef.current?.zoomToFit?.(600, 80);
                    }}
                    aria-label="Close preview"
                    className="ml-auto flex h-7 w-7 items-center justify-center rounded-full border border-[rgba(26,20,16,0.12)] bg-white text-[14px] leading-none text-[var(--ink-soft)] hover:bg-[var(--cream-soft)]"
                  >
                    ×
                  </button>
                </div>
                {/* Profile photo + sprite header for hub nodes */}
                {selected.group === "hub" && selected.agentId && (
                  <div className="mt-2 flex items-center gap-3">
                    {agentPhotos[selected.agentId] ? (
                      <div
                        className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl border-2 shadow-md"
                        style={{ borderColor: `${selected.color}66` }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={agentPhotos[selected.agentId]}
                          alt={selected.label}
                          className="h-full w-full object-cover"
                        />
                      </div>
                    ) : (
                      <div
                        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border font-mono text-[18px] font-bold text-white"
                        style={{ background: selected.color, borderColor: `${selected.color}66` }}
                      >
                        {selected.label.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div
                      className="flex h-[56px] w-[40px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[rgba(26,20,16,0.08)]"
                      style={{ background: `linear-gradient(135deg, ${selected.color}28, ${selected.color}10)` }}
                    >
                      <div
                        style={{
                          width: 32,
                          height: 64,
                          backgroundImage: `url(/team-office/characters/char_${(data?.nodes.filter((n) => n.group === "hub").findIndex((n) => n.id === selected.id) ?? 0) % 6}.png)`,
                          backgroundRepeat: "no-repeat",
                          backgroundPosition: "0 0",
                          backgroundSize: `${112 * 2}px ${96 * 2}px`,
                          imageRendering: "pixelated" as const,
                        }}
                        aria-hidden
                      />
                    </div>
                  </div>
                )}

                <div className="serif-display mt-1.5 text-[18px] font-semibold leading-tight text-[var(--ink)]">
                  {selected.label}
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-[var(--ink-mute)]">
                  {selected.agentName && (
                    <span>in {selected.agentName}</span>
                  )}
                  <span>
                    {(adjacency.get(selected.id)?.size ?? 0)} connection
                    {(adjacency.get(selected.id)?.size ?? 0) === 1 ? "" : "s"}
                  </span>
                  {page?.exists && (
                    <span>
                      <code>data/wikis/{page.agent_id}/{page.stem}.md</code>
                    </span>
                  )}
                </div>
                {selected.agentId && selected.group !== "external" && (
                  <Link
                    href={`/chat?agent=${encodeURIComponent(selected.agentId)}`}
                    className="btn-pill btn-pill-dark mt-3 inline-block"
                  >
                    Chat with {selected.agentName ?? selected.agentId}
                  </Link>
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-3">
                {pageLoading && (
                  <div className="text-[12px] text-[var(--ink-mute)]">
                    Loading page…
                  </div>
                )}
                {!pageLoading && page && page.exists && (
                  <MarkdownPreview text={page.markdown} />
                )}
                {!pageLoading && page && !page.exists && (
                  <div className="rounded-xl border border-dashed border-[rgba(26,20,16,0.18)] bg-[var(--cream-soft)] p-4 text-[12px] text-[var(--ink-mute)]">
                    {selected.group === "external" ? (
                      <>
                        <strong>{selected.label}</strong> is referenced by other
                        pages but has no wiki file of its own. It exists as a
                        bridge node — drop a colleague with this name into the
                        wiki to give it a real page.
                      </>
                    ) : (
                      <>No file at this path.</>
                    )}
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>

        {data && (
          <p className="mt-3 text-[12px] text-[var(--ink-mute)]">
            {data.nodes.length} nodes · {data.links.length} edges · live from
            your world. Hover to focus, click to zoom in,
            scroll to zoom, drag to pan.
          </p>
        )}
      </div>
    </main>
  );
}
