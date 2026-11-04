"use client";

// Step 3 of onboarding — voice interview to create the digital twin.
// Runs concurrently with sprite generation: while the sprite sheet
// renders in the background, Gemini Live API conducts a ~60s voice
// interview to seed the twin's personality profile.
//
// Flow:
//   1. Receive agent_id from query params (sprite already generating)
//   2. Poll sprite status in background
//   3. Run 6-beat voice interview via Gemini Live API
//   4. Extract profile data from tool call
//   5. POST profile to /api/twin/profile
//   6. When both sprite + profile ready → "Enter World"

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchSession } from "@/lib/authClient";
import { apiGet, apiPost } from "@/lib/api";
import posthog from "posthog-js";
import BrandChip from "@/components/BrandChip";
import SpriteFrame from "@/components/SpriteFrame";
import {
  GeminiLiveSession,
  TWIN_INTERVIEW_PROMPT,
  type TwinProfile,
} from "@/lib/gemini-live";

const MAP_BG = "/onboarding/map-bg.png";
const CHAR_PREVIEW = "/onboarding/char-preview.png";
const GUIDE_SPRITE = "/characters/char_0.png";

type SpriteStatusResponse = {
  status: "queued" | "ready" | "failed";
  agent_id: string;
  sprite_url: string | null;
  portrait_url: string | null;
  photo_url: string | null;
  error?: string | null;
};

type VoiceConfigResponse = {
  api_key: string;
  model: string;
};

type TranscriptEntry = {
  who: "user" | "model";
  text: string;
};

const BEAT_LABELS = [
  "Ready?",
  "Who are you?",
  "Who to find?",
  "Your superpower?",
  "Your vibe?",
  "Spinning up!",
];

// useSearchParams opts out of static prerendering — wrap in Suspense
export default function OnboardingTwinPage() {
  return (
    <Suspense fallback={null}>
      <TwinPageInner />
    </Suspense>
  );
}

function TwinPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const agentId = searchParams.get("agent_id");

  // Auth + loading
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sprite generation state
  const [spriteStatus, setSpriteStatus] = useState<"generating" | "ready" | "failed">("generating");
  const [spriteUrl, setSpriteUrl] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [spriteProgress, setSpriteProgress] = useState(0);

  // Voice interview state
  const [voiceMode, setVoiceMode] = useState<"idle" | "connecting" | "active" | "done" | "error">("idle");
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [currentBeat, setCurrentBeat] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [twinProfile, setTwinProfile] = useState<TwinProfile | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);

  // Text fallback mode
  const [textMode, setTextMode] = useState(false);
  const [textInput, setTextInput] = useState("");

  // Refs
  const sessionRef = useRef<GeminiLiveSession | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const spriteStartedRef = useRef(0);
  const pixelCanvasRef = useRef<HTMLCanvasElement>(null);

  // Scroll transcript to bottom on new messages
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  // ── Canvas pixelation effect ───────────────────────────────────────
  useEffect(() => {
    const canvas = pixelCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imgSrc = photoUrl || CHAR_PREVIEW;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imgSrc;

    let raf = 0;
    const SIZE = 120; // canvas display size
    canvas.width = SIZE;
    canvas.height = SIZE;
    const startTime = Date.now();
    const DURATION = 30_000; // 30s to fully pixelate

    const draw = () => {
      const elapsed = Date.now() - startTime;
      // 0 → 1 over 30s, clamp at 1
      const progress = Math.min(1, elapsed / DURATION);
      // Ease-in-out for smooth feel
      const eased = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      // 60px (clear) → 5px (chunky blocks)
      const pixelSize = Math.max(5, Math.round(60 - eased * 55));

      // Draw tiny then scale up — real pixelation
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.drawImage(img, 0, 0, pixelSize, pixelSize);
      ctx.drawImage(canvas, 0, 0, pixelSize, pixelSize, 0, 0, SIZE, SIZE);

      // Subtle blue tint grows as pixelation increases
      const tintAlpha = 0.02 + eased * 0.12;
      ctx.fillStyle = `rgba(122, 167, 217, ${tintAlpha})`;
      ctx.fillRect(0, 0, SIZE, SIZE);

      raf = requestAnimationFrame(draw);
    };

    img.onload = () => {
      raf = requestAnimationFrame(draw);
    };
    // If cached, onload may already have fired
    if (img.complete) {
      raf = requestAnimationFrame(draw);
    }

    return () => cancelAnimationFrame(raf);
  }, [photoUrl]);

  // Beat tracking is driven by advance_beat tool calls from Gemini
  // (see onBeatAdvance callback below) — no heuristic needed.

  // ── Auth guard ────────────────────────────────────────────────────
  useEffect(() => {
    if (!agentId) {
      router.replace("/onboarding/photo");
      return;
    }
    (async () => {
      const auth = await fetchSession();
      if (!auth) {
        router.replace("/login?next=/onboarding");
        return;
      }
      setLoading(false);
    })();
  }, [router, agentId]);

  // ── Sprite polling ────────────────────────────────────────────────
  useEffect(() => {
    if (!agentId || loading) return;
    let cancelled = false;
    const pollMs = 1000;
    // Onboarding gates on the fast portrait pass (~10s). The full sheet
    // continues generating in the background and the world page picks it
    // up via its 4s refetch when the dual-write lands sprite_url.
    const maxMs = 20_000;
    spriteStartedRef.current = Date.now();

    const poll = async () => {
      while (!cancelled && Date.now() - spriteStartedRef.current < maxMs) {
        const elapsed = Date.now() - spriteStartedRef.current;
        setSpriteProgress(Math.min(94, Math.round((elapsed / maxMs) * 94)));

        try {
          const status = await apiGet<SpriteStatusResponse>(
            `/api/sprites/${encodeURIComponent(agentId)}/status`,
          );
          if (status.photo_url) setPhotoUrl(status.photo_url);
          const ready = status.portrait_url || status.sprite_url;
          if (status.status === "ready" && ready) {
            setSpriteUrl(ready);
            setSpriteStatus("ready");
            setSpriteProgress(100);
            return;
          }
          if (status.status === "failed") {
            setSpriteStatus("failed");
            setError(status.error || "Sprite generation failed.");
            return;
          }
        } catch {
          // Polling failure — continue
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      if (!cancelled) {
        setSpriteStatus("failed");
        setError("Sprite generation timed out.");
      }
    };

    poll();
    return () => { cancelled = true; };
  }, [agentId, loading]);

  // ── Save profile when extracted ───────────────────────────────────
  useEffect(() => {
    if (!twinProfile || profileSaved) return;
    (async () => {
      try {
        await apiPost("/api/twin/profile", twinProfile);
        setProfileSaved(true);
      } catch (err) {
        console.error("[twin] profile save failed:", err);
      }
    })();
  }, [twinProfile, profileSaved]);

  // ── Cleanup on unmount ────────────────────────────────────────────
  useEffect(() => {
    return () => {
      sessionRef.current?.disconnect();
    };
  }, []);

  // ── Start voice interview ─────────────────────────────────────────
  const startVoiceInterview = useCallback(async () => {
    setVoiceMode("connecting");
    setError(null);
    posthog.capture("voice_interview_started");

    try {
      const config = await apiGet<VoiceConfigResponse>("/api/voice/config");

      const session = new GeminiLiveSession({
        apiKey: config.api_key,
        model: config.model,
        systemPrompt: TWIN_INTERVIEW_PROMPT,
        callbacks: {
          onReady: () => setVoiceMode("active"),
          onModelSpeaking: setIsModelSpeaking,
          onTranscript: (who, text) => {
            setTranscript((prev) => {
              // Merge consecutive messages from same speaker
              if (prev.length > 0 && prev[prev.length - 1].who === who) {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  who,
                  text: updated[updated.length - 1].text + text,
                };
                return updated;
              }
              return [...prev, { who, text }];
            });
          },
          onToolCall: (_name, args) => {
            setTwinProfile(args);
            setVoiceMode("done");
            setCurrentBeat(6);
          },
          onBeatAdvance: (beat) => {
            console.log("[twin] beat advance:", beat);
            setCurrentBeat(Math.min(6, beat));
          },
          onError: (msg) => {
            console.error("[twin] voice error:", msg);
            setError(msg);
            setVoiceMode("error");
          },
          onClose: () => {
            // Don't reset to idle if we already set error or done
            setVoiceMode((prev) =>
              prev === "done" || prev === "error" ? prev : "idle",
            );
          },
          onAudioLevel: setAudioLevel,
        },
      });

      sessionRef.current = session;
      await session.connect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start voice interview");
      setVoiceMode("error");
    }
  }, []);

  // ── Text mode submit ──────────────────────────────────────────────
  const sendTextMessage = useCallback(() => {
    if (!textInput.trim() || !sessionRef.current) return;
    sessionRef.current.sendText(textInput.trim());
    setTranscript((prev) => [...prev, { who: "user", text: textInput.trim() }]);
    setTextInput("");
  }, [textInput]);

  // ── Can enter world? ──────────────────────────────────────────────
  const canEnterWorld = spriteStatus !== "generating";

  const enterWorld = () => {
    sessionRef.current?.disconnect();
    posthog.capture("onboarding_completed", {
      interview_completed: voiceMode === "done",
      sprite_ready: spriteStatus === "ready",
    });
    router.push("/onboarding/history");
  };

  const skipInterview = () => {
    sessionRef.current?.disconnect();
    setVoiceMode("done");
  };

  // ── Render ────────────────────────────────────────────────────────

  const bgStyle = {
    backgroundImage: `linear-gradient(rgba(12, 22, 38, 0.72), rgba(12, 22, 38, 0.82)), url(${MAP_BG})`,
    backgroundPosition: "center top",
    backgroundSize: "cover",
  } as const;

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#0c1626] px-4" style={bgStyle}>
        <BrandChip />
        <div className="font-mono text-sm uppercase tracking-wider text-[#dcecf4]">Loading…</div>
      </main>
    );
  }

  // Generate waveform bars based on audio level
  const waveBars = Array.from({ length: 24 }, (_, i) => {
    const centerDist = Math.abs(i - 12) / 12;
    const variation = (Math.sin(i * 2.4 + audioLevel * 8) + 1) / 2;
    const baseHeight = isModelSpeaking
      ? 0.5 + variation * 0.5
      : 0.15 + audioLevel * (1 - centerDist * 0.6) + variation * audioLevel * 0.3;
    return Math.max(0.1, Math.min(1, baseHeight));
  });

  return (
    <main className="min-h-dvh bg-[#0c1626] pb-28" style={bgStyle}>
      <BrandChip />
      <div className="mx-auto max-w-2xl px-3 pt-3 pb-4 sm:px-4 sm:pt-24 sm:pb-5">
        {/* Header chip — hidden on mobile to save space */}
        <div className="mb-4 hidden border-[3px] border-[#1f2a3c] bg-[rgba(236,231,217,0.96)] p-3 text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c] sm:block sm:p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-[54px] w-[54px] items-center justify-center border-[3px] border-[#1f2a3c] bg-[#dcecf4] shadow-[3px_3px_0_#1f2a3c]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={CHAR_PREVIEW}
                alt="Pixel character preview"
                className="h-[44px] w-[22px] object-contain"
                style={{ imageRendering: "pixelated" }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="bg-[#e8f1ff] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
                  Pixel Societies
                </span>
                <span className="bg-[#ddd7c8] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
                  Creating Your Twin
                </span>
              </div>
              <h1 className="mb-1 font-mono text-xl font-bold uppercase leading-tight sm:text-2xl">
                Meet your digital twin
              </h1>
              <p className="max-w-2xl text-sm leading-relaxed text-[#425166] sm:text-[15px]">
                While your sprite renders, let&apos;s get to know you. A quick voice
                chat seeds your twin&apos;s personality.
              </p>
            </div>
          </div>
        </div>

        {/* Main content: sprite + voice interview side by side */}
        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          {/* Left: Sprite preview — hidden on mobile to keep voice above fold */}
          <div className="hidden border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] p-3 shadow-[4px_4px_0_#1f2a3c] sm:block">
            <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#637387]">
              Your Sprite
            </p>

            <div
              className={`relative mx-auto flex h-[140px] w-[140px] items-center justify-center border-[3px] border-[#1f2a3c] bg-[#0d1727] ${
                voiceMode !== "done" ? "twin-glow" : ""
              }`}
            >
              {/* User photo pixelating via canvas — shown until interview done + sprite ready */}
              {!(voiceMode === "done" && spriteStatus === "ready" && spriteUrl) &&
                spriteStatus !== "failed" && (
                <div className="twin-pixelate-wrap">
                  <canvas
                    ref={pixelCanvasRef}
                    width={120}
                    height={120}
                    style={{ width: 120, height: 120, imageRendering: "pixelated" }}
                  />
                  <div className="twin-pixelate-scan" />
                </div>
              )}

              {/* Reveal sprite only after interview done */}
              {voiceMode === "done" && spriteStatus === "ready" && spriteUrl && (
                <div className="twin-sprite-reveal">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={spriteUrl}
                    alt="Your generated sprite"
                    className="max-h-[130px] max-w-[130px] object-contain"
                    style={{ imageRendering: "pixelated" }}
                  />
                </div>
              )}

              {spriteStatus === "failed" && (
                <div className="text-center font-mono text-[10px] uppercase text-[#f7ddd7]">
                  Failed
                </div>
              )}
            </div>

            {/* Progress bar */}
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                <span>
                  {voiceMode === "done" && spriteStatus === "ready"
                    ? "Sprite ready"
                    : spriteStatus === "failed"
                      ? "Error"
                      : "Rendering"}
                </span>
                <span>{voiceMode === "done" && spriteStatus === "ready" ? "100" : spriteProgress}%</span>
              </div>
              <div className="h-2 border-[2px] border-[#1f2a3c] bg-[#0d1727]">
                <div
                  className="h-full bg-[#7aa7d9] transition-[width] duration-500"
                  style={{ width: `${voiceMode === "done" && spriteStatus === "ready" ? 100 : spriteProgress}%` }}
                />
              </div>
            </div>
          </div>

          {/* Right: Voice interview */}
          <div className="border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] p-3 shadow-[4px_4px_0_#1f2a3c] sm:p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#637387]">
                Voice Interview
              </p>
              {voiceMode !== "done" && voiceMode !== "idle" && (
                <button
                  type="button"
                  onClick={() => setTextMode(!textMode)}
                  className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#7aa7d9] hover:text-[#1f2a3c]"
                >
                  {textMode ? "Switch to voice" : "Type instead"}
                </button>
              )}
            </div>

            {/* Guide sprite at top — hidden on mobile to save space */}
            {(voiceMode === "active" || voiceMode === "connecting") && (
              <div className="mb-3 hidden flex-col items-center gap-1 sm:flex">
                <div
                  className={`flex items-center justify-center border-[2px] border-[#1f2a3c] p-1 ${
                    isModelSpeaking ? "bg-[#a8d4ff] twin-mic-active" : "bg-[#dcecf4]"
                  }`}
                >
                  <SpriteFrame
                    src={GUIDE_SPRITE}
                    sheet="placeholder"
                    frame={0}
                    size={3}
                    title="Guide"
                  />
                </div>
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                  {isModelSpeaking ? "Guide speaking…" : "Listening…"}
                </span>
              </div>
            )}
            {/* Mobile: compact status line instead of guide sprite */}
            {(voiceMode === "active" || voiceMode === "connecting") && (
              <div className="mb-2 flex items-center justify-center gap-2 sm:hidden">
                <div className={`h-3 w-3 rounded-full ${isModelSpeaking ? "bg-[#a8d4ff] animate-pulse" : "bg-[#7aa7d9]"}`} />
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                  {isModelSpeaking ? "Guide speaking…" : "Listening…"}
                </span>
              </div>
            )}

            {/* Beat progress — driven by advance_beat tool calls */}
            <div className="mb-3 flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                {BEAT_LABELS.map((label, i) => {
                  // currentBeat = last completed beat (1-6), dots indexed 0-5
                  const beatNum = i + 1;
                  const done = currentBeat >= beatNum;
                  const active = currentBeat === i; // about to do this beat
                  return (
                    <div
                      key={label}
                      className={`h-2 w-2 shrink-0 rounded-full border border-[#1f2a3c] transition-all duration-300 ${
                        done
                          ? "bg-[#1f2a3c]"
                          : active
                            ? "bg-[#7aa7d9] scale-110"
                            : "bg-transparent"
                      }`}
                      title={label}
                    />
                  );
                })}
              </div>
              <span className="font-mono text-[9px] uppercase text-[#637387]">
                {BEAT_LABELS[Math.min(currentBeat, 5)]} &middot; {Math.min(currentBeat + 1, 6)}/6
              </span>
            </div>

            {/* Waveform visualizer — large, main focus during active interview */}
            {(voiceMode === "active" || voiceMode === "connecting") && !textMode && (
              <div className="mb-3 flex h-16 items-end justify-center gap-[3px] border-[2px] border-[#1f2a3c] bg-[#0d1727] px-4 py-2 sm:h-32">
                {waveBars.map((h, i) => (
                  <div
                    key={i}
                    className="twin-wave-bar"
                    style={{
                      height: "100%",
                      transform: `scaleY(${h})`,
                      background: isModelSpeaking ? "#a8d4ff" : "#7aa7d9",
                      opacity: isModelSpeaking ? 0.9 : 0.6 + audioLevel * 0.4,
                    }}
                  />
                ))}
              </div>
            )}

            {/* Idle state — guide + start button (desktop: full sprite, mobile: compact) */}
            {voiceMode === "idle" && (
              <div className="mb-3 flex flex-col items-center justify-center gap-2 border-[2px] border-[#1f2a3c] bg-[#fffaf0] p-3 sm:gap-3 sm:p-6">
                <div className="hidden sm:block">
                  <SpriteFrame
                    src={GUIDE_SPRITE}
                    sheet="placeholder"
                    frame={0}
                    size={4}
                    title="Guide"
                  />
                </div>
                <div className="text-center">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#1f2a3c]">
                    Voice Interview
                  </p>
                  <p className="font-mono text-[11px] tracking-[0.14em] text-[#637387]">
                    Ready to get to know you!
                  </p>
                </div>
              </div>
            )}

            {/* Connecting state */}
            {voiceMode === "connecting" && !textMode && (
              <div className="mb-3 flex items-center justify-center border-[2px] border-[#1f2a3c] bg-[#0d1727] p-4">
                <p className="animate-pulse font-mono text-[11px] uppercase tracking-[0.14em] text-[#7aa7d9]">
                  Connecting…
                </p>
              </div>
            )}

            {/* Text input (fallback mode) */}
            {textMode && voiceMode === "active" && (
              <div className="mb-3 flex gap-2">
                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendTextMessage()}
                  placeholder="Type your answer…"
                  className="flex-1 border-[2px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 text-sm text-[#1f2a3c] outline-none placeholder:text-[#7f8b98]"
                />
                <button
                  type="button"
                  onClick={sendTextMessage}
                  disabled={!textInput.trim()}
                  className="border-[2px] border-[#1f2a3c] bg-[#e8f1ff] px-3 py-2 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            )}

            <div ref={transcriptEndRef} />

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              {voiceMode === "idle" && (
                <>
                  <button
                    type="button"
                    onClick={startVoiceInterview}
                    className="flex-1 border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-4 py-3 font-mono text-xs font-bold uppercase shadow-[3px_3px_0_#1f2a3c] hover:bg-[#d4e4f7]"
                  >
                    Start Voice Interview
                  </button>
                  <button
                    type="button"
                    onClick={skipInterview}
                    className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-4 py-3 font-mono text-xs font-bold uppercase shadow-[3px_3px_0_#1f2a3c] hover:bg-[#ece8d8]"
                  >
                    Skip
                  </button>
                </>
              )}
              {voiceMode === "active" && (
                <div className="flex w-full items-center justify-end">
                  <button
                    type="button"
                    onClick={skipInterview}
                    className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#637387] hover:text-[#1f2a3c]"
                  >
                    End early
                  </button>
                </div>
              )}
              {voiceMode === "done" && twinProfile && (
                <div className="w-full border-[2px] border-[#1f2a3c] bg-[#dcecf4] p-3">
                  <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#1f2a3c]">
                    Twin Profile Extracted
                  </p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-[#425166]">
                    <div><span className="font-bold text-[#1f2a3c]">Name:</span> {twinProfile.name}</div>
                    <div><span className="font-bold text-[#1f2a3c]">Role:</span> {twinProfile.role}</div>
                    <div className="col-span-2"><span className="font-bold text-[#1f2a3c]">Working on:</span> {twinProfile.current_work}</div>
                    <div className="col-span-2"><span className="font-bold text-[#1f2a3c]">Looking for:</span> {twinProfile.looking_for}</div>
                    <div className="col-span-2"><span className="font-bold text-[#1f2a3c]">Superpower:</span> {twinProfile.unique_knowledge}</div>
                    <div className="col-span-2"><span className="font-bold text-[#1f2a3c]">Style:</span> {twinProfile.social_style}</div>
                  </div>
                  {profileSaved && (
                    <p className="mt-2 font-mono text-[9px] font-bold uppercase text-[#7aa7d9]">
                      Saved to your twin
                    </p>
                  )}
                </div>
              )}
              {voiceMode === "done" && !twinProfile && (
                <p className="font-mono text-[11px] uppercase text-[#637387]">
                  Interview skipped. You can set up your twin profile later.
                </p>
              )}
              {voiceMode === "error" && (
                <div className="flex w-full items-center gap-2">
                  <button
                    type="button"
                    onClick={startVoiceInterview}
                    className="flex-1 border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-4 py-3 font-mono text-xs font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={skipInterview}
                    className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-4 py-3 font-mono text-xs font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
                  >
                    Skip
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-3 border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24] shadow-[3px_3px_0_#1f2a3c]">
            {error}
          </div>
        )}
      </div>

      {/* Sticky footer */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t-[3px] border-[#1f2a3c] bg-[rgba(236,231,217,0.98)] p-3 shadow-[0_-4px_0_#1f2a3c]">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[#637387]">
              Twin step
            </p>
            <p className="truncate text-sm text-[#425166]">
              {spriteStatus === "failed"
                ? "Sprite unavailable. You can still enter your world."
                : spriteStatus === "generating" && voiceMode === "idle"
                ? "Sprite generating. Start the interview while you wait."
                : spriteStatus === "generating" && voiceMode === "active"
                  ? "Sprite generating. Interview in progress…"
                  : spriteStatus === "ready" && voiceMode === "done"
                    ? "All set. Enter your world."
                    : spriteStatus === "ready" && voiceMode === "active"
                      ? "Sprite ready! Finish your interview."
                      : spriteStatus === "ready" && voiceMode === "idle"
                        ? "Sprite ready. Start interview or enter world."
                        : "Creating your digital twin…"}
            </p>
          </div>
          <button
            type="button"
            onClick={enterWorld}
            disabled={!canEnterWorld}
            className="min-w-[132px] border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-4 py-3 font-mono text-sm font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:bg-[#d9deea]"
          >
            {spriteStatus === "ready" ? "Add builder memory" : "Generating…"}
          </button>
        </div>
      </div>
    </main>
  );
}
