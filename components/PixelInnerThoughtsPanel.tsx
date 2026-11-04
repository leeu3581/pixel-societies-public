"use client";

// Owner-only "Inner Thoughts" panel — the reflections each pixel
// agent has produced about themselves and their peers. Lives on the
// LEFT side of /world, paired with the "Since you were away" panel
// on the right. Reflections are private to the owner by design
// (Smallville keeps them internal too); the backend's
// /api/worlds/by-username/{username}/reflections endpoint returns
// 403 for non-owners, so we silently no-op on visit mode.
//
// Refreshes on mount and whenever PixelFeedPanel emits a
// `world:tick_done` window event after a tick completes.

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";

type ReflectionRow = {
  id: string;
  agent_id: string;
  agent_display_name: string;
  content: string;
  importance: number;
  created_at: string;
};

type ReflectionsResponse = {
  world_id: string;
  reflections: ReflectionRow[];
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const sec = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
}

type Props = {
  username: string;
};

type AgentGroup = {
  agentId: string;
  agentName: string;
  thoughts: ReflectionRow[];
};

export default function PixelInnerThoughtsPanel({ username }: Props) {
  const [reflections, setReflections] = useState<ReflectionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("ps:innerThoughts:collapsed");
    return stored === null ? true : stored === "1";
  });
  const [openAgents, setOpenAgents] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "ps:innerThoughts:collapsed",
      collapsed ? "1" : "0",
    );
  }, [collapsed]);

  const fetchReflections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<ReflectionsResponse>(
        `/api/worlds/by-username/${encodeURIComponent(username)}/reflections`,
      );
      setReflections(res.reflections);
    } catch {
      /* owner-only on backend; visitors get 403 — fail quietly */
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => {
    fetchReflections();
  }, [fetchReflections]);

  // Refresh when the right-side panel finishes a tick.
  useEffect(() => {
    const handler = () => fetchReflections();
    window.addEventListener("world:tick_done", handler);
    return () => window.removeEventListener("world:tick_done", handler);
  }, [fetchReflections]);

  // Poll every 30s to surface autonomous reflections.
  useEffect(() => {
    const t = setInterval(fetchReflections, 30_000);
    return () => clearInterval(t);
  }, [fetchReflections]);

  const groups: AgentGroup[] = useMemo(() => {
    if (!reflections) return [];
    // Preserve API order (most recent first) by walking once and using
    // the first appearance of each agent_id as the group's slot. Within
    // a group, thoughts stay in API order.
    const slots = new Map<string, AgentGroup>();
    for (const r of reflections) {
      const g = slots.get(r.agent_id);
      if (g) g.thoughts.push(r);
      else
        slots.set(r.agent_id, {
          agentId: r.agent_id,
          agentName: r.agent_display_name,
          thoughts: [r],
        });
    }
    return Array.from(slots.values());
  }, [reflections]);

  const toggleAgent = useCallback((agentId: string) => {
    setOpenAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  return (
    <div className="fixed top-20 left-3 z-20 w-[min(320px,calc(100vw-1.5rem))] sm:top-24 sm:left-4">
      <div className="border-[3px] border-[#5b3a90] bg-[rgba(243,236,255,0.97)] p-3 text-[#3d2966] shadow-[4px_4px_0_#1f2a3c]">
        <div className={`flex items-center justify-between gap-2 ${collapsed ? "" : "mb-2"}`}>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#5b3a90]"
          >
            <span aria-hidden className="inline-block w-2">
              {collapsed ? "▸" : "▾"}
            </span>
            ✦ Inner thoughts · private
          </button>
          <button
            type="button"
            onClick={fetchReflections}
            disabled={loading}
            className={`border-[2px] border-[#5b3a90] bg-[#f3ecff] px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-[2px_2px_0_#5b3a90] disabled:opacity-60 ${collapsed ? "hidden" : ""}`}
          >
            ↻
          </button>
        </div>

        {collapsed ? null : reflections === null ? (
          <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f6da8]">
            loading…
          </p>
        ) : reflections.length === 0 ? (
          <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f6da8]">
            no reflections yet · your agents need more accumulated experience to start drawing higher-level conclusions
          </p>
        ) : (
          <ul className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
            {groups.map((g) => {
              const open = openAgents.has(g.agentId);
              const latest = g.thoughts[0];
              return (
                <li
                  key={g.agentId}
                  className="border-[2px] border-[#a37cd8] bg-[#f3ecff] px-2 py-2"
                >
                  <button
                    type="button"
                    onClick={() => toggleAgent(g.agentId)}
                    aria-expanded={open}
                    className="flex w-full items-baseline justify-between gap-2 text-left"
                  >
                    <span className="flex items-baseline gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b3a90]">
                      <span aria-hidden className="inline-block w-2">
                        {open ? "▾" : "▸"}
                      </span>
                      ✦ {g.agentName}
                    </span>
                    <span className="font-mono text-[9px] uppercase text-[#7f6da8]">
                      {g.thoughts.length}{" "}
                      {g.thoughts.length === 1 ? "thought" : "thoughts"} ·{" "}
                      {relativeTime(latest.created_at)}
                    </span>
                  </button>
                  {!open && (
                    <p className="mt-1 line-clamp-2 text-[11px] italic leading-snug text-[#3d2966]">
                      {latest.content}
                    </p>
                  )}
                  {open && (
                    <ul className="mt-2 space-y-2">
                      {g.thoughts.map((r) => (
                        <li
                          key={r.id}
                          className="border-l-[2px] border-[#a37cd8] pl-2"
                        >
                          <div className="font-mono text-[9px] uppercase text-[#7f6da8]">
                            imp {r.importance} · {relativeTime(r.created_at)}
                          </div>
                          <p className="mt-0.5 text-[11px] italic leading-snug text-[#3d2966]">
                            {r.content}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
