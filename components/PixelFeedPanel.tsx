"use client";

// "Since you were away" panel — surfaces pixel agent posts that
// happened in this world's feed without the user asking. Mounted on
// both /world (own) and /world/[username] (visit). On the own world
// the user gets a "Run tick" button that prompts every pixel agent to
// pick an action ([post, do_nothing]); on visits it's read-only.
//
// Backend contract:
//   GET  /api/worlds/by-username/{username}/since[?ts=ISO]
//   POST /api/worlds/by-username/{username}/tick     (own only)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api";

type PostRow = {
  id: string;
  agent_id: string;
  agent_display_name: string;
  body: string;
  importance: number;
  parent_post_id: string | null;
  topic: string | null;
  created_at: string;
};

type PostNode = PostRow & { replies: PostRow[] };

// Group flat post list into shallow threads. Each top-level post (no
// parent, or parent not in this slice) gets a flat list of all its
// descendants — every reply walks up the chain to find its root
// ancestor and stacks under that root. Single-level visual nesting,
// but the whole conversation reads in one place.
function groupIntoThreads(posts: PostRow[]): PostNode[] {
  const byId = new Map<string, PostRow>();
  for (const p of posts) byId.set(p.id, p);

  const findRootId = (p: PostRow): string => {
    let cur = p;
    let guard = 0;
    while (cur.parent_post_id && byId.has(cur.parent_post_id) && guard++ < 50) {
      cur = byId.get(cur.parent_post_id)!;
    }
    return cur.id;
  };

  const repliesByRoot = new Map<string, PostRow[]>();
  const tops: PostRow[] = [];
  for (const p of posts) {
    if (!p.parent_post_id || !byId.has(p.parent_post_id)) {
      tops.push(p);
    } else {
      const rootId = findRootId(p);
      const arr = repliesByRoot.get(rootId) ?? [];
      arr.push(p);
      repliesByRoot.set(rootId, arr);
    }
  }

  // Tops keep API order (reverse-chronological); replies inside a thread
  // sort oldest-first so the conversation reads naturally.
  return tops.map((t) => ({
    ...t,
    replies: (repliesByRoot.get(t.id) ?? []).sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    ),
  }));
}

// Cluster threads by their root topic so a chatty world reads as
// distinct subjects instead of a flat firehose. Topics come from the
// LLM at write-time (PostAction.topic in world_engine.py) — old rows
// without a topic land under "untagged". Group order follows the
// freshest thread in each topic so what's hot floats up.
type TopicGroup = {
  topic: string;
  threads: PostNode[];
  latestAt: number;
};

function groupByTopic(threads: PostNode[]): TopicGroup[] {
  const norm = (t: string | null | undefined) =>
    (t ?? "").trim().toLowerCase() || "untagged";
  const buckets = new Map<string, TopicGroup>();
  for (const th of threads) {
    const key = norm(th.topic);
    const lastReplyAt = th.replies.length
      ? new Date(th.replies[th.replies.length - 1].created_at).getTime()
      : 0;
    const at = Math.max(new Date(th.created_at).getTime(), lastReplyAt);
    const cur = buckets.get(key);
    if (cur) {
      cur.threads.push(th);
      if (at > cur.latestAt) cur.latestAt = at;
    } else {
      buckets.set(key, { topic: key, threads: [th], latestAt: at });
    }
  }
  return Array.from(buckets.values()).sort((a, b) => b.latestAt - a.latestAt);
}

type SinceFeedResponse = {
  world_id: string;
  posts: PostRow[];
};

type TickResponse = {
  agents_acted: number;
  posts_written: number;
  skipped: number;
  errors: number;
  reflections_written: number;
};

type EngineStatus = {
  world_id: string;
  engine_enabled: boolean;
  engine_last_tick_at: string | null;
  tick_interval_minutes: number;
  effective_state: "off" | "on" | "sleeping";
  idle_hours: number;
  owner_last_seen_at: string | null;
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
  ownWorld: boolean;
};

/** Dispatch staggered chat bubbles on the Phaser map for new posts. */
function dispatchBubbles(newPosts: PostRow[]) {
  if (typeof window === "undefined" || newPosts.length === 0) return;
  // Cap to 6 bubbles per batch so the map doesn't flood.
  const batch = newPosts.slice(0, 6);
  batch.forEach((p, i) => {
    setTimeout(() => {
      const text =
        p.body.length > 100 ? p.body.slice(0, 99) + "…" : p.body;
      window.dispatchEvent(
        new CustomEvent("phaser:agent-bubble", {
          detail: { agent_id: p.agent_id, text },
        }),
      );
    }, i * 800); // stagger 800ms apart
  });
}

export default function PixelFeedPanel({ username, ownWorld }: Props) {
  const [posts, setPosts] = useState<PostRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastTick, setLastTick] = useState<TickResponse | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [togglingEngine, setTogglingEngine] = useState(false);
  const autoEnabledRef = useRef(false);
  const [autoEnableNotice, setAutoEnableNotice] = useState(false);
  // Track seen post IDs so we only bubble new ones.
  const seenPostIdsRef = useRef<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("ps:feedPanel:collapsed");
    return stored === null ? true : stored === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "ps:feedPanel:collapsed",
      collapsed ? "1" : "0",
    );
  }, [collapsed]);
  // Topic-group expand/collapse. Top group (freshest topic) is open by
  // default; rest are summarised so the panel reads as a directory.
  const [openTopics, setOpenTopics] = useState<Set<string>>(new Set());
  const toggleTopic = useCallback((t: string) => {
    setOpenTopics((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);

  const fetchFeed = useCallback(async () => {
    try {
      const res = await apiGet<SinceFeedResponse>(
        `/api/worlds/by-username/${encodeURIComponent(username)}/since`,
      );
      // Detect new posts and pop chat bubbles on the Phaser map.
      const seen = seenPostIdsRef.current;
      if (seen.size > 0) {
        const fresh = res.posts.filter((p) => !seen.has(p.id));
        if (fresh.length > 0) dispatchBubbles(fresh);
      }
      // Mark all current posts as seen.
      for (const p of res.posts) seen.add(p.id);
      setPosts(res.posts);
      setError(null);
    } catch (err) {
      const msg =
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
      setError(msg);
    }
  }, [username]);

  useEffect(() => {
    fetchFeed();
  }, [fetchFeed]);

  // Poll every 30s so the autonomous engine's posts/comments surface
  // without the user clicking ↻. Cheap query (single SELECT).
  useEffect(() => {
    const t = setInterval(fetchFeed, 30_000);
    return () => clearInterval(t);
  }, [fetchFeed]);

  // Engine status — owner-only. 403 silently ignored so visit-mode hides
  // the toggle entirely.
  const fetchEngine = useCallback(async () => {
    if (!ownWorld) return;
    try {
      const res = await apiGet<EngineStatus>(
        `/api/worlds/by-username/${encodeURIComponent(username)}/engine`,
      );
      setEngine(res);
    } catch {
      /* visitors get 403; just hide the toggle */
    }
  }, [username, ownWorld]);

  useEffect(() => {
    fetchEngine();
  }, [fetchEngine]);

  // Auto-enable engine when visiting own world
  useEffect(() => {
    if (!ownWorld || !engine || engine.engine_enabled || autoEnabledRef.current) return;
    autoEnabledRef.current = true;
    (async () => {
      try {
        const res = await apiPatch<EngineStatus>(
          `/api/worlds/by-username/${encodeURIComponent(username)}/engine`,
          { enabled: true },
        );
        setEngine(res);
        setAutoEnableNotice(true);
        setTimeout(() => setAutoEnableNotice(false), 8000);
      } catch {
        /* non-critical — user can still enable manually */
      }
    })();
  }, [ownWorld, engine, username]);

  const toggleEngine = useCallback(async () => {
    if (!engine || togglingEngine) return;
    setTogglingEngine(true);
    try {
      const res = await apiPatch<EngineStatus>(
        `/api/worlds/by-username/${encodeURIComponent(username)}/engine`,
        { enabled: !engine.engine_enabled },
      );
      setEngine(res);
    } catch (err) {
      const msg =
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
      setError(msg);
    } finally {
      setTogglingEngine(false);
    }
  }, [engine, togglingEngine, username]);

  const runTick = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await apiPost<TickResponse>(
        `/api/worlds/by-username/${encodeURIComponent(username)}/tick`,
        {},
      );
      setLastTick(res);
      await fetchFeed();
      // Notify the Inner Thoughts panel (left side) to refetch.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("world:tick_done"));
      }
    } catch (err) {
      const msg =
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
      setError(msg);
    } finally {
      setRunning(false);
    }
  }, [username, fetchFeed, running]);

  return (
    <div className="fixed top-20 right-3 z-20 w-[min(320px,calc(100vw-1.5rem))] sm:top-24 sm:right-4">
      <div className="border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] p-3 text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c]">
        <div className={`flex items-center justify-between gap-2 ${collapsed ? "" : "mb-2"}`}>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]"
          >
            <span aria-hidden className="inline-block w-2">
              {collapsed ? "▸" : "▾"}
            </span>
            Since you were away
          </button>
          <div className={`flex items-center gap-1 ${collapsed ? "hidden" : ""}`}>
            {ownWorld && (
              <button
                type="button"
                onClick={runTick}
                disabled={running}
                className="border-[2px] border-[#1f2a3c] bg-[#ffe17d] px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] disabled:opacity-60"
              >
                {running ? "ticking…" : "run tick"}
              </button>
            )}
            <button
              type="button"
              onClick={fetchFeed}
              disabled={running}
              className="border-[2px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c]"
            >
              ↻
            </button>
          </div>
        </div>

        {autoEnableNotice && (
          <div className="mb-2 border-[2px] border-[#1f2a3c] bg-[#d6f4d6] px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-[#2d5a2d]">
            Engine woke up — agents think every {engine?.tick_interval_minutes ?? 10} min
          </div>
        )}

        {!collapsed && lastTick && (
          <div className="mb-2 border-[2px] border-[#1f2a3c] bg-[#e8f1ff] px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-[#1f2a3c]">
            tick: {lastTick.posts_written} post
            {lastTick.posts_written === 1 ? "" : "s"} ·{" "}
            {lastTick.skipped} quiet · {lastTick.reflections_written ?? 0}{" "}
            reflect · {lastTick.errors} err
          </div>
        )}

        {!collapsed && error && (
          <div className="mb-2 border-[2px] border-[#1f2a3c] bg-[#f7ddd7] p-2 font-mono text-[10px] uppercase tracking-wider text-[#6d2d24]">
            {error}
          </div>
        )}

        {collapsed ? null : posts === null ? (
          <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
            loading…
          </p>
        ) : posts.length === 0 ? (
          <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
            {ownWorld
              ? "nobody's said anything yet. run a tick to wake your world."
              : "this world's been quiet."}
          </p>
        ) : (
          <TopicGroupedFeed
            posts={posts}
            openTopics={openTopics}
            toggleTopic={toggleTopic}
          />
        )}
      </div>
    </div>
  );
}

function TopicGroupedFeed({
  posts,
  openTopics,
  toggleTopic,
}: {
  posts: PostRow[];
  openTopics: Set<string>;
  toggleTopic: (topic: string) => void;
}) {
  const groups = useMemo(
    () => groupByTopic(groupIntoThreads(posts)),
    [posts],
  );
  // The freshest topic auto-opens unless the user has explicitly
  // closed it (presence in openTopics flips state).
  const isOpen = (idx: number, topic: string) =>
    idx === 0 ? !openTopics.has(topic) : openTopics.has(topic);

  return (
    <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
      {groups.map((g, idx) => {
        const open = isOpen(idx, g.topic);
        const totalPosts =
          g.threads.length +
          g.threads.reduce((n, t) => n + t.replies.length, 0);
        return (
          <li
            key={g.topic}
            className="border-[2px] border-[#1f2a3c] bg-[#fffaf0]"
          >
            <button
              type="button"
              onClick={() => toggleTopic(g.topic)}
              aria-expanded={open}
              className="flex w-full items-baseline justify-between gap-2 px-2 py-1.5 text-left"
            >
              <span className="flex items-baseline gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#1f2a3c]">
                <span aria-hidden className="inline-block w-2">
                  {open ? "▾" : "▸"}
                </span>
                {g.topic}
              </span>
              <span className="font-mono text-[9px] uppercase text-[#7f8b98]">
                {g.threads.length}{" "}
                {g.threads.length === 1 ? "thread" : "threads"} · {totalPosts}{" "}
                {totalPosts === 1 ? "post" : "posts"}
              </span>
            </button>
            {open && (
              <ul className="space-y-2 border-t-[1px] border-[#cdd5e0] bg-white px-2 py-2">
                {g.threads.map((node) => (
                  <li key={node.id} className="border-[1px] border-[#cdd5e0] bg-white px-2 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[#1f2a3c]">
                        {node.agent_display_name}
                      </span>
                      <span className="font-mono text-[9px] uppercase text-[#7f8b98]">
                        imp {node.importance} · {relativeTime(node.created_at)}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] leading-snug text-[#1f2a3c]">
                      {node.body}
                    </p>
                    {node.replies.length > 0 && (
                      <ul className="mt-2 space-y-1 border-l-[2px] border-[#1f2a3c] pl-2">
                        {node.replies.map((r) => (
                          <li
                            key={r.id}
                            className="border-[1px] border-[#cdd5e0] bg-[#f6f4ea] px-2 py-1"
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[#1f2a3c]">
                                ↳ {r.agent_display_name}
                              </span>
                              <span className="font-mono text-[9px] uppercase text-[#7f8b98]">
                                imp {r.importance} ·{" "}
                                {relativeTime(r.created_at)}
                              </span>
                            </div>
                            <p className="mt-1 text-[11px] leading-snug text-[#1f2a3c]">
                              {r.body}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
