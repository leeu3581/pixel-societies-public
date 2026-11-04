"use client";

// "Ingest a colleague" — slide-up drawer that uploads a WhatsApp .zip /
// .txt / .md or pasted bio, runs the LLM extraction over the worlds-
// layer ingest endpoints (auth-required), and inserts the synthesised
// profile as a new row in public.agents for the caller's home world.
//
// Supports profile photo upload per person — after the ingest completes,
// the photo is POSTed to /api/sprites/generate with the new agent_id
// so the person gets a real sprite instead of a placeholder.
//
// "Add another" button after each person lets you batch-add multiple
// people in a single drawer session.

import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "@/lib/authClient";
import { apiUrl, wsUrl } from "@/lib/backend";
import { apiGet, apiPostForm } from "@/lib/api";
import posthog from "posthog-js";

type Stage =
  | "idle"
  | "uploading"
  | "ready"
  | "running"
  | "done"
  | "error";

type UploadResponse = {
  job_id: string;
  file_name: string;
  detected_format: "whatsapp_zip" | "text_doc" | "text_paste" | "unsupported";
  detected_senders: string[];
  target_sender: string;
  self_sender: string;
  world_id: string;
};

type ChunkProgress = {
  chunk: number;
  total: number;
  state: "running" | "done" | "error";
  elapsed_s?: number;
};

type SpriteStatus = {
  status: "queued" | "ready" | "failed";
  sprite_url: string | null;
};

type Mode = "file" | "paste";

type Props = {
  onClose: () => void;
  onIngested: (agentId: string) => void;
};

export default function WorldIngestDrawer({ onClose, onIngested }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [pasteSubject, setPasteSubject] = useState("");
  const [profilePhoto, setProfilePhoto] = useState<File | null>(null);
  const [spriteSheet, setSpriteSheet] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  const [job, setJob] = useState<UploadResponse | null>(null);
  const [target, setTarget] = useState("");
  const [selfName, setSelfName] = useState("");

  const [totalChunks, setTotalChunks] = useState(0);
  const [chunks, setChunks] = useState<ChunkProgress[]>([]);
  const [synthesising, setSynthesising] = useState(false);
  const [doneInfo, setDoneInfo] = useState<{
    name: string;
    agent_id: string;
    tile_x: number;
    tile_y: number;
    sections: Record<string, number>;
  } | null>(null);

  // Sprite generation state (fires after ingest_done if photo provided)
  const [spriteStatus, setSpriteStatus] = useState<"idle" | "generating" | "ready" | "failed">("idle");
  const [spriteProgress, setSpriteProgress] = useState(0);
  const [addedCount, setAddedCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const spriteInputRef = useRef<HTMLInputElement | null>(null);

  // Pull token on mount.
  useEffect(() => {
    (async () => {
      setToken(getToken());
    })();
  }, []);

  useEffect(() => () => wsRef.current?.close(), []);

  const resetForAnother = useCallback(() => {
    setStage("idle");
    setError(null);
    setFile(null);
    setPasteText("");
    setPasteSubject("");
    setProfilePhoto(null);
    setSpriteSheet(null);
    setJob(null);
    setTarget("");
    setSelfName("");
    setTotalChunks(0);
    setChunks([]);
    setSynthesising(false);
    setDoneInfo(null);
    setSpriteStatus("idle");
    setSpriteProgress(0);
    if (photoInputRef.current) photoInputRef.current.value = "";
    if (spriteInputRef.current) spriteInputRef.current.value = "";
  }, []);

  const upload = useCallback(
    async (f: File) => {
      if (!token) {
        setError("not signed in");
        setStage("error");
        return;
      }
      setStage("uploading");
      setError(null);
      const fd = new FormData();
      fd.append("file", f);
      try {
        const r = await fetch(apiUrl("/api/worlds/me/ingest/upload"), {
          method: "POST",
          body: fd,
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`upload ${r.status}`);
        const data: UploadResponse = await r.json();
        setJob(data);
        setTarget(data.target_sender);
        setSelfName(data.self_sender);
        setStage("ready");
      } catch (e) {
        setError(e instanceof Error ? e.message : "upload failed");
        setStage("error");
      }
    },
    [token],
  );

  const submitPaste = useCallback(async () => {
    if (!pasteText.trim() || !pasteSubject.trim()) return;
    if (!token) {
      setError("not signed in");
      setStage("error");
      return;
    }
    setStage("uploading");
    setError(null);
    try {
      const r = await fetch(apiUrl("/api/worlds/me/ingest/paste"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          text: pasteText,
          subject_name: pasteSubject.trim(),
          source_label: "drawer-paste",
        }),
      });
      if (!r.ok) throw new Error(`paste ${r.status}`);
      const data: UploadResponse = await r.json();
      setJob(data);
      setTarget(data.target_sender);
      setSelfName(data.self_sender);
      setStage("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "paste failed");
      setStage("error");
    }
  }, [pasteText, pasteSubject, token]);

  // Trigger sprite generation for the newly created agent.
  const generateSprite = useCallback(
    async (agentId: string, photo: File) => {
      setSpriteStatus("generating");
      setSpriteProgress(0);
      const startedAt = Date.now();
      // Typical sprite gen takes ~30-60s. We estimate progress from elapsed time.
      const expectedMs = 45_000;
      try {
        const fd = new FormData();
        fd.append("photo", photo);
        fd.append("agent_id", agentId);
        await apiPostForm("/api/sprites/generate", fd);

        // Poll for completion.
        const maxMs = 120_000;
        while (Date.now() - startedAt < maxMs) {
          await new Promise((r) => setTimeout(r, 2500));
          const elapsed = Date.now() - startedAt;
          setSpriteProgress(Math.min(95, Math.round((elapsed / expectedMs) * 90)));
          const status = await apiGet<SpriteStatus>(
            `/api/sprites/${encodeURIComponent(agentId)}/status`,
          );
          if (status.status === "ready") {
            setSpriteProgress(100);
            setSpriteStatus("ready");
            return;
          }
          if (status.status === "failed") {
            setSpriteStatus("failed");
            return;
          }
        }
        setSpriteStatus("failed");
      } catch {
        setSpriteStatus("failed");
      }
    },
    [],
  );

  // Upload a pre-made sprite sheet directly (skips Gemini).
  const uploadSpriteSheet = useCallback(
    async (agentId: string, spriteFile: File) => {
      setSpriteStatus("generating");
      setSpriteProgress(50);
      try {
        const fd = new FormData();
        fd.append("sprite", spriteFile);
        await apiPostForm(`/api/sprites/${encodeURIComponent(agentId)}/upload`, fd);
        setSpriteProgress(100);
        setSpriteStatus("ready");
      } catch {
        setSpriteStatus("failed");
      }
    },
    [],
  );

  const start = useCallback(() => {
    if (!job || !token) return;
    setStage("running");
    setChunks([]);
    setSynthesising(false);
    setDoneInfo(null);
    posthog.capture("agent_ingest_started", {
      format: job.detected_format,
      has_photo: Boolean(profilePhoto),
      has_sprite_sheet: Boolean(spriteSheet),
    });

    const ws = new WebSocket(`${wsUrl("/")}?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "start_ingest",
          jobId: job.job_id,
          targetSender: target,
          selfSender: selfName,
        }),
      );
    };
    ws.onmessage = (ev) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      const t = frame.type as string;
      if (t === "ingest_chunked") {
        setTotalChunks(Number(frame.total_chunks ?? 0));
      } else if (t === "ingest_chunk_start") {
        setChunks((prev) => [
          ...prev,
          {
            chunk: Number(frame.chunk),
            total: Number(frame.total),
            state: "running",
          },
        ]);
      } else if (t === "ingest_chunk_done") {
        setChunks((prev) =>
          prev.map((c) =>
            c.chunk === Number(frame.chunk)
              ? {
                  ...c,
                  state: "done",
                  elapsed_s: Number(frame.elapsed_s ?? 0),
                }
              : c,
          ),
        );
      } else if (t === "ingest_chunk_error") {
        setChunks((prev) =>
          prev.map((c) =>
            c.chunk === Number(frame.chunk) ? { ...c, state: "error" } : c,
          ),
        );
      } else if (t === "ingest_synthesising") {
        setSynthesising(true);
      } else if (t === "ingest_done") {
        const agentId = String(frame.agent_id || "");
        setDoneInfo({
          name: String(frame.name || ""),
          agent_id: agentId,
          tile_x: Number(frame.tile_x ?? 0),
          tile_y: Number(frame.tile_y ?? 0),
          sections: (frame.section_counts as Record<string, number>) || {},
        });
        setSynthesising(false);
        setStage("done");
        setAddedCount((c) => c + 1);
        posthog.capture("agent_ingested", {
          agent_name: String(frame.name || ""),
          section_count: Object.keys((frame.section_counts as Record<string, number>) || {}).length,
        });
        if (agentId) onIngested(agentId);
        ws.close();

        // Auto-trigger sprite: manual sheet takes priority over photo gen.
        if (agentId && spriteSheet) {
          void uploadSpriteSheet(agentId, spriteSheet);
        } else if (agentId && profilePhoto) {
          void generateSprite(agentId, profilePhoto);
        }
      } else if (t === "ingest_error") {
        setError(String(frame.message || "ingest error"));
        setStage("error");
        ws.close();
      }
    };
    ws.onerror = () => {
      setError("websocket error");
      setStage("error");
    };
    ws.onclose = () => {
      wsRef.current = null;
    };
  }, [job, target, selfName, token, onIngested, profilePhoto, spriteSheet, generateSprite, uploadSpriteSheet]);

  const completedChunks = chunks.filter((c) => c.state === "done").length;
  const progressPct =
    totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;

  return (
    <div className="fixed bottom-0 left-1/2 z-40 w-[min(560px,calc(100vw-1rem))] -translate-x-1/2">
      <div className="border-[3px] border-b-0 border-[#1f2a3c] bg-[rgba(246,244,234,0.99)] text-[#1f2a3c] shadow-[5px_5px_0_#1f2a3c]">
        {/* Header */}
        <div className="flex items-center gap-3 border-b-[3px] border-[#1f2a3c] bg-[#d6f4d6] px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c]">
              Ingest{addedCount > 0 ? ` · ${addedCount} added` : ""}
            </p>
            <p className="truncate text-lg font-bold leading-tight">
              Add colleagues to your world
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[58vh] overflow-y-auto bg-[#f6f4ea] px-4 py-3">
          {/* Source picker — visible until a job is registered */}
          {(stage === "idle" ||
            stage === "uploading" ||
            stage === "error") && (
            <>
              <div className="mb-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMode("file")}
                  className={
                    mode === "file"
                      ? "border-[3px] border-[#1f2a3c] bg-[#1f2a3c] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[#f6f4ea]"
                      : "border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
                  }
                >
                  File
                </button>
                <button
                  type="button"
                  onClick={() => setMode("paste")}
                  className={
                    mode === "paste"
                      ? "border-[3px] border-[#1f2a3c] bg-[#1f2a3c] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[#f6f4ea]"
                      : "border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
                  }
                >
                  Paste
                </button>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-[#7f8b98]">
                  .zip · .txt · .md
                </span>
              </div>

              {mode === "file" ? (
                <div className="flex flex-col gap-2">
                  <label className="flex min-h-[100px] cursor-pointer flex-col items-center justify-center gap-2 border-[3px] border-dashed border-[#1f2a3c] bg-[#fffaf0] px-4 py-3 text-center">
                    <span className="text-sm font-bold leading-tight">
                      Drop a WhatsApp .zip or document
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#7f8b98]">
                      {file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : "Click to choose"}
                    </span>
                    <input
                      type="file"
                      accept=".zip,.txt,.md,.markdown"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        if (f) {
                          setFile(f);
                          void upload(f);
                        }
                      }}
                      disabled={stage === "uploading"}
                    />
                  </label>
                  {/* Profile photo (optional) — generates a real sprite */}
                  <label className="flex cursor-pointer items-center gap-2 border-[3px] border-dashed border-[#1f2a3c] bg-[#fffaf0] px-3 py-2">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                      Photo
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[#7f8b98]">
                      {profilePhoto ? profilePhoto.name : "Optional · generates their sprite"}
                    </span>
                    {profilePhoto && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setProfilePhoto(null);
                          if (photoInputRef.current) photoInputRef.current.value = "";
                        }}
                        className="font-mono text-[10px] font-bold uppercase text-[#6d2d24]"
                      >
                        ×
                      </button>
                    )}
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        if (f) setProfilePhoto(f);
                      }}
                      disabled={stage === "uploading"}
                    />
                  </label>
                  {/* Sprite sheet (optional) — skip Gemini entirely */}
                  <label className="flex cursor-pointer items-center gap-2 border-[3px] border-dashed border-[#1f2a3c] bg-[#fffaf0] px-3 py-2">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                      Sprite
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[#7f8b98]">
                      {spriteSheet ? spriteSheet.name : "Optional · PNG 8×4 sheet"}
                    </span>
                    {spriteSheet && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setSpriteSheet(null);
                          if (spriteInputRef.current) spriteInputRef.current.value = "";
                        }}
                        className="font-mono text-[10px] font-bold uppercase text-[#6d2d24]"
                      >
                        ×
                      </button>
                    )}
                    <input
                      ref={spriteInputRef}
                      type="file"
                      accept="image/png"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        if (f) setSpriteSheet(f);
                      }}
                      disabled={stage === "uploading"}
                    />
                  </label>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <input
                    type="text"
                    value={pasteSubject}
                    onChange={(e) => setPasteSubject(e.target.value)}
                    placeholder="Subject name (e.g. Sarah Chen)"
                    className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 text-sm shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
                    disabled={stage === "uploading"}
                  />
                  {/* Profile photo (optional) — generates a real sprite */}
                  <label className="flex cursor-pointer items-center gap-2 border-[3px] border-dashed border-[#1f2a3c] bg-[#fffaf0] px-3 py-2">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                      Photo
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[#7f8b98]">
                      {profilePhoto ? profilePhoto.name : "Optional · generates their sprite"}
                    </span>
                    {profilePhoto && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setProfilePhoto(null);
                          if (photoInputRef.current) photoInputRef.current.value = "";
                        }}
                        className="font-mono text-[10px] font-bold uppercase text-[#6d2d24]"
                      >
                        ×
                      </button>
                    )}
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        if (f) setProfilePhoto(f);
                      }}
                      disabled={stage === "uploading"}
                    />
                  </label>
                  {/* Sprite sheet (optional) — skip Gemini entirely */}
                  <label className="flex cursor-pointer items-center gap-2 border-[3px] border-dashed border-[#1f2a3c] bg-[#fffaf0] px-3 py-2">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                      Sprite
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[#7f8b98]">
                      {spriteSheet ? spriteSheet.name : "Optional · PNG 8×4 sheet"}
                    </span>
                    {spriteSheet && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setSpriteSheet(null);
                          if (spriteInputRef.current) spriteInputRef.current.value = "";
                        }}
                        className="font-mono text-[10px] font-bold uppercase text-[#6d2d24]"
                      >
                        ×
                      </button>
                    )}
                    <input
                      type="file"
                      accept="image/png"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        if (f) setSpriteSheet(f);
                      }}
                      disabled={stage === "uploading"}
                    />
                  </label>
                  <textarea
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder="Paste a bio, doc, transcript, LinkedIn profile…"
                    rows={6}
                    className="resize-y border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 font-mono text-[12px] leading-snug shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
                    disabled={stage === "uploading"}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#7f8b98]">
                      {pasteText.length.toLocaleString()} chars
                    </span>
                    <button
                      type="button"
                      onClick={submitPaste}
                      disabled={
                        !pasteText.trim() ||
                        !pasteSubject.trim() ||
                        stage === "uploading"
                      }
                      className="border-[3px] border-[#1f2a3c] bg-[#d6f4d6] px-3 py-1 font-mono text-[11px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {stage === "uploading" ? "…" : "Submit"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Job-ready: pick the target sender + start */}
          {job && stage === "ready" && (
            <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-3 shadow-[3px_3px_0_#1f2a3c]">
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#637387]">
                Source · {job.detected_format}
              </p>
              <p className="mt-0.5 truncate text-sm font-bold">{job.file_name}</p>
              {job.detected_senders.length > 1 && (
                <label className="mt-2 flex flex-col gap-1">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                    Profile target
                  </span>
                  <select
                    className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 text-sm shadow-[3px_3px_0_#1f2a3c] outline-none"
                    value={target}
                    onChange={(e) => {
                      const v = e.target.value;
                      setTarget(v);
                      const other = job.detected_senders.find((s) => s !== v);
                      if (other) setSelfName(other);
                    }}
                  >
                    {job.detected_senders.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {profilePhoto && (
                <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#637387]">
                  Photo attached · {profilePhoto.name}
                </p>
              )}
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#7f8b98]">
                  Parallel chunked extraction · ~30–90s
                </span>
                <button
                  type="button"
                  onClick={start}
                  disabled={!target || target === selfName}
                  className="border-[3px] border-[#1f2a3c] bg-[#d6f4d6] px-3 py-1 font-mono text-[11px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Build the profile
                </button>
              </div>
            </div>
          )}

          {/* Streaming progress */}
          {(stage === "running" || stage === "done") && (
            <div className="flex flex-col gap-2">
              <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-3 shadow-[3px_3px_0_#1f2a3c]">
                <div className="flex items-baseline justify-between">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#637387]">
                    Chunks
                  </p>
                  <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                    {completedChunks} / {totalChunks || "?"} ({progressPct}%)
                  </p>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden border-[2px] border-[#1f2a3c] bg-[#f6f4ea]">
                  <div
                    className="h-full bg-[#1f2a3c] transition-[width] duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                {synthesising && (
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#1f2a3c]">
                    Synthesising the profile from {chunks.length} chunks…
                  </p>
                )}
              </div>

              {doneInfo && (
                <div className="border-[3px] border-[#1f2a3c] bg-[#d6f4d6] p-3 shadow-[3px_3px_0_#1f2a3c]">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c]">
                    Saved · agent in your world
                  </p>
                  <p className="mt-1 text-base font-bold">{doneInfo.name}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#1f2a3c]">
                    tile ({doneInfo.tile_x}, {doneInfo.tile_y})
                  </p>
                  {doneInfo.sections && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {Object.entries(doneInfo.sections).map(([k, v]) => (
                        <span
                          key={k}
                          className="border-[2px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em]"
                        >
                          {v} {k}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Sprite generation progress bar */}
                  {spriteStatus !== "idle" && (
                    <div className="mt-2">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                          {spriteStatus === "generating"
                            ? "Generating sprite…"
                            : spriteStatus === "ready"
                              ? "Sprite ready"
                              : "Sprite failed"}
                        </span>
                        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                          {spriteProgress}%
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden border-[2px] border-[#1f2a3c] bg-[#f6f4ea]">
                        <div
                          className={`h-full transition-[width] duration-500 ${
                            spriteStatus === "failed"
                              ? "bg-[#d4524a]"
                              : spriteStatus === "ready"
                                ? "bg-[#4aad5b]"
                                : "bg-[#7aa7d9]"
                          }`}
                          style={{ width: `${spriteProgress}%` }}
                        />
                      </div>
                      {spriteStatus === "failed" && (
                        <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[#6d2d24]">
                          They&apos;ll use a placeholder — upload a sprite sheet below
                        </p>
                      )}
                    </div>
                  )}
                  {/* Manual sprite sheet upload — always available */}
                  {spriteStatus !== "generating" && (
                    <label className="mt-2 flex cursor-pointer items-center gap-2 border-[3px] border-dashed border-[#1f2a3c] bg-[#fffaf0] px-3 py-2">
                      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                        {spriteStatus === "ready" ? "Replace sprite" : "Upload sprite sheet"}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[9px] uppercase tracking-[0.14em] text-[#7f8b98]">
                        PNG · 8×4 grid · 1024×1024
                      </span>
                      <input
                        type="file"
                        accept="image/png"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f && doneInfo?.agent_id) {
                            void uploadSpriteSheet(doneInfo.agent_id, f);
                          }
                        }}
                      />
                    </label>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={resetForAnother}
                      className="border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-3 py-1 font-mono text-[11px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
                    >
                      + Add another
                    </button>
                    <button
                      type="button"
                      onClick={onClose}
                      className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-1 font-mono text-[11px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Notice */}
        {error && (
          <div className="border-t-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-[#6d2d24]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
