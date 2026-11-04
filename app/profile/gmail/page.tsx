"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiPost } from "@/lib/api";

export default function GmailCallback() {
  const started = useRef(false);
  const [message, setMessage] = useState("Connecting Gmail…");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    // Remove the one-time code before rendering links or making API requests.
    window.history.replaceState({}, "", "/profile/gmail");
    if (params.has("error")) { queueMicrotask(() => setMessage("Gmail permission was not granted. You can connect again from your profile.")); return; }
    const code = params.get("code"), state = params.get("state");
    if (!code || !state) { queueMicrotask(() => setMessage("This connection link has expired. Start again from your profile.")); return; }
    apiPost("/api/integrations/gmail/callback", { code, state })
      .then(() => setMessage("Gmail connected. Return to your profile to generate and review your twin’s current context."))
      .catch(() => setMessage("Could not connect Gmail. Make sure you’re signed in, then start again from your profile."));
  }, []);
  return <main className="min-h-dvh bg-slate-950 p-10 text-white"><p role="status">{message}</p><Link className="mt-6 inline-block underline" href="/profile">Return to profile</Link></main>;
}
