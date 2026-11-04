"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPostForm, ApiError } from "@/lib/api";
import BrandChip from "@/components/BrandChip";
import TwinMemory from "@/components/TwinMemory";

type Profile = {
  domains: string[];
  stacks: string[];
  headline: string | null;
  role_lean: string | null;
  total_sessions: number;
  projects: { name: string }[];
};
type ImportStatus = {
  agent_id: string | null;
  character_started: boolean;
  imported: boolean;
  world_slug: string;
  profile: Profile | null;
  stats: Record<string, number> | null;
};

export default function HistoryPage() {
  const router = useRouter();
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [portrait, setPortrait] = useState<string | null>(null);
  const [spriteState, setSpriteState] = useState("queued");

  useEffect(() => {
    let active = true;
    apiGet<ImportStatus>("/api/ingest/claude-code").then((result) => {
      if (!active) return;
      if (!result.agent_id || !result.character_started) {
        router.replace("/onboarding/photo");
        return;
      }
      setStatus(result);
    }).catch((err) => {
      if (!active) return;
      if (err instanceof ApiError && err.status === 401) router.replace("/login?next=/onboarding/history");
      else setError("Could not load your twin. Refresh to try again.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [router]);

  useEffect(() => {
    if (!status?.agent_id) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const sprite = await apiGet<{ status: string; portrait_url: string | null; sprite_url: string | null }>(
          `/api/sprites/${status.agent_id}/status`,
        );
        if (!active) return;
        setSpriteState(sprite.status);
        setPortrait(sprite.portrait_url || sprite.sprite_url);
        if (sprite.status === "queued") timer = setTimeout(poll, 4000);
      } catch { if (active) timer = setTimeout(poll, 8000); }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [status?.agent_id]);

  const upload = async () => {
    if (!files.length || busy) return;
    if (files.length > 100 || files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) {
      setError("Choose up to 100 session files, with a combined size under 50 MB.");
      return;
    }
    if (files.some((file) => !file.name.toLowerCase().endsWith(".jsonl"))) {
      setError("Choose .jsonl files from your Claude Code projects folder.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      setStatus(await apiPostForm<ImportStatus>("/api/ingest/claude-code", form));
      setFiles([]);
      setMemoryRefresh(n => n + 1);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.replace("/login?next=/onboarding/history");
      else setError(err instanceof ApiError ? err.message : "Import failed. Your previous twin is safe; try again.");
    } finally { setBusy(false); }
  };

  return (
    <main className="min-h-dvh bg-[#0c1626] px-4 pb-12 pt-24 text-[#1f2a3c]">
      <BrandChip />
      <div className="mx-auto max-w-6xl space-y-5">
        <section className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-5 shadow-[6px_6px_0_#1f2a3c]">
          <p className="font-mono text-xs font-bold uppercase tracking-widest">Step 3 of 3 · Builder memory</p>
          <h1 className="my-3 text-3xl font-bold">Turn your work into a living picture of you</h1>
          <p>Start with your real work. See the projects, intentions and open questions that connect it, then decide what your twin should remember and share.</p>
          {portrait && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={portrait} alt="Your pixel twin" className="mt-4 h-24 w-24 object-contain" style={{ imageRendering: "pixelated" }} />
          )}
          <p className="mt-3 text-sm text-[#5b6b7f]">
            {spriteState === "ready" ? "Your character is ready." : spriteState === "failed"
              ? "Your character image needs another try. You can still enter with a placeholder."
              : "Your character is being drawn. You can build its memory while you wait."}
          </p>
          {spriteState === "failed" && <a className="text-sm underline" href="/onboarding/photo">Retry photo</a>}
        </section>

        <section className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-5">
          <h2 className="text-xl font-bold">Import Claude Code history</h2>
          <p className="mt-2 text-sm">Select one or more session files from <code>~/.claude/projects/</code>. Open a project folder and choose its <code>.jsonl</code> files. On a Mac, press Command + Shift + G in the file picker to open that location.</p>
          <p className="mt-3 text-sm text-[#5b6b7f]">Files are sent to the backend and deleted after parsing. Recognised secrets, email addresses and local paths are redacted before bounded evidence is sent to the configured AI provider for interpretation. Activity signals and selected redacted human messages are retained privately; tool results are excluded. Each upload enriches the same understanding. Automatic redaction cannot catch every private detail—review your files first.</p>
          <p className="mt-3 text-sm">Importing joins your character to the cafe, but your analysis and source evidence remain private. Connections use only the profile text you choose to publish to the cafe.</p>
          <label htmlFor="history-files" className="mt-5 block font-mono text-xs font-bold uppercase">Session files · up to 50 MB total</label>
          <input id="history-files" type="file" accept=".jsonl" multiple disabled={busy || loading || !status?.agent_id}
            onChange={(event) => { setFiles(Array.from(event.target.files ?? [])); setError(null); }}
            className="mt-2 block w-full border-2 border-[#1f2a3c] p-3 text-sm" />
          {files.length > 0 && <p className="mt-2 text-sm">{files.length} files selected · {(files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)} MB</p>}
          <button type="button" disabled={!files.length || busy || loading} onClick={upload}
            className="mt-4 w-full border-[3px] border-[#1f2a3c] bg-[#b8f0c8] px-4 py-3 font-mono text-sm font-bold uppercase disabled:opacity-50">
            {busy ? "Saving redacted evidence…" : status?.imported ? "Enrich my understanding" : "Import & understand my work"}
          </button>
          {loading && <p role="status" className="mt-3 text-sm">Loading your twin…</p>}
          {error && <p role="alert" className="mt-3 border-2 border-red-700 bg-red-50 p-3 text-sm text-red-900">{error}</p>}
        </section>

        {status?.imported && <TwinMemory refreshKey={memoryRefresh} />}

        {status?.imported && status.profile && (
          <section aria-label="Your builder profile" className="border-[3px] border-[#1f2a3c] bg-[#b8f0c8] p-5">
            <h2 className="text-xl font-bold">Your evidence is saved privately</h2>
            <p className="mt-2">{status.profile.headline || "Your builder memory is saved"}</p>
            <p className="mt-2 text-sm">{status.profile.total_sessions} sessions · {status.profile.projects.length} projects · {status.profile.role_lean || "generalist"}</p>
            <p className="mt-2 text-sm">Interests: {status.profile.domains.join(", ") || "Still discovering your interests"}</p>
            <p className="mt-2 text-sm">Tools and languages: {status.profile.stacks.join(", ") || "Not enough evidence yet"}</p>
            {status.stats && <p className="mt-2 text-sm">{status.stats.redactions} sensitive patterns redacted · {status.stats.excerpts_selected} human excerpts selected{status.stats.records_dropped ? ` · ${status.stats.records_dropped} unsupported or unusable records skipped` : ""}</p>}
            <button type="button" disabled={busy} onClick={() => router.push(`/worlds/${encodeURIComponent(status.world_slug)}?matches=mine`)}
              className="mt-5 w-full border-[3px] border-[#1f2a3c] bg-[#1f2a3c] px-4 py-3 font-mono text-sm font-bold uppercase text-white disabled:opacity-50">
              Explore current matches
            </button>
          </section>
        )}
      </div>
    </main>
  );
}
