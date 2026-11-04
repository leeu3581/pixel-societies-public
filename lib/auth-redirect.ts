/** Accept only paths on this app, including query strings and fragments. */
export function safeAuthNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return "/onboarding";
  try {
    const url = new URL(value, "https://pixel.invalid");
    if (url.origin !== "https://pixel.invalid" || ["/login", "/auth/callback"].includes(url.pathname)) return "/onboarding";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/onboarding";
  }
}
