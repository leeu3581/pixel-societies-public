"use client";

// "Ask my world" — slide-up drawer that runs a Router → Answers →
// Verdict consult over the user's home-world agents. Mirrors
// ChatDrawer's WS lifecycle (one socket per drawer, opens on mount,
// closes on unmount). Frame protocol is identical to /consult so the
// rendering primitives below are a slimmed-down version of
// ConsultView.tsx without the multi-world / localStorage / canvas
// scaffolding.
//
// Frames consumed:
//   consult_started        { question }
//   routing                { chosen_ids, reasoning }
//   dossier                { asker_name, summary, relationships, knowledge }
//   answer_start           { profile_id }
//   answer                 { profile_id, position, reasoning, angle,
//                            personal_note, confidence, caveats }
//   answer_error           { profile_id, message }
//   verdict                { headline, confidence, summary, takeaways,
//                            consensus, mode, contributing_ids,
//                            disagreements, personal_context, personal_facts }
//   consult_done           {}
//   consult_error          { message }
//   consult_rate_limited   { retry_after_seconds }

import { useEffect, useMemo, useRef, useState } from "react";
import { getToken } from "@/lib/authClient";
import { wsUrl } from "@/lib/backend";
import SpriteFrame from "@/components/SpriteFrame";
import posthog from "posthog-js";

export type ConsultAgent = {
  id: string;
  display_name: string;
  sprite_url: string | null;
  placeholder_sprite_url: string;
};

type Routing = { chosen_ids: string[]; reasoning: string };

type AnswerFrame = {
  profile_id: string;
  position: string;
  reasoning: string;
  angle: string;
  personal_note: string;
  confidence: number;
  caveats: string[];
  pending?: boolean;
  error?: string;
};

type Takeaway = { profile_id: string; keyword: string; summary: string };

type VerdictFrame = {
  headline: string;
  confidence: number;
  summary: string;
  personal_context: string;
  personal_facts: string[];
  consensus: "aligned" | "split" | "contested";
  mode: "digest" | "debate";
  contributing_ids: string[];
  disagreements: string[];
  takeaways: Takeaway[];
};

type State = "idle" | "routing" | "streaming" | "done";

type Props = {
  agents: ConsultAgent[];
  onClose: () => void;
};

export default function WorldConsultDrawer({ agents, onClose }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<State>("idle");
  const [routing, setRouting] = useState<Routing | null>(null);
  const [answers, setAnswers] = useState<AnswerFrame[]>([]);
  const [verdict, setVerdict] = useState<VerdictFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Token bootstrap — same as ChatDrawer.
  useEffect(() => {
    (async () => {
      setToken(getToken());
    })();
  }, []);

  // Open the WS once we have a token. The first user message kicks off
  // the orchestration; the socket stays open until the drawer unmounts.
  useEffect(() => {
    if (!token) return;
    const url = `${wsUrl("/")}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener("message", (ev) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const t = frame.type as string;

      if (t === "consult_started") {
        setState("routing");
      } else if (t === "routing") {
        setRouting({
          chosen_ids: (frame.chosen_ids as string[]) || [],
          reasoning: String(frame.reasoning || ""),
        });
        setState("streaming");
      } else if (t === "answer_start") {
        const pid = String(frame.profile_id || "");
        setAnswers((prev) => [
          ...prev,
          {
            profile_id: pid,
            position: "",
            reasoning: "",
            angle: "",
            personal_note: "",
            confidence: 0,
            caveats: [],
            pending: true,
          },
        ]);
      } else if (t === "answer") {
        const pid = String(frame.profile_id || "");
        setAnswers((prev) => {
          const i = prev.findIndex((a) => a.profile_id === pid && a.pending);
          if (i < 0) {
            return [
              ...prev,
              {
                profile_id: pid,
                position: String(frame.position || ""),
                reasoning: String(frame.reasoning || ""),
                angle: String(frame.angle || ""),
                personal_note: String(frame.personal_note || ""),
                confidence: Number(frame.confidence || 0),
                caveats: (frame.caveats as string[]) || [],
              },
            ];
          }
          const next = [...prev];
          next[i] = {
            profile_id: pid,
            position: String(frame.position || ""),
            reasoning: String(frame.reasoning || ""),
            angle: String(frame.angle || ""),
            personal_note: String(frame.personal_note || ""),
            confidence: Number(frame.confidence || 0),
            caveats: (frame.caveats as string[]) || [],
          };
          return next;
        });
      } else if (t === "answer_error") {
        const pid = String(frame.profile_id || "");
        const msg = String(frame.message || "answer failed");
        setAnswers((prev) => {
          const i = prev.findIndex((a) => a.profile_id === pid && a.pending);
          if (i < 0) return prev;
          const next = [...prev];
          next[i] = { ...next[i], pending: false, error: msg };
          return next;
        });
      } else if (t === "verdict") {
        setVerdict({
          headline: String(frame.headline || ""),
          confidence: Number(frame.confidence || 0),
          summary: String(frame.summary || ""),
          personal_context: String(frame.personal_context || ""),
          personal_facts: (frame.personal_facts as string[]) || [],
          consensus: (frame.consensus as VerdictFrame["consensus"]) || "aligned",
          mode: (frame.mode as VerdictFrame["mode"]) || "digest",
          contributing_ids: (frame.contributing_ids as string[]) || [],
          disagreements: (frame.disagreements as string[]) || [],
          takeaways: (frame.takeaways as Takeaway[]) || [],
        });
      } else if (t === "consult_done") {
        setState("done");
      } else if (t === "consult_error") {
        setError(String(frame.message || "consult error"));
        setState("done");
      } else if (t === "consult_rate_limited") {
        const retry = Number(frame.retry_after_seconds || 0);
        setRateLimitedUntil(Date.now() + retry * 1000);
        setState("idle");
      }
      // dossier frame is informational — we ignore in v1; verdict
      // already includes personal_context + personal_facts.
    });

    return () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      wsRef.current = null;
    };
  }, [token]);

  // Auto-scroll on new answers / verdict.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [answers.length, verdict]);

  const send = () => {
    const question = draft.trim();
    if (!question) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Connection isn't open yet — try again in a sec.");
      return;
    }
    setError(null);
    setRouting(null);
    setAnswers([]);
    setVerdict(null);
    setState("routing");
    posthog.capture("world_consult_submitted", { agent_count: agents.length });
    ws.send(JSON.stringify({ type: "start_world_consult", question }));
    setDraft("");
  };

  const reset = () => {
    setError(null);
    setRouting(null);
    setAnswers([]);
    setVerdict(null);
    setState("idle");
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const agentById = useMemo(() => {
    const m = new Map<string, ConsultAgent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  // Tick the rate-limit countdown.
  const [, force] = useState(0);
  useEffect(() => {
    if (rateLimitedUntil === null) return;
    const t = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [rateLimitedUntil]);

  const rateLimitedRemaining = useMemo(() => {
    if (rateLimitedUntil === null) return 0;
    const sec = Math.max(0, Math.round((rateLimitedUntil - Date.now()) / 1000));
    if (sec === 0) setRateLimitedUntil(null);
    return sec;
  }, [rateLimitedUntil]);

  const busy = state === "routing" || state === "streaming";

  return (
    <div className="fixed bottom-0 left-1/2 z-40 w-[min(640px,calc(100vw-1rem))] -translate-x-1/2">
      <div className="border-[3px] border-b-0 border-[#1f2a3c] bg-[rgba(246,244,234,0.99)] text-[#1f2a3c] shadow-[5px_5px_0_#1f2a3c]">
        {/* Header */}
        <div className="flex items-center gap-3 border-b-[3px] border-[#1f2a3c] bg-[#ffe17d] px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c]">
              Consult
            </p>
            <p className="truncate text-lg font-bold leading-tight">
              Ask my world
            </p>
          </div>
          {state === "done" && (
            <button
              type="button"
              onClick={reset}
              className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
            >
              Ask another
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div
          ref={scrollRef}
          className="max-h-[58vh] min-h-[200px] overflow-y-auto bg-[#f6f4ea] px-4 py-3"
        >
          {state === "idle" && answers.length === 0 && !verdict && !error && (
            <p className="font-mono text-[11px] uppercase tracking-wider text-[#7f8b98]">
              Ask anything — your world's experts will weigh in.
            </p>
          )}

          {/* Verdict pinned at top once it arrives */}
          {verdict && (
            <VerdictCard verdict={verdict} agentById={agentById} />
          )}

          {/* Routing pill */}
          {routing && (
            <div className="mb-3 border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 shadow-[3px_3px_0_#1f2a3c]">
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#637387]">
                Routing — {routing.chosen_ids.length} expert
                {routing.chosen_ids.length === 1 ? "" : "s"} picked
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {routing.chosen_ids.map((pid) => {
                  const a = agentById.get(pid);
                  return (
                    <span
                      key={pid}
                      className="border-[2px] border-[#1f2a3c] bg-[#e8f1ff] px-2 py-0.5 font-mono text-[10px] font-bold"
                    >
                      {a?.display_name ?? pid.slice(0, 6)}
                    </span>
                  );
                })}
              </div>
              {routing.reasoning && (
                <p className="mt-1 text-xs leading-snug">{routing.reasoning}</p>
              )}
            </div>
          )}

          {/* Answers */}
          <div className="flex flex-col gap-2">
            {answers.map((a, i) => (
              <AnswerCard
                key={`${a.profile_id}-${i}`}
                answer={a}
                agent={agentById.get(a.profile_id)}
              />
            ))}
          </div>
        </div>

        {/* Notices */}
        {(error || rateLimitedRemaining > 0) && (
          <div className="border-t-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-[#6d2d24]">
            {rateLimitedRemaining > 0
              ? `Rate-limited — try again in ${rateLimitedRemaining}s (6 consults/hour)`
              : error}
          </div>
        )}

        {/* Composer */}
        <div className="flex items-end gap-2 border-t-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="What's on your mind?"
            rows={2}
            disabled={busy}
            className="w-full resize-none border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2 text-sm shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98] disabled:opacity-60"
          />
          <button
            type="button"
            onClick={send}
            disabled={busy || !draft.trim() || rateLimitedRemaining > 0}
            className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-2 font-mono text-xs font-bold uppercase shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "…" : "Ask"}
          </button>
        </div>
      </div>
    </div>
  );
}

function VerdictCard({
  verdict,
  agentById,
}: {
  verdict: VerdictFrame;
  agentById: Map<string, ConsultAgent>;
}) {
  const conf = Math.round(verdict.confidence * 100);
  return (
    <div className="mb-3 border-[3px] border-[#1f2a3c] bg-[#fffdf2] p-3 shadow-[4px_4px_0_#1f2a3c]">
      <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]">
        Verdict · {verdict.consensus} · {verdict.mode} · {conf}%
      </p>
      <p className="mt-1 text-base font-bold leading-snug">
        {verdict.headline}
      </p>
      {verdict.summary && (
        <p className="mt-1 text-sm leading-snug">{verdict.summary}</p>
      )}
      {verdict.personal_context && (
        <p className="mt-2 text-xs italic leading-snug text-[#1f2a3c]">
          {verdict.personal_context}
        </p>
      )}
      {verdict.personal_facts.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {verdict.personal_facts.map((f, i) => (
            <li
              key={i}
              className="font-mono text-[10px] uppercase tracking-wider text-[#637387]"
            >
              · {f}
            </li>
          ))}
        </ul>
      )}
      {verdict.takeaways.length > 0 && (
        <div className="mt-2 space-y-1 border-t-[2px] border-[#1f2a3c] pt-2">
          {verdict.takeaways.map((t, i) => {
            const a = agentById.get(t.profile_id);
            return (
              <div key={i} className="text-xs leading-snug">
                <span className="font-mono text-[10px] font-bold uppercase tracking-wider">
                  {a?.display_name ?? t.profile_id.slice(0, 6)} · {t.keyword}
                </span>
                <span className="ml-1">{t.summary}</span>
              </div>
            );
          })}
        </div>
      )}
      {verdict.disagreements.length > 0 && (
        <div className="mt-2 border-t-[2px] border-[#1f2a3c] pt-2">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#6d2d24]">
            Disagreements
          </p>
          <ul className="mt-1 space-y-0.5">
            {verdict.disagreements.map((d, i) => (
              <li key={i} className="text-xs leading-snug">
                · {d}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AnswerCard({
  answer,
  agent,
}: {
  answer: AnswerFrame;
  agent: ConsultAgent | undefined;
}) {
  const sprite = agent?.sprite_url || agent?.placeholder_sprite_url || "";
  const conf = Math.round((answer.confidence || 0) * 100);
  return (
    <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-3 shadow-[3px_3px_0_#1f2a3c]">
      <div className="flex items-center gap-2">
        {sprite && (
          <div className="border-[2px] border-[#1f2a3c] bg-[#f6f4ea] p-0.5">
            <SpriteFrame
              src={sprite}
              size={1.5}
              title={agent?.display_name ?? ""}
            />
          </div>
        )}
        <p className="text-sm font-bold leading-tight">
          {agent?.display_name ?? answer.profile_id.slice(0, 6)}
          {answer.pending && (
            <span className="ml-2 inline-block h-2 w-2 animate-pulse bg-[#1f2a3c]" />
          )}
          {!answer.pending && (
            <span className="ml-2 font-mono text-[10px] font-bold uppercase tracking-wider text-[#637387]">
              {conf}%
            </span>
          )}
        </p>
      </div>
      {answer.error ? (
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24]">
          {answer.error}
        </p>
      ) : (
        !answer.pending && (
          <>
            {answer.position && (
              <p className="mt-1 text-sm font-bold leading-snug">
                {answer.position}
              </p>
            )}
            {answer.reasoning && (
              <p className="mt-1 text-sm leading-snug">{answer.reasoning}</p>
            )}
            {answer.angle && (
              <p className="mt-1 text-xs italic leading-snug text-[#637387]">
                Angle: {answer.angle}
              </p>
            )}
            {answer.personal_note && (
              <p className="mt-1 text-xs leading-snug text-[#1f2a3c]">
                {answer.personal_note}
              </p>
            )}
            {answer.caveats.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {answer.caveats.map((c, i) => (
                  <li
                    key={i}
                    className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]"
                  >
                    · {c}
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      )}
    </div>
  );
}
