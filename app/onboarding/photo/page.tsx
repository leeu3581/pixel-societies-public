"use client";

// Step 2 of onboarding — capture a photo for sprite generation.
// Compresses client-side to ≤1.4MB JPEG (matches the Pixel Societies
// pipeline), POSTs multipart to /api/sprites/generate, then waits for
// the generated sprite sheet before routing to /world.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchSession } from "@/lib/authClient";
import { apiGet, apiPostForm, ApiError } from "@/lib/api";
import BrandChip from "@/components/BrandChip";
import posthog from "posthog-js";

const MAP_BG = "/onboarding/map-bg.png";
const CHAR_PREVIEW = "/onboarding/char-preview.png";
const LAPTOP = "/onboarding/laptop.png";
const MAX_UPLOAD_BYTES = 1_400_000;

type SpriteGenerateResponse = {
  status: "queued";
  agent_id: string;
  placeholder_sprite_url: string;
  photo_url: string | null;
  photo_bytes: number;
};

type SpriteStatusResponse = {
  status: "queued" | "ready" | "failed";
  agent_id: string;
  sprite_url: string | null;
  portrait_url: string | null;
  sprite_sheet_url: string | null;
  photo_url: string | null;
  error?: string | null;
};

async function compressToJpegBlob(file: File): Promise<Blob> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read image"));
      i.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");

    const attempts = [
      { maxEdge: 896, quality: 0.84 },
      { maxEdge: 768, quality: 0.8 },
      { maxEdge: 640, quality: 0.76 },
      { maxEdge: 512, quality: 0.72 },
    ];
    for (const a of attempts) {
      const scale = Math.min(1, a.maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const blob: Blob | null = await new Promise((res) =>
        canvas.toBlob(res, "image/jpeg", a.quality),
      );
      if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
    }
    throw new Error("Photo is still too large. Try a tighter crop.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function shouldUseNativeCameraPicker(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export default function OnboardingPhotoPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [generationStage, setGenerationStage] = useState<string | null>(null);
  const [generatedSpriteUrl, setGeneratedSpriteUrl] = useState<string | null>(null);
  const [storedPhotoUrl, setStoredPhotoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isCameraStarting, setIsCameraStarting] = useState(false);

  const stopCameraStream = () => {
    if (!streamRef.current) return;
    streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Cleanup camera stream on unmount
  useEffect(() => {
    return () => stopCameraStream();
  }, []);

  // Wire video element to stream when camera opens
  useEffect(() => {
    if (!isCameraOpen || !videoRef.current || !streamRef.current) return;
    videoRef.current.srcObject = streamRef.current;
    void videoRef.current.play().catch(() => undefined);
  }, [isCameraOpen]);

  const openCamera = async () => {
    setError(null);

    // iOS: use native camera picker
    if (shouldUseNativeCameraPicker()) {
      cameraRef.current?.click();
      return;
    }

    // Non-secure context or no getUserMedia: fall back to file input
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      cameraRef.current?.click();
      return;
    }

    setIsCameraStarting(true);
    try {
      stopCameraStream();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      setIsCameraOpen(true);
    } catch (err: unknown) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError") {
        setError("Camera access blocked. Allow camera permission or upload a photo instead.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No camera found. Upload a photo instead.");
      } else {
        cameraRef.current?.click();
      }
    } finally {
      setIsCameraStarting(false);
    }
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setError("Camera still starting. Try again in a moment.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Capture unavailable.");
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError("Capture failed.");
          return;
        }
        setPhotoBlob(blob);
        setPreviewUrl(URL.createObjectURL(blob));
        setError(null);
        closeCamera();
      },
      "image/jpeg",
      0.92,
    );
  };

  const closeCamera = () => {
    stopCameraStream();
    setIsCameraOpen(false);
    setIsCameraStarting(false);
  };

  useEffect(() => {
    (async () => {
      const auth = await fetchSession();
      if (!auth) {
        router.replace("/login?next=/onboarding/photo");
        return;
      }
      let me: { profile: { display_name: string | null } | null };
      try {
        me = await apiGet<{ profile: { display_name: string | null } | null }>(
          "/api/me",
        );
      } catch {
        setLoading(false);
        return;
      }
      if (!me.profile?.display_name) {
        router.replace("/onboarding/name");
        return;
      }
      setDisplayName(me.profile.display_name);
      // Restore the saved reveal when returning or refreshing, without paying
      // for another generation. Choosing a new file clears this preview.
      try {
        const imported = await apiGet<{ agent_id: string | null }>("/api/ingest/claude-code");
        if (imported.agent_id) {
          setAgentId(imported.agent_id);
          const saved = await apiGet<SpriteStatusResponse>(`/api/sprites/${encodeURIComponent(imported.agent_id)}/status`);
          if (saved.portrait_url || saved.sprite_url) {
            setGeneratedSpriteUrl(saved.portrait_url || saved.sprite_url);
            setStoredPhotoUrl(saved.photo_url);
            setPreviewUrl(saved.photo_url || saved.portrait_url || saved.sprite_url);
          }
        }
      } catch { /* A new account can proceed without an existing character. */ }
      setLoading(false);
    })();
  }, [router]);

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPhotoBlob(null);
    setPreviewUrl(null);
    setGeneratedSpriteUrl(null);
    setStoredPhotoUrl(null);
    try {
      const blob = await compressToJpegBlob(file);
      setPhotoBlob(blob);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't read photo");
    }
  };

  const waitForSprite = async (queuedAgentId: string) => {
    const startedAt = Date.now();
    const maxMs = 210_000;
    const pollMs = 2_500;
    setProgress(18);
    setGenerationStage("Drawing your pixel portrait with Muse");

    while (Date.now() - startedAt < maxMs) {
      const elapsed = Date.now() - startedAt;
      const nextProgress = Math.min(94, 18 + Math.round((elapsed / maxMs) * 76));
      setProgress(nextProgress);

      const status = await apiGet<SpriteStatusResponse>(
        `/api/sprites/${encodeURIComponent(queuedAgentId)}/status`,
      );
      const portrait = status.portrait_url || status.sprite_url;
      if (portrait) {
        setGenerationStage("Your portrait is ready");
        setProgress(100);
        setGeneratedSpriteUrl(portrait);
        if (status.photo_url) setStoredPhotoUrl(status.photo_url);
        return status;
      }
      if (status.status === "failed") {
        throw new Error(
          status.error ||
            "Sprite generation failed. Try again with a clearer, front-facing photo.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error("Sprite generation is taking longer than expected. Try again.");
  };

  const submit = async () => {
    if (generatedSpriteUrl) {
      router.push("/onboarding/history");
      return;
    }
    if (!photoBlob) {
      setError("Choose a photo first.");
      return;
    }
    setBusy(true);
    setProgress(8);
    setGenerationStage("Uploading photo");
    setError(null);
    posthog.capture("onboarding_photo_submitted", { photo_bytes: photoBlob.size });
    try {
      const form = new FormData();
      form.append("photo", photoBlob, "upload.jpg");
      const path = agentId
        ? `/api/sprites/generate?agent_id=${encodeURIComponent(agentId)}`
        : "/api/sprites/generate";
      const res = await apiPostForm<SpriteGenerateResponse>(path, form);
      setAgentId(res.agent_id);
      if (res.photo_url) setStoredPhotoUrl(res.photo_url);
      await waitForSprite(res.agent_id);
      setBusy(false);
    } catch (err: unknown) {
      console.error("[onboarding/photo] submit error", err);
      posthog.captureException(err instanceof Error ? err : new Error(String(err)));
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Upload failed";
      setError(msg);
      setBusy(false);
      setGenerationStage(null);
      setProgress(0);
    }
  };

  const bgStyle = {
    backgroundImage: `linear-gradient(rgba(12, 22, 38, 0.72), rgba(12, 22, 38, 0.82)), url(${MAP_BG})`,
    backgroundPosition: "center top",
    backgroundSize: "cover",
  } as const;

  if (loading) {
    return (
      <main
        className="flex min-h-dvh items-center justify-center bg-[#0c1626] px-4"
        style={bgStyle}
      >
        <BrandChip />
        <div className="font-mono text-sm uppercase tracking-wider text-[#dcecf4]">
          Loading…
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#0c1626] pb-28" style={bgStyle}>
      <BrandChip />
      <div className="mx-auto max-w-2xl px-3 pt-20 pb-4 sm:px-4 sm:pt-24 sm:pb-5">
        {/* Header chip */}
        <div className="mb-4 border-[3px] border-[#1f2a3c] bg-[rgba(236,231,217,0.96)] p-3 text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c] sm:p-4">
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
                  Step 2 of 3
                </span>
              </div>
              <h1 className="mb-1 font-mono text-xl font-bold uppercase leading-tight sm:text-2xl">
                {displayName ? `Nice to meet you, ${displayName}!` : "Now, a photo for your sprite"}
              </h1>
              <p className="max-w-2xl text-sm leading-relaxed text-[#425166] sm:text-[15px]">
                Upload a photo and we&apos;ll turn it into your pixel-art twin.
              </p>
            </div>
            <div className="hidden h-[54px] w-[54px] items-center justify-center border-[3px] border-[#1f2a3c] bg-[#f6f4ea] shadow-[3px_3px_0_#1f2a3c] sm:flex">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={LAPTOP}
                alt="Laptop prop"
                className="h-[26px] w-[26px] object-contain"
                style={{ imageRendering: "pixelated" }}
              />
            </div>
          </div>
        </div>

        {/* Body card */}
        <div className="border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] p-4 text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c] sm:p-5">
          <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-4 shadow-[3px_3px_0_#1f2a3c] sm:p-5">
            <p className="mb-2 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#637387]">
              Twin photo
            </p>

            {previewUrl ? (
              <div className="mb-4 grid gap-4 sm:grid-cols-[auto_1fr]">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] p-2 shadow-[3px_3px_0_#1f2a3c]">
                    <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                      Photo
                    </p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={storedPhotoUrl || previewUrl}
                    alt="Photo preview"
                    className="h-32 w-32 object-cover"
                  />
                  </div>
                  {generatedSpriteUrl && (
                    <div className="border-[3px] border-[#1f2a3c] bg-[#dcecf4] p-2 shadow-[3px_3px_0_#1f2a3c]">
                      <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#637387]">
                        Pixel portrait
                      </p>
                      <div className="flex h-32 w-32 items-center justify-center bg-[#f6f4ea]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={generatedSpriteUrl}
                          alt="Generated sprite"
                          className="h-full w-full object-contain"
                          style={{ imageRendering: "pixelated" }}
                        />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex-1 text-sm leading-relaxed text-[#4f5c6d]">
                  {generatedSpriteUrl
                    ? "Your portrait is ready. Continue to add your sessions while the walking animation finishes in the background."
                    : "Looks good? Generate your sprite. Or pick a different photo below."}
                </div>
              </div>
            ) : (
              <div className="mb-4 border-2 border-dashed border-[#9fb0bf] bg-[#f6f4ea] p-6 text-center">
                <p className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#637387]">
                  No photo yet
                </p>
                <p className="mt-1 text-sm text-[#4f5c6d]">
                  Choose a clear photo with your face roughly centered.
                </p>
              </div>
            )}

            {/* Hidden inputs + visible buttons */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onFileChosen(e.target.files?.[0])}
            />
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="user"
              className="hidden"
              onChange={(e) => onFileChosen(e.target.files?.[0])}
            />
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-4 py-3 font-mono text-xs font-bold uppercase shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Choose photo
              </button>
              <button
                type="button"
                onClick={openCamera}
                disabled={isCameraStarting || busy}
                className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-4 py-3 font-mono text-xs font-bold uppercase shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCameraStarting ? "Opening…" : "Use camera"}
              </button>
            </div>

            {/* Live camera viewfinder */}
            {isCameraOpen && (
              <div className="mt-4 border-[3px] border-[#1f2a3c] bg-[#0d1727] p-3 shadow-[3px_3px_0_#1f2a3c]">
                <div className="overflow-hidden border-[3px] border-[#1f2a3c] bg-black">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="aspect-square w-full object-cover"
                    style={{ transform: "scaleX(-1)" }}
                  />
                </div>
                <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-[#c9d6e3]">
                  Center your face, then capture.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={closeCamera}
                    className="border-[3px] border-[#f6f4ea] bg-transparent px-4 py-3 font-mono text-xs font-bold uppercase text-[#f6f4ea]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={capturePhoto}
                    className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-4 py-3 font-mono text-xs font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#060b13]"
                  >
                    Capture
                  </button>
                </div>
              </div>
            )}

            {busy && (
              <div className="mt-4 border-[3px] border-[#1f2a3c] bg-[#e8f1ff] p-3 shadow-[3px_3px_0_#1f2a3c]">
                <div className="mb-2 flex items-center justify-between gap-3 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#1f2a3c]">
                  <span>{generationStage || "Generating sprite"}</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-4 border-[3px] border-[#1f2a3c] bg-[#f6f4ea]">
                  <div
                    className="h-full bg-[#7aa7d9] transition-[width] duration-500"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}
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
              Sprite step
            </p>
            <p className="truncate text-sm text-[#425166]">
              {busy
                ? generationStage || "Generating sprite."
                : generatedSpriteUrl
                  ? "Portrait ready. Next, bring in your work."
                : photoBlob
                  ? "Photo ready. Generate your sprite."
                  : "Pick a photo to continue."}
            </p>
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={(!photoBlob && !generatedSpriteUrl) || busy}
            className="min-w-[132px] border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-4 py-3 font-mono text-sm font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:bg-[#d9deea]"
          >
            {busy ? "Drawing portrait…" : generatedSpriteUrl ? "Add my sessions" : "Generate"}
          </button>
        </div>
      </div>
    </main>
  );
}
