"use client";

import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";

type Context = {
  generated_at: string; valid_until: string; window_days: number; messages_considered: number;
  signals: Array<{ kind: string; summary: string; confidence: string; observed_on: string; evidence_ids: string[] }>;
};
type Status = { configured: boolean; connected: boolean; last_sync_at: string | null; last_error: string | null; context: Context | null };
type Preview = { preview_id: string; context: Context; messages_scanned: number };
const PATH = "/api/integrations/gmail";

export default function GmailContext() {
  const [status, setStatus] = useState<Status | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = async () => setStatus(await apiGet<Status>(PATH));
  useEffect(() => { refresh().catch(() => setMessage("Gmail settings are unavailable. Please retry.")); }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); } catch (e) { setMessage(e instanceof Error ? e.message : "Please retry."); }
    finally { setBusy(false); }
  }
  const context = preview?.context ?? status?.context;
  const button = "rounded border border-white/30 px-3 py-2 text-sm disabled:opacity-40";
  return <section className="ph-no-capture ph-mask mt-8 space-y-4 rounded-xl border border-white/20 p-5" aria-label="Gmail twin context">
    <h2 className="text-xl font-semibold">What matters to you now</h2>
    <p className="text-sm text-white/70">Let your twin understand your current projects, priorities, concerns and commitments from Gmail. Review its interpretation before adding it to your twin.</p>
    <p className="text-xs text-white/60">With your permission, our server reads up to 40 recent sent messages. Attachments and quoted replies are excluded where detected. Pattern-redacted text goes to the configured AI provider; redaction cannot remove every private fact. Only the dated context summary is saved, not a mailbox archive. Approved context enriches your private understanding map and conversations with your own twin; it is not shared in public profiles or world conversations. No emails are sent. Refresh is manual.</p>
    {message && <p role="status" className="text-sm text-amber-200">{message}</p>}
    {!status && <button className={button} disabled={busy} onClick={() => run(refresh)}>Reload settings</button>}
    {status && !status.configured && <p className="text-sm">Gmail connection setup is pending.</p>}
    {status?.configured && !status.connected && <button className={button} disabled={busy} onClick={() => run(async () => {
      const result = await apiPost<{ url: string }>(PATH + "/connect", {});
      window.location.assign(result.url);
    })}>Connect Gmail to enrich my twin</button>}
    {status?.connected && <>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">Context window <select className="ml-2 rounded bg-slate-800 p-2" value={days} disabled={busy} onChange={e => { setDays(Number(e.target.value)); }}>
          <option value={7}>Past week</option><option value={30}>Past month</option><option value={90}>Past 3 months</option>
        </select></label>
        <button className={button} disabled={busy} onClick={() => run(async () => {
          setPreview(await apiPost<Preview>(PATH + "/preview", { days, max_messages: 40 }));
        })}>{busy ? "Working…" : "Refresh context preview"}</button>
      </div>
      {status.last_sync_at && <p className="text-xs text-white/60">Last added to twin: {new Date(status.last_sync_at).toLocaleString()}</p>}
      {status.last_error && <p className="text-sm text-amber-200">{status.last_error}</p>}
    </>}
    {context && <div className="space-y-3">
      <h3 className="font-medium">{preview ? "Review proposed context" : "Your twin’s current context"}</h3>
      <p className="text-xs text-white/60">Based on {context.messages_considered} usable messages · {context.window_days}-day window · Historical after {new Date(context.valid_until).toLocaleDateString()}</p>
      {context.signals.length === 0 && <p className="text-sm">Not enough evidence to infer current priorities. Adding this clears the previous Gmail snapshot.</p>}
      {context.signals.map((signal, i) => <div className="rounded bg-white/5 p-3" key={i}>
        <p className="text-xs uppercase text-white/60">{signal.kind} · {signal.confidence} confidence</p>
        <p className="text-sm">{signal.summary}</p>
        <p className="mt-1 text-xs text-white/50">Observed {signal.observed_on} · {signal.evidence_ids.length} supporting message(s)</p>
      </div>)}
    </div>}
    {preview && <div className="flex gap-3">
      <button className={button} disabled={busy} onClick={() => run(async () => {
        await apiPost(PATH + "/commit", { preview_id: preview.preview_id }); setPreview(null); await refresh(); window.dispatchEvent(new Event("twin-memory-updated"));
      })}>Add this context to my twin</button>
      <button className={button} disabled={busy} onClick={() => run(async () => { await apiDelete(PATH + "/preview"); setPreview(null); })}>Discard preview</button>
    </div>}
    {(status?.connected || status?.context) && <button className={button} disabled={busy} onClick={() => run(async () => {
      const result = await apiDelete<{ revoked: boolean }>(PATH);
      setPreview(null); await refresh(); window.dispatchEvent(new Event("twin-memory-updated"));
      setMessage(result.revoked ? "Disconnected and Gmail context removed." : "Local access and context removed. Google revocation failed; remove this app in your Google Account permissions.");
    })}>Disconnect and remove Gmail context</button>}
  </section>;
}
