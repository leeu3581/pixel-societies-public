"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { fetchSession } from "@/lib/authClient";
import { apiGet } from "@/lib/api";
import SpriteFrame from "@/components/SpriteFrame";

import "./shadow-cat.css";

type ShadowMode = "idle" | "listening" | "thinking" | "replying";
type RoamRoute = "horizontal" | "diagonal";

const PARKED_WIDTH = 280;
const PARKED_HEIGHT = 220;
const RUN_DURATION_MS = 7600;

const IDLE_BUBBLE_LINES = [
  "Click me to chat.",
  "Need a break? I will roam for you.",
  "Tap to summon. Tap again to nap.",
  "Your shadow. Always near.",
];

// Pet doesn't belong in the new pixel onboarding UX — let those
// screens own the entire viewport without a floating mascot competing
// for attention.
const HIDE_PREFIXES = ["/login", "/onboarding", "/friends"];

export default function ShadowCat() {
  const pathname = usePathname();
  const hide = HIDE_PREFIXES.some(
    (p) => pathname === p || pathname?.startsWith(p + "/"),
  );
  const isWorldPage =
    pathname === "/world" || (pathname?.startsWith("/world/") ?? false);
  const [petCount, setPetCount] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [bubbleIndex, setBubbleIndex] = useState(0);
  const [mode, setMode] = useState<ShadowMode>("idle");
  const [spriteUrl, setSpriteUrl] = useState<string | null>(null);
  const [portraitUrl, setPortraitUrl] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  // The agent this companion represents — clicking opens chat with them.
  const agentRef = useRef<{
    id: string;
    display_name: string;
    canonical_id: string | null;
  } | null>(null);

  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [transitionStyle, setTransitionStyle] = useState(
    "transform 320ms ease",
  );
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [viewportHeight, setViewportHeight] = useState(900);
  const [roaming, setRoaming] = useState(false);
  const [route, setRoute] = useState<RoamRoute>("horizontal");

  const frameRef = useRef<number | null>(null);
  const roamTimeoutRef = useRef<number | null>(null);
  const resetTimeoutRef = useRef<number | null>(null);
  const replyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  // Fetch user display name + first agent sprite on mount.
  useEffect(() => {
    (async () => {
      const auth = await fetchSession();
      if (!auth) return;
      try {
        const me = await apiGet<{
          profile: { display_name: string | null } | null;
          home_world: { id: string } | null;
        }>("/api/me");
        if (me.profile?.display_name) setUserName(me.profile.display_name);
        if (!me.home_world?.id) return;
        const { agents } = await apiGet<{
          agents: Array<{
            id: string;
            display_name: string | null;
            canonical_id: string | null;
            portrait_url: string | null;
            sprite_url: string | null;
          }>;
        }>(`/api/worlds/${me.home_world.id}/agents`);
        const agent = agents?.[0];
        if (agent) {
          agentRef.current = {
            id: agent.id,
            display_name: agent.display_name ?? "",
            canonical_id: agent.canonical_id,
          };
          if (agent.portrait_url) setPortraitUrl(agent.portrait_url);
          if (agent.sprite_url) setSpriteUrl(agent.sprite_url);
        }
      } catch {
        /* non-critical */
      }
    })();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (roamTimeoutRef.current !== null) {
      window.clearTimeout(roamTimeoutRef.current);
      roamTimeoutRef.current = null;
    }
    if (resetTimeoutRef.current !== null) {
      window.clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }

    if (expanded || mode !== "idle" || viewportWidth < 900) {
      frameRef.current = window.requestAnimationFrame(() => {
        setRoaming(false);
        setTransitionStyle("transform 320ms ease");
        setOffsetX(0);
        setOffsetY(0);
        frameRef.current = null;
      });
      return;
    }

    const idleDelay = 4200 + Math.round(Math.random() * 4200);

    roamTimeoutRef.current = window.setTimeout(() => {
      const travelDistance = Math.max(viewportWidth + PARKED_WIDTH + 120, 0);
      const nextRoute = Math.random() > 0.5 ? "diagonal" : "horizontal";
      const diagonalRise = Math.max(
        0,
        Math.min(travelDistance, viewportHeight - PARKED_HEIGHT - 80),
      );

      setRoaming(true);
      setRoute(nextRoute);
      setTransitionStyle("none");
      setOffsetX(PARKED_WIDTH);
      setOffsetY(0);

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setTransitionStyle(`transform ${RUN_DURATION_MS}ms linear`);
          setOffsetX(-travelDistance);
          setOffsetY(nextRoute === "diagonal" ? -diagonalRise : 0);
        });
      });

      resetTimeoutRef.current = window.setTimeout(() => {
        setTransitionStyle("none");
        setOffsetX(0);
        setOffsetY(0);
        setRoaming(false);
      }, RUN_DURATION_MS + 140);
    }, idleDelay);

    return () => {
      if (roamTimeoutRef.current !== null) {
        window.clearTimeout(roamTimeoutRef.current);
      }
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
      }
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, [expanded, mode, viewportHeight, viewportWidth]);

  useEffect(() => {
    return () => {
      if (replyTimeoutRef.current !== null) {
        window.clearTimeout(replyTimeoutRef.current);
      }
    };
  }, []);

  // On the world page, every click on the companion opens chat
  // with the specific agent this companion represents.
  const openWorldChat = () => {
    if (typeof window === "undefined") return;
    const agent = agentRef.current;
    if (!agent) return;
    window.dispatchEvent(
      new CustomEvent("shadow:open-chat", { detail: agent }),
    );
  };

  const handleInteract = () => {
    setPetCount((current) => current + 1);

    if (isWorldPage) {
      openWorldChat();
      return;
    }

    setExpanded(true);
    setMode("thinking");
    setBubbleIndex((current) => (current + 1) % IDLE_BUBBLE_LINES.length);

    if (replyTimeoutRef.current !== null) {
      window.clearTimeout(replyTimeoutRef.current);
    }
    replyTimeoutRef.current = window.setTimeout(() => {
      setMode("replying");
      replyTimeoutRef.current = window.setTimeout(() => {
        setMode("idle");
        replyTimeoutRef.current = null;
      }, 900);
    }, 600);
  };

  const moving = offsetX !== 0 || offsetY !== 0;
  const running = roaming || moving;
  const imageClassName = running
    ? "pet-run"
    : mode === "listening"
      ? "pet-listen"
      : mode === "thinking"
        ? "pet-think"
        : mode === "replying"
          ? "pet-reply"
          : "pet-idle";

  const displayLabel = userName || "You";
  const statusLabel = roaming
    ? route === "diagonal"
      ? "45 deg run"
      : "Roaming"
    : mode === "thinking"
      ? "Thinking"
      : mode === "replying"
        ? "Replying"
        : displayLabel;

  // /ask renders its own attached question bubble — bail out here
  // so the user only sees one bubble, not two.
  if (pathname?.startsWith("/ask")) return null;
  if (hide) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-3 left-3 z-50 flex max-w-[22rem] flex-col items-start gap-2 sm:bottom-6 sm:left-6"
      style={{
        transform: `translate(${offsetX}px, ${offsetY}px)`,
        transition: transitionStyle,
      }}
    >
      <div className="rounded-full border border-black/10 bg-white px-3 py-2 text-[11px] text-[#44403c] shadow-[0_10px_26px_rgba(15,23,42,0.12)]">
        <span className="pixel-label">{statusLabel}</span>
        <span className="mx-2 text-black/20">•</span>
        <span>{petCount} taps</span>
      </div>

      <div className="flex items-end gap-3">
        <div
          className={`shadow-note relative pointer-events-auto transition-all duration-200 ${
            expanded ? "w-[18rem] p-3" : "w-[14rem]"
          }`}
        >
          <button
            className="absolute inset-0 z-0 rounded-[1.45rem]"
            onClick={isWorldPage ? openWorldChat : () => setExpanded((current) => !current)}
            type="button"
          >
            <span className="sr-only">
              {isWorldPage ? "Open chat" : expanded ? "Collapse chat bubble" : "Expand chat bubble"}
            </span>
          </button>

          <div className="relative z-10">
            <div className="flex items-center justify-between gap-3">
              <span className="pixel-label">{displayLabel}</span>
              <button
                className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] text-[#6b7280] transition hover:bg-[#fafafa]"
                onClick={isWorldPage ? openWorldChat : () => setExpanded((current) => !current)}
                type="button"
              >
                {isWorldPage ? "Chat" : expanded ? "Close" : "Open"}
              </button>
            </div>
            <p className="mt-2 text-sm leading-6 text-[#2f2c28]">
              {IDLE_BUBBLE_LINES[bubbleIndex]}
            </p>
          </div>

          <div className="absolute bottom-[-0.38rem] left-8 h-4 w-4 rotate-45 border-b border-r border-black/10 bg-white" />
        </div>
      </div>

      <div className="relative pr-2">
        <div className={`pet-halo ${mode}`} />
        <div className="absolute bottom-3 right-4 h-5 w-20 rounded-full bg-[radial-gradient(circle,rgba(15,23,42,0.18),rgba(15,23,42,0)_72%)] blur-md" />
        <button
          aria-label={`Interact with ${displayLabel}`}
          className="pointer-events-auto relative z-10 rounded-[2rem] border border-transparent bg-transparent p-1 transition duration-200 hover:-translate-y-1 focus:outline-none focus-visible:border-[#ffb55c]"
          onClick={handleInteract}
          type="button"
        >
          <span
            aria-hidden="true"
            className={`user-sprite-motion relative z-10 drop-shadow-[0_18px_26px_rgba(15,23,42,0.2)] ${imageClassName}`}
          >
            {portraitUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={portraitUrl}
                alt={displayLabel}
                className="user-portrait-img"
              />
            ) : (
              <SpriteFrame
                src={spriteUrl || "/team-office/characters/char_0.png"}
                size={8}
                frame={0}
                sheet={spriteUrl ? "auto" : "placeholder"}
                title={displayLabel}
              />
            )}
          </span>
        </button>
      </div>
    </div>
  );
}
