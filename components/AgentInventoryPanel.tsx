"use client";

// Agent inventory panel — grid-based item display matching the app's
// warm cream brutalist design. Shows a 6×8 inventory grid, pebble
// balance, and item detail on selection. Slide-in from right, same
// pattern as AgentProfilePanel.
//
// Backend contract:
//   GET /api/agents/{agent_id}/inventory → { agent_id, pebbles, slots }

import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────

type CatalogItem = {
  id: number;
  slug: string;
  display_name: string;
  description: string | null;
  flavor_text: string | null;
  item_type: string;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  icon_url: string | null;
  base_price: number;
  stackable: boolean;
  max_stack: number;
};

type InventorySlot = {
  slot_index: number;
  quantity: number;
  item: CatalogItem;
};

type InventoryResponse = {
  agent_id: string;
  pebbles: number;
  slots: InventorySlot[];
};

// ── Rarity colors (matching standard game conventions) ────────────

const RARITY_BORDER: Record<string, string> = {
  common: "#8a7d68",
  uncommon: "#5a8a4a",
  rare: "#4a6a9a",
  epic: "#7a4a9a",
  legendary: "#9a6a2a",
};

const RARITY_BG: Record<string, string> = {
  common: "#f6f4ea",
  uncommon: "#edf5eb",
  rare: "#ebf0f7",
  epic: "#f3ebf7",
  legendary: "#f7f0e6",
};

const RARITY_LABEL_COLOR: Record<string, string> = {
  common: "#8a7d68",
  uncommon: "#4a7a3a",
  rare: "#3a5a8a",
  epic: "#6a3a8a",
  legendary: "#8a5a1a",
};

// ── Item type icons (monospace text fallbacks) ────────────────────

const TYPE_ICON: Record<string, string> = {
  material: "◇",
  tool: "⚒",
  artifact: "✦",
  memory: "◈",
  consumable: "◉",
  decoration: "❋",
};

// ── Slot component ────────────────────────────────────────────────

function InventorySlotCell({
  slot,
  selected,
  onClick,
}: {
  slot: InventorySlot | null;
  selected: boolean;
  onClick: () => void;
}) {
  if (!slot) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex h-[52px] w-[52px] items-center justify-center border-[2px] border-[#d4c4a8] bg-[#faf3e6]"
        style={{ opacity: 0.5 }}
      />
    );
  }
  const rarity = slot.item.rarity;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex h-[52px] w-[52px] items-center justify-center border-[2px] transition-colors"
      style={{
        borderColor: selected ? "#1f2a3c" : RARITY_BORDER[rarity],
        backgroundColor: RARITY_BG[rarity],
        boxShadow: selected ? "2px 2px 0 #1f2a3c" : "none",
      }}
    >
      {/* Item icon or type symbol */}
      <span className="text-[20px] leading-none" style={{ color: RARITY_BORDER[rarity] }}>
        {slot.item.icon_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={slot.item.icon_url}
            alt={slot.item.display_name}
            className="h-8 w-8"
            style={{ imageRendering: "pixelated" }}
          />
        ) : (
          TYPE_ICON[slot.item.item_type] || "?"
        )}
      </span>
      {/* Quantity badge */}
      {slot.quantity > 1 && (
        <span
          className="absolute bottom-0.5 right-0.5 font-mono text-[8px] font-bold leading-none"
          style={{ color: "#1f2a3c" }}
        >
          {slot.quantity}
        </span>
      )}
      {/* Rarity pip */}
      <span
        className="absolute left-0.5 top-0.5 h-[5px] w-[5px] rounded-full"
        style={{ backgroundColor: RARITY_BORDER[rarity] }}
      />
    </button>
  );
}

// ── Detail card ───────────────────────────────────────────────────

function ItemDetailCard({ item, quantity }: { item: CatalogItem; quantity: number }) {
  const rarityColor = RARITY_LABEL_COLOR[item.rarity];
  return (
    <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[3px_3px_0_#1f2a3c]">
      {/* Header */}
      <div className="border-b-[2px] border-[#e8e4d9] px-3 py-2">
        <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#637387]">
          {item.item_type}
        </p>
        <h3 className="mt-0.5 text-[15px] font-bold leading-tight" style={{ color: rarityColor }}>
          {item.display_name}
        </h3>
      </div>
      {/* Body */}
      <div className="px-3 py-3">
        {/* Rarity + quantity row */}
        <div className="mb-2 flex items-center gap-2">
          <span
            className="border-[2px] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.16em]"
            style={{
              borderColor: RARITY_BORDER[item.rarity],
              color: rarityColor,
              backgroundColor: RARITY_BG[item.rarity],
            }}
          >
            {item.rarity}
          </span>
          {quantity > 1 && (
            <span className="font-mono text-[10px] font-bold text-[#1f2a3c]">
              ×{quantity}
            </span>
          )}
        </div>
        {/* Description */}
        {item.description && (
          <p className="text-[12px] leading-relaxed text-[#1f2a3c]">
            {item.description}
          </p>
        )}
        {/* Flavor text */}
        {item.flavor_text && (
          <p className="mt-2 text-[11px] italic leading-relaxed text-[#8a7d68]">
            {item.flavor_text}
          </p>
        )}
        {/* Stats row */}
        <div className="mt-3 flex items-center gap-3 border-t-[1px] border-[#e8e4d9] pt-2">
          <span className="font-mono text-[10px] font-bold text-[#637387]">
            ◉ {item.base_price} pebbles
          </span>
          {item.stackable && (
            <span className="font-mono text-[9px] text-[#7f8b98]">
              max {item.max_stack}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────

const GRID_COLS = 6;
const GRID_ROWS = 8;
const TOTAL_SLOTS = GRID_COLS * GRID_ROWS;

type Props = {
  agentId: string;
  agentName: string;
  onClose: () => void;
};

export default function AgentInventoryPanel({ agentId, agentName, onClose }: Props) {
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await apiGet<InventoryResponse>(
          `/api/agents/${encodeURIComponent(agentId)}/inventory`,
        );
        if (!cancelled) setData(resp);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof ApiError ? `${err.status}: ${err.message}` : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Build slot map for O(1) lookup
  const slotMap = new Map<number, InventorySlot>();
  if (data) {
    for (const s of data.slots) slotMap.set(s.slot_index, s);
  }

  const selectedItem = selectedSlot !== null ? slotMap.get(selectedSlot) ?? null : null;

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close inventory"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-[rgba(12,22,38,0.55)] backdrop-blur-sm"
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-label="Agent inventory"
        className="fixed inset-y-3 right-3 z-50 flex w-[min(440px,calc(100vw-1.5rem))] flex-col overflow-hidden border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.99)] text-[#1f2a3c] shadow-[6px_6px_0_#1f2a3c] sm:inset-y-4 sm:right-4"
      >
        {/* Header */}
        <header className="flex items-center justify-between border-b-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-3">
          <div>
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#637387]">
              Inventory
            </p>
            <p className="text-[13px] font-bold text-[#1f2a3c]">{agentName}</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Pebble balance */}
            {data && (
              <span className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]">
                ◉ {data.pebbles} pebbles
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
            >
              Close
            </button>
          </div>
        </header>

        {/* Error */}
        {error && (
          <div className="m-3 border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-3 py-2 shadow-[3px_3px_0_#1f2a3c]">
            <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#6d2d24]">
              Could not load inventory
            </p>
            <p className="mt-1 text-[10px] text-[#6d2d24]">
              Backend may not be running. Start it with: uvicorn app.main:app --port 4000
            </p>
          </div>
        )}

        {/* Loading */}
        {!data && !error && (
          <div className="flex flex-1 items-center justify-center p-8 font-mono text-[11px] uppercase tracking-wider text-[#7f8b98]">
            Loading…
          </div>
        )}

        {/* Always show grid — empty if error/loading, populated if data */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {/* Inventory grid */}
          <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[3px_3px_0_#1f2a3c]">
            <div className="border-b-[2px] border-[#e8e4d9] px-3 py-2">
              <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#637387]">
                Items
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-[#7f8b98]">
                {data ? data.slots.length : 0}/{TOTAL_SLOTS} slots used
              </p>
            </div>
            <div className="p-3">
              <div
                className="grid gap-[3px]"
                style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 52px)` }}
              >
                {Array.from({ length: TOTAL_SLOTS }, (_, i) => {
                  const slot = slotMap.get(i) ?? null;
                  return (
                    <InventorySlotCell
                      key={i}
                      slot={slot}
                      selected={selectedSlot === i}
                      onClick={() => setSelectedSlot(selectedSlot === i ? null : i)}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {/* Selected item detail */}
          {selectedItem && (
            <div className="mt-4">
              <ItemDetailCard item={selectedItem.item} quantity={selectedItem.quantity} />
            </div>
          )}

          {/* Empty state */}
          {data && data.slots.length === 0 && !error && (
            <div className="mt-4 border-[2px] border-dashed border-[#d4c4a8] px-4 py-6 text-center">
              <p className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#8a7d68]">
                Empty inventory
              </p>
              <p className="mt-1 text-[11px] text-[#7f8b98]">
                Visit other agents&apos; shops to acquire items.
              </p>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
