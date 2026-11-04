// Floating brand chip used across the onboarding + world flow. Mirrors
// the Pixel Societies "OfficeBranding" chip — logo + caps title + small
// subtitle, hard-shadow brutalist card.

type Props = {
  variant?: "floating" | "inline";
  subtitle?: string;
  /** Smaller logo + title only — fits next to mobile HUDs without crowding. */
  compact?: boolean;
};

export default function BrandChip({ variant = "floating", subtitle, compact = false }: Props) {
  const wrapperClass =
    variant === "floating"
      ? "fixed top-3 left-3 z-30 sm:top-4 sm:left-4"
      : "";
  return (
    <div className={wrapperClass}>
      <div
        className={
          (compact ? "gap-2 px-2 py-1" : "gap-3 px-3 py-2") +
          " flex items-center border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.97)] shadow-[3px_3px_0_#1f2a3c]"
        }
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/onboarding/logo.svg"
          alt="Pixel Societies"
          className={(compact ? "h-6 w-6" : "h-10 w-10") + " object-contain"}
          style={{ imageRendering: "pixelated" }}
        />
        <div className="flex flex-col">
          <div
            className={
              (compact ? "text-[9px]" : "text-[11px]") +
              " font-mono font-bold uppercase tracking-[0.18em] text-[#1f2a3c]"
            }
          >
            Pixel Societies
          </div>
          <div
            className={
              (compact ? "text-[8px]" : "text-[9px]") +
              " font-mono uppercase tracking-[0.14em] text-[#637387]"
            }
          >
            {subtitle || (compact ? "" : "Multiplayer pixel agents")}
          </div>
        </div>
      </div>
    </div>
  );
}
