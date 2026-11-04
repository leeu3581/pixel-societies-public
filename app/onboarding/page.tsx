"use client";

// Onboarding router. Decides which sub-step the user belongs in based on
// their profile state, and redirects accordingly. Returning users who
// already have a profile go straight to /world — they don't need to
// re-onboard on every login.
//
// Decisions:
//   no auth                               -> /login?next=/onboarding
//   imported builder profile              -> shared cafe
//   self-agent exists                     -> history (image may still generate)
//   otherwise                             -> /onboarding/name (always first question)
//
// Re-uploading a photo later is supported via the "Re-upload photo"
// link in the /world HUD — that path goes directly to /onboarding/photo.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchSession } from "@/lib/authClient";
import BrandChip from "@/components/BrandChip";
import { apiGet } from "@/lib/api";

const MAP_BG = "/onboarding/map-bg.png";

export default function OnboardingRouter() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const user = await fetchSession();
        if (!user) {
          router.replace("/login?next=/onboarding");
          return;
        }
        const state = await apiGet<{ imported: boolean; character_started: boolean; world_slug: string }>("/api/ingest/claude-code");
        router.replace(state.imported ? `/worlds/${encodeURIComponent(state.world_slug)}`
          : state.character_started ? "/onboarding/history" : "/onboarding/name");
      } catch {
        setError("Could not load your onboarding progress. Refresh to try again.");
      }
    })();
  }, [router]);

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-[#0c1626] px-4"
      style={{
        backgroundImage: `linear-gradient(rgba(12, 22, 38, 0.72), rgba(12, 22, 38, 0.82)), url(${MAP_BG})`,
        backgroundPosition: "center top",
        backgroundSize: "cover",
      }}
    >
      <BrandChip />
      <div className="font-mono text-sm uppercase tracking-wider text-[#dcecf4]">
        {error ?? "Routing…"}
      </div>
    </main>
  );
}
