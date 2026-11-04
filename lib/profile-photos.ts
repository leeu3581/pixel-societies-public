// Portraits for the bundled world roster.
export const PROFILE_PHOTOS: Record<string, string> = {
  "sales": "/profiles/sales.svg",
  "support": "/profiles/joon.jpg",
  "marketing": "/profiles/marketing.svg",
  "product": "/profiles/nat.jpg",
  "success": "/profiles/success.svg",
  "engineering": "/profiles/yuri.png"
};
export function photoForAgent(canonicalId: string | null | undefined): string | null {
  return canonicalId ? PROFILE_PHOTOS[canonicalId] ?? null : null;
}
