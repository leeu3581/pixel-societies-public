"use client";

// Live agent ↔ agent conversation feed — the "Society" panel.
//
// Reads agent_conversations + agent_conversation_messages directly via
// supabase-js (RLS gates rows to own/friend worlds — no extra backend
// endpoint needed). Subscribes to INSERT events on
// agent_conversation_messages so lines drip in as the backend
// turn-taker writes them.
//
// Owners can tap "Spark" to start a fresh conversation in their own
// world (POST /api/worlds/by-username/{username}/society/spark). For
// non-owners the panel is read-only — they're observing.

import { useEffect, useMemo, useState } from "react";
import { ApiError, apiGet } from "@/lib/api";

type ConversationRow = {
  id: string;
  world_id: string | null;
  world_group_id: string | null;
  agent_a_id: string;
  agent_b_id: string;
  room: string | null;
  status: "active" | "ended";
  started_at: string;
  ended_at: string | null;
  message_count: number;
  last_message_at: string | null;
};

type MessageRow = {
  conversation_id: string;
  seq: number;
  agent_id: string;
  body: string;
  created_at: string;
};

type AgentLite = {
  id: string;
  display_name: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  // Owner's username — when set, enables the Spark button. Pass null
  // when viewing as visitor (button hidden).
  ownerUsername: string | null;
  // Map of agent_id → display_name for the worlds the user has access
  // to. Sourced from /api/me/network-agents on the parent page.
  agentsById: Map<string, AgentLite>;
  /** When set, scopes the feed to a single group's conversations
   *  (and the Spark button targets that group). */
  worldGroupId?: string | null;
  worldGroupName?: string | null;
  /** Mutually exclusive with worldGroupId: scopes the feed to a
   *  specific home world's DMs (used on /world so group DMs don't
   *  leak into the home view). */
  worldId?: string | null;
};

const RECENT_CONVERSATION_LIMIT = 12;

export default function SocietyFeed({
  open,
  onClose,
  ownerUsername,
  agentsById,
  worldGroupId,
  worldGroupName,
  worldId,
}: Props) {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [messagesByConv, setMessagesByConv] = useState<
    Map<string, MessageRow[]>
  >(new Map());
  const [error, setError] = useState<string | null>(null);

  // Poll the backend for conversations + messages. Replaces the old
  // direct supabase.from() reads + realtime channel: the backend
  // enforces the own/friend/member access rules and we refresh on an
  // interval (only while the tab is visible). Volumes are small
  // (<=12 conversations, bounded messages) so a full refetch is cheap.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams();
        if (worldGroupId) params.set("world_group_id", worldGroupId);
        else if (worldId) params.set("world_id", worldId);
        params.set("limit", String(RECENT_CONVERSATION_LIMIT));
        const { conversations: convs } = await apiGet<{
          conversations: ConversationRow[];
        }>(`/api/society/conversations?${params.toString()}`);
        if (cancelled) return;
        setConversations(convs);
        if (convs.length === 0) {
          setMessagesByConv(new Map());
          setError(null);
          return;
        }
        const ids = convs.map((c) => c.id).join(",");
        const { messages } = await apiGet<{ messages: MessageRow[] }>(
          `/api/society/messages?conversation_ids=${encodeURIComponent(ids)}`,
        );
        if (cancelled) return;
        const grouped = new Map<string, MessageRow[]>();
        for (const m of messages) {
          const arr = grouped.get(m.conversation_id) ?? [];
          arr.push(m);
          grouped.set(m.conversation_id, arr);
        }
        setMessagesByConv(grouped);
        setError(null);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof ApiError ? e.message : "Couldn't load feed");
      }
    };
    void load();
    const iv = setInterval(() => {
      if (!cancelled && document.visibilityState === "visible") void load();
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [worldGroupId, worldId]);


  // Average cadence — gap between consecutive started_at values, in
  // human-readable form. Falls back to a "—" placeholder when we
  // don't have at least 2 data points.
  const cadenceLabel = useMemo(() => {
    const sorted = [...conversations]
      .filter((c) => c.started_at)
      .sort(
        (a, b) =>
          new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
      );
    if (sorted.length < 2) return "—";
    let totalGapMs = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalGapMs +=
        new Date(sorted[i].started_at).getTime() -
        new Date(sorted[i - 1].started_at).getTime();
    }
    const avgSec = Math.round(totalGapMs / (sorted.length - 1) / 1000);
    if (avgSec < 60) return `~1 every ${avgSec}s`;
    if (avgSec < 3600) return `~1 every ${Math.round(avgSec / 60)}m`;
    return `~1 every ${Math.round(avgSec / 3600)}h`;
  }, [conversations]);

  if (!open) return null;

  return (
    <aside
      role="region"
      aria-label="DMs feed"
      className="fixed inset-0 z-40 flex w-full flex-col overflow-hidden border-[#1f2a3c] bg-[rgba(246,244,234,0.99)] text-[#1f2a3c] sm:inset-y-4 sm:left-4 sm:right-auto sm:w-[min(420px,calc(100vw-1.5rem))] sm:border-[3px] sm:shadow-[6px_6px_0_#1f2a3c]"
    >
      <header className="flex items-center justify-between border-b-[3px] border-[#1f2a3c] bg-[#e8d6ff] px-4 py-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#1f2a3c]">
            {worldGroupName ? `DMs · ${worldGroupName}` : "DMs"}
          </p>
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#5a3d7a]">
            {conversations.length} convs · {cadenceLabel}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
        >
          Close
        </button>
      </header>

      {error && (
        <div className="m-3 border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#6d2d24] shadow-[3px_3px_0_#1f2a3c]">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {conversations.length === 0 ? (
          <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
            No conversations yet. Tap Spark to seed one.
          </p>
        ) : (
          <ul className="space-y-3">
            {conversations.map((c) => (
              <ConversationCard
                key={c.id}
                conv={c}
                messages={messagesByConv.get(c.id) ?? []}
                agentsById={agentsById}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ConversationCard({
  conv,
  messages,
  agentsById,
}: {
  conv: ConversationRow;
  messages: MessageRow[];
  agentsById: Map<string, AgentLite>;
}) {
  const a = agentsById.get(conv.agent_a_id)?.display_name ?? "Agent A";
  const b = agentsById.get(conv.agent_b_id)?.display_name ?? "Agent B";
  return (
    <li className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[3px_3px_0_#1f2a3c]">
      <header className="flex items-center justify-between border-b-[2px] border-[#e8e4d9] px-3 py-2">
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#1f2a3c]">
          {a} <span className="text-[#7f8b98]">×</span> {b}
        </p>
        <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#7f8b98]">
          {conv.status === "active" ? "Live" : "Ended"} · {messages.length}
          {conv.room ? ` · ${conv.room}` : ""}
        </p>
      </header>
      <ul className="space-y-1 px-3 py-2">
        {messages.length === 0 ? (
          <li className="font-mono text-[10px] uppercase text-[#7f8b98]">
            Waiting for first turn…
          </li>
        ) : (
          messages.map((m) => {
            const speaker = agentsById.get(m.agent_id)?.display_name ?? "—";
            return (
              <li key={`${m.conversation_id}-${m.seq}`} className="text-[12px] leading-snug">
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[#5a3d7a]">
                  {speaker}:
                </span>{" "}
                <span className="text-[#1f2a3c]">{m.body}</span>
              </li>
            );
          })
        )}
      </ul>
    </li>
  );
}
