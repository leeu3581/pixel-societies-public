import { NextResponse } from "next/server";
import { safeAuthNext } from "@/lib/auth-redirect";

// Supabase OAuth callbacks cannot establish a self-hosted session.
// Preserve the requested destination while reporting that sign-in is needed.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = new URL("/login", request.url);
  target.searchParams.set("next", safeAuthNext(url.searchParams.get("next")));
  target.searchParams.set("error", "auth");
  return NextResponse.redirect(target);
}
