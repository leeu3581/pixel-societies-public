"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import WorldGraphOverlay from "@/components/WorldGraphOverlay";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

type Insight = {
  id: string; kind: string; title: string; summary: string; confidence: string;
  uncertainty: string; evidence_ids: string[]; topics: string[]; workstream: string;
  next_step: string; observed_at: string; status: string; review: string; basis: string;
};
type PublicationDraft = { id: string; label: string; text: string; reading?: string; section: "building" | "approach" | "thinking" | "values" };
type Evidence = { id: string; text: string; observed_at: string; authorship: string; project: string; source_kind: string };
type Memory = {
  wiki_status?: string;
  publication_preview?: { revision: number; items: PublicationDraft[] };
  status: string; revision: number; error: string | null; insights?: Insight[]; evidence?: Evidence[];
  person: { display_name: string | null; photo_url: string | null };
  sources: { id: string; kind: string; label: string; created_at: string }[];
  signals: { id: string; insight_id: string; body: string; purpose: string; group_slug: string; expires_at: string }[];
};
const GROUPS = [
  { kind: "workstream", label: "What you’re building", color: "#6ee7c8" },
  { kind: "capability", label: "What you can do", color: "#8cbcff" },
  { kind: "interest", label: "What draws you in", color: "#c4a5ff" },
  { kind: "need", label: "Where help matters", color: "#f8c77c" },
  { kind: "offer", label: "What you can offer", color: "#f4a4c7" },
  { kind: "intent", label: "Where you’re heading", color: "#b9df87" },
  { kind: "question", label: "Still to understand", color: "#a5b4c5" },
];
const READINGS = {
  building: { name: "What you’re building", glyph: "↗", color: "#e8edf9", ink: "#415c8d" },
  approach: { name: "How you build", glyph: "✳", color: "#e8efdf", ink: "#50683c" },
  thinking: { name: "On your mind", glyph: "✦", color: "#eee5f5", ink: "#77578c" },
  values: { name: "What matters to you", glyph: "◈", color: "#f8e9da", ink: "#95613c" },
};
const ROOT = "/api/me/memory";
const btn = "rounded-sm border border-stone-300 px-3 py-2 text-sm transition hover:bg-stone-100 disabled:opacity-40";
function date(value: string) { return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }

export default function TwinMemory({ refreshKey = 0 }: { refreshKey?: number; compact?: boolean }) {
  const [data, setData] = useState<Memory | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteKind, setNoteKind] = useState("workstream");
  const [editing, setEditing] = useState(false);
  const [correction, setCorrection] = useState("");
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<{ revision: number; items: PublicationDraft[] } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const [showGraph, setShowGraph] = useState(false);
  const [requested, setRequested] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [readingFilter, setReadingFilter] = useState("all");
  const [editingReading, setEditingReading] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const next = await apiGet<Memory>(ROOT);
    setData(next); setError("");
    if (["ready", "failed", "empty"].includes(next.status)) setRequested(false);
  }, []);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh, refreshKey]);
  useEffect(() => {
    if (!requested && !["pending", "analyzing"].includes(data?.status ?? "") && !["pending", "building"].includes(data?.wiki_status ?? "")) return;
    const timer = setInterval(() => { void refresh().catch(e => setError(e.message)); }, 2500);
    return () => clearInterval(timer);
  }, [data?.status, data?.wiki_status, requested, refresh]);
  useEffect(() => {
    const update = () => { void refresh().catch(e => setError(e.message)); };
    window.addEventListener("twin-memory-updated", update);
    return () => window.removeEventListener("twin-memory-updated", update);
  }, [refresh]);
  const insights = useMemo(() => data?.insights ?? [], [data?.insights]);
  const active = insights.find(i => i.id === selected) ?? insights[0] ?? null;
  const eligible = insights.filter(i => i.status !== "historical");
  const chosen = eligible.filter(i => !unchecked.has(i.id));
  const drafts = preview?.revision === data?.revision ? preview?.items ?? [] : [];
  const previewReady = eligible.length > 0 && eligible.every(i => drafts.some(d => d.id === i.id));
  useEffect(() => {
    if (data?.status !== "ready" || !data.insights?.some(i => i.status !== "historical")) return;
    let alive = true;
    void apiPost<{ revision: number; items: PublicationDraft[] }>(ROOT + "/publication-preview", { revision: data.revision })
      .then(result => { if (alive) { setPreview(result); setPreviewError(""); } })
      .catch(e => { if (alive) setPreviewError(e instanceof Error ? e.message : "Could not prepare profile text."); });
    return () => { alive = false; };
  }, [data?.revision, data?.status, previewAttempt]); // eslint-disable-line react-hooks/exhaustive-deps
  function editDraft(id: string, patch: Partial<PublicationDraft>) {
    setPreview(old => old ? { ...old, items: old.items.map(d => d.id === id ? { ...d, ...patch } : d) } : old);
  }
  async function publishSelected() {
    if (!data || !previewReady || !chosen.length) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiPost<{ count: number }>(ROOT + "/publish-selected", {
        revision: data.revision, group_slug: "cofounder-cafe",
        items: chosen.map(i => drafts.find(d => d.id === i.id)),
      });
      await refresh();
      setNotice(`${result.count} notes published. Your wiki is now finding the concepts and connections.`);

    } catch (e) { setError(e instanceof Error ? e.message : "Nothing was published. Please retry."); }
    finally { setBusy(false); }
  }
  const refs = (data?.evidence ?? []).filter(e => active?.evidence_ids.includes(e.id));
  const select = (id: string) => { setSelected(id); setEditing(false); };
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Please retry."); }
    finally { setBusy(false); }
  }
  async function analyze() {
    setBusy(true); setError("");
    try { await apiPost(ROOT + "/analyze", {}); setRequested(true); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not start analysis"); }
    finally { setBusy(false); }
  }
  async function review(action: string) {
    if (!active || !data) return;
    await run(async () => {
      await apiPatch(ROOT + `/insights/${active.id}`, { revision: data.revision, action, summary: action === "correct" ? correction : null });
      setEditing(false);
    });
  }
  const processing = requested || data?.status === "analyzing";
  return <section className="ph-no-capture ph-mask overflow-hidden rounded-sm border border-stone-300 bg-[#fffaf0] text-[#1f2a3c] shadow-sm" aria-label="Your private understanding">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-stone-200 px-6 py-5">
      <div><p className="text-[10px] font-semibold uppercase tracking-[.23em] text-[#476543]">Your notebook</p>
        <h2 className="serif-display mt-2 text-3xl tracking-tight">A few things about you</h2>
        <p className="mt-2 max-w-xl text-sm text-stone-600">All current notes are selected. Uncheck what you want to keep private, then publish the rest together.</p></div>
      <span className="rounded-full border border-[#6ee7c8]/30 bg-[#6ee7c8]/5 px-3 py-1 text-xs text-[#476543]">Only you can see this</span>
    </header>
    {error && <p role="alert" className="m-5 rounded-sm bg-red-400/10 p-3 text-sm text-red-700">{error} <button className="underline" onClick={() => void refresh().catch(e => setError(e.message))}>Retry</button></p>}
    {!data && !error && <p className="p-8 text-stone-600">Loading your understanding…</p>}
    {data && <>
      <div className="flex flex-wrap items-center gap-3 px-6 py-4 text-xs text-stone-600">
        <span>{data.sources.length} private sources</span><span>·</span><span>{insights.length} interpretations</span><span>·</span><span>{insights.filter(i => i.review !== "unreviewed").length} reviewed by you</span>
        {data.sources.length > 0 && <button className="ml-auto text-[#476543] underline disabled:opacity-40" disabled={processing || busy} onClick={analyze}>Read again</button>}
      </div>
      {(processing || data.status === "pending") && <div role="status" className="mx-6 mb-4 rounded-sm border border-[#6ee7c8]/20 bg-[#6ee7c8]/5 p-4">
        <p className="font-medium text-[#476543]">{processing ? "Reading your notes…" : "New evidence is ready to interpret"}</p>
        <p className="mt-1 text-sm text-stone-600">You can leave this page and come back. Your notes are saved.</p>
        {!processing && <button className={btn + " mt-3"} disabled={busy} onClick={analyze}>Read my notes</button>}
      </div>}
      {data.status === "failed" && <div className="mx-6 mb-4 rounded-sm bg-amber-300/10 p-4"><p className="text-sm text-amber-800">{data.error}</p><button className={btn + " mt-3"} disabled={busy} onClick={analyze}>Retry analysis</button></div>}
      {insights.length > 0 ? <>
        <div className="flex flex-wrap gap-2 px-6 pb-3" aria-label="Map categories">
          <button onClick={() => setFilter("all")} className={btn + (filter === "all" ? " bg-stone-100" : "")}>Whole picture</button>
          {GROUPS.filter(g => insights.some(i => i.kind === g.kind)).map(g => <button key={g.kind} onClick={() => setFilter(g.kind)} className={btn + (filter === g.kind ? " bg-stone-100" : "")} style={{ color: g.color }}>{g.label}</button>)}
        </div>
        <div className="px-6 pb-5"><button className={btn + " text-[#476543]"} onClick={() => setShowGraph(true)}>Open your wiki graph</button><p className="mt-2 text-xs text-stone-600">Your approved notes become named concepts and connected pages in a second synthesis pass.</p></div>
        {["pending", "building"].includes(data.wiki_status ?? "") && <p role="status" className="px-6 pb-4 text-sm text-[#476543]">Finding the concepts and connections for your wiki… Your notes are published; the richer graph will be ready shortly.</p>}
        {data.wiki_status === "failed" && <button className={btn + " mx-6 mb-4"} onClick={() => run(async () => { await apiPost(ROOT + "/wiki", {}); setRequested(true); })}>Retry wiki synthesis</button>}
        {showGraph && <WorldGraphOverlay key={`${data.revision}-${data.wiki_status}`} onClose={() => setShowGraph(false)} />}
        <div className="grid gap-5 border-t border-stone-200 p-5 lg:grid-cols-[.85fr_1.15fr]">
          <div className="max-h-[500px] space-y-2 overflow-y-auto" aria-label="Interpretations">
            {insights.filter(i => filter === "all" || i.kind === filter).map(i => {
              const draft = drafts.find(d => d.id === i.id);
              const published = data.signals.some(signal => signal.insight_id === i.id);
              return <div key={i.id} className={`flex items-start gap-3 rounded-sm border p-4 transition ${active?.id === i.id ? "border-stone-500 bg-[#f1eadc]" : "border-stone-200 hover:bg-stone-100"}`}>
                <input type="checkbox" aria-label={`Publish ${i.title}`} checked={i.status !== "historical" && !unchecked.has(i.id)} disabled={busy || i.status === "historical"} onChange={() => setUnchecked(old => { const next = new Set(old); if (next.has(i.id)) next.delete(i.id); else next.add(i.id); return next; })} className="mt-1 h-4 w-4 shrink-0 accent-[#476543]" />
                <button onClick={() => select(i.id)} className="min-w-0 flex-1 text-left">
                  <span className="text-[10px] uppercase tracking-widest">{GROUPS.find(g => g.kind === i.kind)?.label || i.kind}{published ? " · published" : ""}</span>
                  <h3 className="mt-1 text-sm font-medium">{draft?.label || i.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-stone-700">{draft?.text || i.summary}</p>
                  <p className="mt-2 text-[10px] text-stone-500">{i.status === "historical" ? "Historical · add current context before publishing" : `${i.evidence_ids.length} sources · ${published ? "Already shared; unchecking does not unpublish" : "Preview of what people will see"}`}</p>
                </button>
              </div>;
            })}
          </div>
          {active ? <article className="rounded-sm border border-stone-200 bg-[#fffdf7] p-5" aria-label="Insight details">
            <p className="text-xs uppercase tracking-widest text-[#476543]">{data.signals.some(s => s.insight_id === active.id) ? "Published in the cafe" : active.review === "unreviewed" ? "Draft · only you" : "Saved · only you"}</p>
            <h3 className="mt-3 text-xl font-medium">{drafts.find(d => d.id === active.id)?.label || active.title}</h3><p className="mt-3 text-sm leading-relaxed text-stone-800">{drafts.find(d => d.id === active.id)?.text || active.summary}</p>
            {active.workstream && <p className="mt-2 text-xs text-stone-600">Workstream: {active.workstream}</p>}
            <p className="mt-3 text-xs text-stone-600">Evidence last observed {date(active.observed_at)}. {active.status === "historical" && "This is not assumed to be current."}</p>
            <details className="mt-5"><summary className="cursor-pointer text-sm text-[#476543]">Sources & caveats ({refs.length})</summary>
              <p className="mt-3 text-sm text-stone-600">{active.uncertainty}</p><div className="mt-3 space-y-3">{refs.map(e => <blockquote className="border-l-2 border-emerald-200/30 pl-3" key={e.id}><p className="text-[10px] uppercase text-stone-500">{e.source_kind} · {e.authorship.replaceAll("_", " ")} · {date(e.observed_at)}</p><p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-stone-700">{e.text}</p></blockquote>)}</div>
            </details>
            <div className="mt-5 flex flex-wrap gap-2">
              <button className={btn} disabled={busy} onClick={() => review("confirm")}>Keep this</button>
              <button className={btn} disabled={busy} onClick={() => { setCorrection(active.summary); setEditing(true); }}>Edit</button>
              <button className={btn} disabled={busy} onClick={() => review("dismiss")}>Not me</button>
              <button className={btn} disabled={busy} onClick={() => review("resolve")}>Archive</button>
            </div>
            {editing && <div className="mt-3"><label className="text-sm">Your correction<textarea className="mt-2 w-full rounded border border-stone-300 bg-white p-3 text-sm" rows={4} maxLength={650} value={correction} onChange={e => setCorrection(e.target.value)} /></label><button className={btn} disabled={busy || correction.trim().length < 10} onClick={() => review("correct")}>Save correction</button></div>}
            {drafts.find(d => d.id === active.id) && <details className="mt-5 border-t border-stone-200 pt-4">
              <summary className="cursor-pointer text-sm text-[#476543]">Edit the text people will see</summary>
              <label className="mt-3 block text-xs">Graph label<input value={drafts.find(d => d.id === active.id)?.label || ""} maxLength={40} onChange={e => editDraft(active.id, { label: e.target.value })} className="mt-2 w-full border border-stone-300 bg-white p-2 text-sm" /></label>
              <label className="mt-3 block text-xs">Shared note<textarea rows={4} maxLength={650} value={drafts.find(d => d.id === active.id)?.text || ""} onChange={e => editDraft(active.id, { text: e.target.value })} className="mt-2 w-full border border-stone-300 bg-white p-3 text-sm" /></label>
              <p className="mt-2 text-xs text-stone-500">This exact text is published when you choose Publish selected.</p>
            </details>}
          </article> : <div className="flex min-h-48 items-center justify-center rounded-sm border border-dashed border-stone-300 p-6 text-center text-sm text-stone-600">Select a note to read it, edit it or publish it.</div>}
        </div>
      </> : !processing && <div className="px-6 py-8"><h3 className="text-lg">Start with something real.</h3><p className="mt-2 text-sm text-stone-600">Import selected sessions or describe what you’re working on. We’ll show supported interpretations here, not invent a personality from your tools.</p>{data.status === "ready" && <p className="mt-2 text-sm text-amber-800">There wasn’t enough evidence for a useful interpretation. Add a concrete goal or current problem below.</p>}</div>}
      <div className="space-y-4 border-t border-stone-200 p-6">
        <div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-[#637653]">Between the lines</p><h3 className="serif-display mt-2 text-3xl">More about you</h3><p className="mt-2 text-sm text-stone-500">A few things coming through in your work. Sound like you?</p></div><span aria-hidden="true" className="text-4xl text-[#a38cbd]">✳</span></div>
        <div className="flex flex-wrap gap-2" aria-label="Reading categories">
          <button onClick={() => setReadingFilter("all")} aria-pressed={readingFilter === "all"} className={`rounded-full border px-3 py-1.5 text-xs ${readingFilter === "all" ? "border-[#1f2a3c] bg-[#1f2a3c] text-white" : "border-stone-300"}`}>All readings</button>
          {Object.entries(READINGS).map(([key, style]) => <button key={key} onClick={() => setReadingFilter(key)} aria-pressed={readingFilter === key} className="rounded-full border px-3 py-1.5 text-xs" style={{ background: readingFilter === key ? style.color : undefined, borderColor: readingFilter === key ? style.ink : "#d6d3d1" }}>{style.name}</button>)}
        </div>
        {!previewReady ? <p className="py-8 text-sm text-stone-500">{eligible.length ? "Finding the patterns in your sessions…" : "Your readings will grow as you add your work."}</p>
          : <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {drafts.filter(d => readingFilter === "all" || d.section === readingFilter).map(d => {
              const style = READINGS[d.section] || READINGS.thinking;
              const included = !unchecked.has(d.id);
              return <article key={d.id} className={`relative rounded-xl border p-5 transition ${included ? "border-stone-300" : "border-dashed border-stone-300 opacity-55"}`} style={{ background: included ? style.color : "#faf8f3" }}>
                <div className="flex items-center justify-between gap-3"><span className="text-[10px] uppercase tracking-widest" style={{ color: style.ink }}>{style.name}</span><input type="checkbox" aria-label={`Include reading: ${d.label}`} checked={included} disabled={busy} onChange={() => setUnchecked(old => { const next = new Set(old); if (next.has(d.id)) next.delete(d.id); else next.add(d.id); return next; })} className="h-4 w-4 accent-[#476543]" /></div>
                <span aria-hidden="true" className="mt-4 block text-3xl" style={{ color: style.ink }}>{style.glyph}</span>
                <h4 className="serif-display mt-3 text-2xl leading-tight tracking-tight">{d.reading || d.label}</h4>
                <p className="mt-3 text-sm leading-6 text-stone-600">{d.text}</p>
                <div className="mt-5 flex items-center justify-between border-t border-black/10 pt-3"><button className="text-xs underline decoration-stone-400 underline-offset-4" onClick={() => { select(d.id); document.querySelector('[aria-label="Insight details"]')?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>Why this?</button><button className="text-xs underline decoration-stone-400 underline-offset-4" aria-expanded={editingReading === d.id} onClick={() => setEditingReading(editingReading === d.id ? null : d.id)}>{editingReading === d.id ? "Done editing" : "Make it yours"}</button></div>
                {editingReading === d.id && <div className="mt-4 space-y-3"><label className="block text-xs">Your headline<input aria-label={`Reading headline: ${d.label}`} value={d.reading || d.label} maxLength={75} disabled={busy} onChange={e => editDraft(d.id, { reading: e.target.value })} className="mt-2 w-full rounded border border-stone-300 bg-white/80 p-2 text-sm" /></label><label className="block text-xs">What you’ll publish<textarea aria-label={`Reading text: ${d.label}`} value={d.text} rows={4} maxLength={650} disabled={busy} onChange={e => editDraft(d.id, { text: e.target.value })} className="mt-2 w-full resize-y rounded border border-stone-300 bg-white/80 p-3 text-sm leading-6" /></label></div>}
              </article>;
            })}
            {readingFilter !== "all" && !drafts.some(d => d.section === readingFilter) && <p className="py-8 text-sm text-stone-500">Still getting to know this side of you.</p>}
          </div>}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-stone-200 bg-[#f6f3e9] px-6 py-4">
          <div><p className="text-sm">{chosen.length} of {eligible.length} current notes selected <button className="ml-3 text-xs underline" disabled={busy} onClick={() => setUnchecked(new Set())}>Select all</button><button className="ml-3 text-xs underline" disabled={busy} onClick={() => setUnchecked(new Set(eligible.map(i => i.id)))}>Clear selection</button></p>
          <p className="mt-1 max-w-xl text-xs leading-5 text-stone-600">Visible to cafe members and their matching agents. Only the preview text is published; your original session excerpts stay private.</p>
          {!previewReady && eligible.length > 0 && !previewError && <p role="status" className="mt-2 text-xs text-[#476543]">Preparing concise profile text…</p>}
          {previewError && <p role="alert" className="mt-2 text-xs text-red-700">{previewError} <button className="underline" onClick={() => { setPreviewError(""); setPreviewAttempt(n => n + 1); }}>Retry wording</button></p>}
          {notice && <p role="status" className="mt-2 text-sm text-[#476543]">{notice}</p>}</div>
          <button className={btn + " ml-auto bg-[#dcebd8] text-[#294726]"} disabled={busy || !previewReady || chosen.length === 0 || chosen.some(i => { const d = drafts.find(d => d.id === i.id); return !d || d.text.trim().length < 10 || d.label.trim().length < 2 || d.label.trim().split(/\s+/).length > 5; })} onClick={publishSelected}>{busy ? "Saving…" : `Publish selected (${chosen.length})`}</button>
        </div>
        {data.signals.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-4"><p className="text-sm">Your profile is published. Find someone worth a conversation.</p><Link href="/worlds/cofounder-cafe?matches=mine" className={btn + " bg-[#dcebd8] text-[#294726]"}>Explore current matches →</Link></div>}
        <details className="border-t border-stone-200 pt-4"><summary className="cursor-pointer text-sm text-[#476543]">Add something your sessions haven’t captured</summary>
        <label className="block text-xs text-stone-600">Type<select className="ml-3 rounded bg-white p-2 text-stone-800" value={noteKind} onChange={e => setNoteKind(e.target.value)}>{GROUPS.map(g => <option key={g.kind} value={g.kind}>{g.label}</option>)}</select></label>
        <textarea aria-label="Private current context" value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={4000} placeholder="A current project, a question on your mind, or something you care about…" className="w-full rounded-sm border border-stone-300 bg-white p-4 text-sm outline-none focus:border-emerald-300/50" />
        <p className="text-xs text-stone-500">Private analysis sends redacted evidence to the configured AI provider. Nothing is shared for discovery until you approve it.</p>
        <div className="flex flex-wrap gap-3"><button className={btn + " border-emerald-300/30 text-[#476543]"} disabled={busy || processing || note.trim().length < 10} onClick={() => run(async () => { await apiPost(ROOT + "/notes", { text: note, kind: noteKind }); setNote(""); setRequested(true); })}>Add note</button><Link href="/onboarding/history" className={btn}>Import more sessions</Link><Link href="/profile#gmail-context" className={btn}>Connect Gmail</Link></div>
        </details>
        {data.signals.length > 0 && <div className="space-y-2"><h4 className="text-sm text-[#476543]">Published in the cafe</h4>{data.signals.map(s => <div key={s.id} className="rounded border border-stone-200 p-3 text-xs"><p>{s.body}</p><p className="mt-2 text-stone-600">Refresh by {date(s.expires_at)}</p><button className="mt-2 text-amber-800 underline" disabled={busy} onClick={() => run(async () => { await apiDelete(ROOT + `/signals/${s.id}`); })}>Unpublish</button></div>)}</div>}
        <button className="text-xs text-stone-600 underline" onClick={() => setShowSources(!showSources)}>Manage {data.sources.length} private sources</button>
        {showSources && <div className="space-y-2">{data.sources.map(s => <div key={s.id} className="flex items-center justify-between gap-3 rounded border border-stone-200 p-3 text-xs"><span>{s.label} · {date(s.created_at)}</span><button className="text-red-700 underline" disabled={busy} onClick={() => { if (window.confirm("Remove this source? Its analysis and discovery permissions will be cleared. You can rebuild from remaining sources.")) void run(async () => { await apiDelete(ROOT + `/sources/${s.id}`); setSelected(null); }); }}>Remove source</button></div>)}</div>}
      </div>
    </>}
  </section>;
}
