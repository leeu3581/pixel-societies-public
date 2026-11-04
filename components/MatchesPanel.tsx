"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { apiGet, apiPost } from "@/lib/api";

type Introduction = {
  id: string; name: string; photo_url?: string | null; purpose: string; reason: string; your_signal: string;
  their_signal: string; availability: string; next_step: string; uncertainty: string;
  expires_at: string; feedback: string | null;
  relationship?: "shared_direction" | "complementary_strengths";
  bridge?: string; own_label?: string; peer_label?: string;
  curated?: boolean; canonical_id?: string; headline?: string; bio?: string;
  focus?: string[]; your_topics?: string[]; possibility?: string; contribution?: string; discussion?: string[];
};
type Person = { display_name?: string | null; photo_url?: string | null };
type Props = {
  open: boolean; onClose: () => void; slug: string;
  agentId?: string | null; onSelectAgent?: (id: string | null) => void;
  agents?: { id: string; name: string; canonicalId?: string | null }[]; onOpenProfile?: (id: string) => void;
};
const button = "border-2 border-[#1f2a3c] px-3 py-2 font-mono text-xs hover:bg-[#e9e4d7] disabled:opacity-40";
const relationship = (i: Introduction) => i.relationship === "complementary_strengths" ? "Complementary strengths" : "Shared direction";

type Point = { x: number; y: number };
function edgeBetween(a: Point, b: Point, start = 0, end = 0) {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
  return { x1: a.x + dx * start, y1: a.y + dy * start, x2: b.x - dx * end, y2: b.y - dy * end };
}
function graphLines(text: string, width = 23) {
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (lines.length && (lines[lines.length - 1] + " " + word).length <= width) lines[lines.length - 1] += " " + word;
    else lines.push(word);
  }
  return lines;
}
function ConnectionMap({ item, person, onEvidence }: { item: Introduction; person: Person; onEvidence: () => void }) {
  const complement = item.relationship === "complementary_strengths";
  const key = item.canonical_id || item.name;
  const seed = [...key].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const variant = seed % 3;
  // Each person's neighbourhood has its own stable shape. Positions are kept
  // apart for legible labels; the nodes themselves come only from profile data.
  const own = { x: 173, y: 180 };
  const peer = [{ x: 600, y: 145 }, { x: 585, y: 210 }, { x: 592, y: 160 }][variant];
  const ownConcept = { x: 290, y: 280 };
  const peerConcept = [{ x: 485, y: 270 }, { x: 460, y: 155 }, { x: 480, y: 295 }][variant];
  const shared = { x: 385, y: 240 };
  const ownPositions = [{ x: 92, y: 80 }, { x: 265, y: 85 }, { x: 75, y: 290 }];
  const peerPositions = [
    [{ x: 490, y: 73 }, { x: 686, y: 80 }, { x: 685, y: 250 }],
    [{ x: 575, y: 72 }, { x: 695, y: 150 }, { x: 680, y: 320 }],
    [{ x: 480, y: 80 }, { x: 685, y: 95 }, { x: 690, y: 275 }],
  ][variant];
  const peerColor = ["#52a982", "#9674b4", "#c18a56"][variant];
  const ownTopics = [...new Set(item.your_topics || [])].slice(0, 3);
  const peerTopics = [...new Set(item.focus || [])].slice(0, 3);
  const satellites = [
    ...ownTopics.map((label, i) => ({ ...ownPositions[i], label, hub: own, color: "#89a8df" })),
    ...peerTopics.map((label, i) => ({ ...peerPositions[i], label, hub: peer, color: peerColor })),
  ];
  const portraits = [
    { ...own, name: person.display_name || "You", photo: person.photo_url, clip: "match-you", color: "#4a7de8" },
    { ...peer, name: item.name, photo: item.photo_url, clip: "match-peer", color: peerColor },
  ];
  const label = (text: string, at: Point, color = "#526578", width = 23) => <text x={at.x} y={at.y} textAnchor="middle" fontSize="12" fill={color} stroke="#eaf0ef" strokeWidth="4" paintOrder="stroke" strokeLinejoin="round">{graphLines(text, width).map((line, i) => <tspan key={i} x={at.x} dy={i ? 16 : 0}>{line}</tspan>)}</text>;
  return <div className="border-b-2 border-[#1f2a3c] bg-[linear-gradient(180deg,#dcecf4,#f6f4ea)]">
    <div className="flex items-center justify-between gap-3 px-5 pt-4"><p className="font-mono text-[10px] uppercase tracking-widest text-[#526578]">Where your worlds connect</p><span className="text-[10px] text-[#637387]">{complement ? "Different strengths, a possible exchange" : "A direction you share"}</span></div>
    <svg viewBox="0 0 760 395" className="w-full" role="img" aria-label={`${person.display_name || "You"} and ${item.name}: ${item.bridge || relationship(item)}`}>
      <defs>{portraits.map(p => <clipPath key={p.clip} id={p.clip}><circle cx={p.x} cy={p.y} r="34" /></clipPath>)}</defs>
      {/* Every edge is behind every portrait, and stops at the portrait rim. */}
      <g fill="none" stroke="#9aaebd" strokeWidth="1.25">
        {satellites.map((n, i) => <line key={i} {...edgeBetween(n.hub, n, 43, 8)} />)}
        {complement ? <>
          <line {...edgeBetween(own, ownConcept, 43, 12)} /><line {...edgeBetween(peer, peerConcept, 43, 12)} />
          <path d={`M ${ownConcept.x + 14} ${ownConcept.y} Q 385 ${variant === 1 ? 210 : 205} ${peerConcept.x - 14} ${peerConcept.y}`} stroke={peerColor} strokeWidth="2.5" strokeDasharray="6 5" />
        </> : <><line {...edgeBetween(own, shared, 43, 18)} stroke="#689c81" strokeWidth="2" /><line {...edgeBetween(peer, shared, 43, 18)} stroke="#689c81" strokeWidth="2" /><line {...edgeBetween(own, { x: 215, y: 300 }, 43, 7)} /><line {...edgeBetween(peer, { x: 550, y: 300 }, 43, 7)} /></>}
      </g>
      {satellites.map((n, i) => <g key={i}><circle cx={n.x} cy={n.y} r={6 + i % 3} fill={n.color} opacity=".85" />{label(n.label, { x: n.x, y: n.y + 23 }, "#526578", 19)}</g>)}
      {complement ? <>
        <circle cx={ownConcept.x} cy={ownConcept.y} r="12" fill="#4a7de8" />
        <circle cx={peerConcept.x} cy={peerConcept.y} r="12" fill={peerColor} />
        {label(item.own_label || "Your current work", { x: ownConcept.x, y: ownConcept.y + 28 }, "#1f2a3c", 25)}
        {label(item.peer_label || "Their perspective", { x: peerConcept.x, y: peerConcept.y + 28 }, "#1f2a3c", 25)}
      </> : <>
        <circle cx={shared.x} cy={shared.y} r="24" fill="#dcebd8" /><circle cx={shared.x} cy={shared.y} r="13" fill="#69a683" />
        {label(item.bridge || "Shared direction", { x: shared.x, y: shared.y + 45 }, "#1f2a3c", 26)}
        <circle cx="215" cy="300" r="7" fill="#89a8df" /><circle cx="550" cy="300" r="7" fill={peerColor} />
        {label(item.own_label || "Your current work", { x: 215, y: 325 }, "#526578", 24)}
        {label(item.peer_label || "Their current work", { x: 550, y: 325 }, "#526578", 24)}
      </>}
      {portraits.map(p => <g key={p.clip}>
        <circle cx={p.x} cy={p.y} r="43" fill="#eaf0ef" /><circle cx={p.x} cy={p.y} r="39" fill={p.color} stroke="#1f2a3c" strokeWidth="2.5" />
        {p.photo ? <image href={p.photo} x={p.x - 34} y={p.y - 34} width="68" height="68" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${p.clip})`} /> : <text x={p.x} y={p.y + 9} textAnchor="middle" fontSize="25" fill="white">{p.name.charAt(0)}</text>}
        <text x={p.x} y={p.y + 62} textAnchor="middle" fontFamily="monospace" fontSize="17" fill="#1f2a3c" stroke="#eaf0ef" strokeWidth="5" paintOrder="stroke" strokeLinejoin="round">{p.name.length > 24 ? p.name.slice(0, 22) + "…" : p.name}</text>
      </g>)}
    </svg>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#9aaebd]/30 px-5 py-3"><p className="font-mono text-sm text-[#1f2a3c]">{item.bridge || relationship(item)}</p><button onClick={onEvidence} className="text-xs text-[#476543] underline">Read the two profile notes ↗</button></div>
  </div>;
}

export default function MatchesPanel({ open, onClose, slug, agents, onOpenProfile }: Props) {
  const [items, setItems] = useState<Introduction[]>([]);
  const [person, setPerson] = useState<Person>({});
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [evidence, setEvidence] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const evidenceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError(""); setItems([]); setSelected(null); setEvidence(false);
    apiGet<{ introductions: Introduction[]; message: string | null; person?: Person }>(`/api/world-groups/by-slug/${encodeURIComponent(slug)}/introductions`)
      .then(d => { if (active) { setItems(d.introductions.map(i => { if (!i.curated) return i; try { return { ...i, feedback: localStorage.getItem(`connection:${i.id}`) }; } catch { return i; } }).filter(i => i.feedback !== "not_useful")); setPerson(d.person ?? {}); setMessage(d.message ?? ""); } })
      .catch(e => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, slug, attempt]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? []);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, [open, onClose]);
  const visible = items.filter(i => filter === "all" || (i.relationship || "shared_direction") === filter);
  const current = visible.find(i => i.id === selected) || visible[0];
  async function feedback(id: string, outcome: string) {
    setFeedbackBusy(id); setError("");
    try {
      if (items.find(i => i.id === id)?.curated) localStorage.setItem(`connection:${id}`, outcome);
      else await apiPost(`/api/me/introductions/${id}/feedback`, { outcome });
      setItems(old => outcome === "not_useful" ? old.filter(i => i.id !== id) : old.map(i => i.id === id ? { ...i, feedback: outcome } : i));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save feedback"); }
    finally { setFeedbackBusy(null); }
  }
  if (!open) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0c1626]/70 p-3 sm:p-7" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={dialog} tabIndex={-1} className="flex max-h-[92dvh] w-full max-w-6xl flex-col overflow-hidden border-[3px] border-[#1f2a3c] bg-[#fffaf0] text-[#1f2a3c] shadow-[8px_8px_0_#1f2a3c] outline-none" role="dialog" aria-modal="true" aria-label="Current matches">
      <header className="flex items-start justify-between gap-4 border-b-[3px] border-[#1f2a3c] p-5"><div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-[#476543]">Your next conversation</p><h2 className="mt-2 text-2xl font-semibold">Explore current matches</h2><p className="mt-2 text-sm text-[#637387]">Shared direction. Different strengths. A concrete reason to connect.</p></div><button className={button} onClick={onClose}>× Close</button></header>
      <div className="overflow-y-auto">
        {error && <p role="alert" className="m-5 border border-red-700 bg-red-50 p-3 text-sm text-red-900">{error} <button className="underline" onClick={() => setAttempt(a => a + 1)}>Try again</button></p>}
        {loading ? <div role="status" className="flex min-h-80 flex-col items-center justify-center gap-5 p-8 text-center"><div className="flex items-center gap-5" aria-hidden="true"><span className="h-9 w-9 animate-pulse rounded-full bg-[#4a7de8]" /><span className="h-px w-20 bg-[#8193a3]" /><span className="h-9 w-9 animate-pulse rounded-full bg-[#54b684]" /></div><h3 className="text-xl">Finding the connections worth your attention</h3><p className="max-w-md text-sm text-[#637387]">Comparing published work, interests and experience. Looking for shared direction and strengths that could help each other.</p></div>
        : items.length === 0 ? <div className="p-8"><h3 className="text-xl">No supported connections yet</h3><p className="mt-3 max-w-xl text-sm leading-6 text-[#637387]">{message || "Matches need current published context from both people. Add yours and explore again as others share theirs."}</p><Link href="/profile#understanding" className={button + " mt-5 inline-block bg-[#b8f0c8]"}>Review your published profile</Link><button className={button + " ml-3 mt-5"} onClick={() => setAttempt(a => a + 1)}>Refresh matches</button></div>
        : <>
          <nav aria-label="Connection type" className="flex flex-wrap gap-2 border-b border-stone-300 p-4">{[["all", "Strongest connections"], ["shared_direction", "Shared direction"], ["complementary_strengths", "Complementary strengths"]].map(([value, label]) => <button key={value} className={button + (filter === value ? " bg-[#e8d6ff]" : "")} aria-pressed={filter === value} onClick={() => { setFilter(value); setEvidence(false); }}>{label}</button>)}<button className={button + " ml-auto"} onClick={() => setAttempt(a => a + 1)}>Refresh</button></nav>
          <div className="grid lg:grid-cols-[280px_1fr]">
            <aside className="border-b-2 border-[#1f2a3c] p-4 lg:border-b-0 lg:border-r-2" aria-label="Suggested people">
              <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-[#637387]">{visible.length} connections to explore</p>
              {visible.length === 0 && <p className="text-sm text-[#637387]">No supported connection of this kind yet.</p>}
              {visible.map((i, index) => <button key={i.id} onClick={() => { setSelected(i.id); setEvidence(false); }} aria-pressed={current?.id === i.id} className={`mb-3 block w-full border-2 p-4 text-left ${current?.id === i.id ? "border-[#1f2a3c] bg-[#e9f1e4] shadow-[3px_3px_0_#1f2a3c]" : "border-stone-300"}`}><p className="font-mono text-[10px] uppercase text-[#476543]">{index === 0 ? "Start here · " : ""}{relationship(i)}</p><div className="mt-3 flex items-center gap-3">{i.photo_url && <Image src={i.photo_url} alt="" width={48} height={48} unoptimized className="h-12 w-12 rounded-full border-2 border-[#1f2a3c] object-cover" />}<h3 className="text-lg font-semibold">{i.name}</h3></div><p className="mt-3 text-sm font-medium leading-6">{i.bridge || i.reason}</p>{i.headline && <p className="mt-2 text-xs leading-5 text-[#637387]">{i.headline}</p>}</button>)}
            </aside>
            {current && <article>
              <ConnectionMap item={current} person={person} onEvidence={() => { setEvidence(true); requestAnimationFrame(() => evidenceRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })); }} />
              <div className="space-y-5 p-5 sm:p-7">
                {current.bio && <section className="border-b border-stone-300 pb-5"><p className="font-mono text-[10px] uppercase tracking-widest text-[#637387]">Meet {current.name}</p><h3 className="mt-2 text-xl font-semibold">{current.headline}</h3><p className="mt-3 text-sm leading-7">{current.bio}</p><div className="mt-3 flex flex-wrap gap-2">{current.focus?.map(topic => <span key={topic} className="border border-[#a7b6a2] bg-[#edf2e8] px-2 py-1 text-xs">{topic}</span>)}</div>{onOpenProfile && agents?.some(a => a.canonicalId === current.canonical_id) && <button className={button + " mt-4"} onClick={() => { const agent = agents?.find(a => a.canonicalId === current.canonical_id); if (agent) onOpenProfile(agent.id); }}>Open {current.name}’s profile →</button>}</section>}
                <div><p className="font-mono text-[10px] uppercase tracking-widest text-[#476543]">Why this connection</p><h3 className="mt-2 text-xl leading-relaxed">{current.reason}</h3></div>
                <div className="border-l-4 border-[#a58bd5] bg-[#eee7f6] p-4"><p className="font-mono text-[10px] uppercase tracking-widest">A conversation to start</p><p className="mt-2 text-sm leading-6">{current.next_step}</p></div>
                {current.contribution && <div className="grid gap-4 sm:grid-cols-2"><section className="border border-stone-300 p-4"><h4 className="text-sm font-semibold">What they bring</h4><p className="mt-2 text-sm leading-6">{current.contribution}</p></section><section className="border border-stone-300 p-4"><h4 className="text-sm font-semibold">Something to try together</h4><p className="mt-2 text-sm leading-6">{current.possibility}</p></section></div>}
                {current.discussion && <div><p className="font-mono text-[10px] uppercase tracking-widest text-[#637387]">Where the conversation could go</p><div className="mt-3 flex flex-wrap gap-2">{current.discussion.map(t => <span key={t} className="border border-[#b5a6c8] bg-[#eee7f6] px-3 py-2 text-xs">{t}</span>)}</div></div>}
                <div ref={evidenceRef}><button className="text-sm text-[#476543] underline" aria-expanded={evidence} onClick={() => setEvidence(!evidence)}>What connects the two profiles?</button>{evidence && <div className="mt-3 grid gap-3 sm:grid-cols-2"><blockquote className="border border-stone-300 p-4 text-sm leading-6"><span className="mb-2 block font-mono text-[10px] uppercase text-[#637387]">You published</span>{current.your_signal}</blockquote><blockquote className="border border-stone-300 p-4 text-sm leading-6"><span className="mb-2 block font-mono text-[10px] uppercase text-[#637387]">From {current.name}’s profile</span>{current.their_signal}</blockquote></div>}</div>
                <p className="text-xs leading-5 text-[#637387]">{current.uncertainty}</p>
                <div className="flex flex-wrap gap-2">{[["useful", "Worth a conversation"], ["not_useful", "Not for me"], ["contacted", "We talked"]].map(([value, label]) => <button key={value} disabled={feedbackBusy === current.id} className={button + (current.feedback === value ? " bg-[#b8f0c8]" : "")} onClick={() => feedback(current.id, value)}>{label}</button>)}</div>
              </div>
            </article>}
          </div>
        </>}
      </div>
    </div>
  </div>;
}
