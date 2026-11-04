"use client";

// Agent shop drawer — bottom-fixed two-panel shop matching existing
// drawer patterns (ChatDrawer, WorldConsultDrawer). Shows seller's
// listings on top, buy button per item. Pebble balance in header.
//
// Backend contract:
//   GET  /api/agents/{agent_id}/shop      → { agent_id, agent_display_name, listings }
//   GET  /api/agents/{agent_id}/inventory → { agent_id, pebbles, slots }
//   POST /api/agents/{seller_id}/shop/buy → { ok, error?, buyer_pebbles?, slot_index? }

import { useEffect, useState, useCallback } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api";

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

type ShopListing = {
  listing_id: number;
  price_pebbles: number;
  stock: number;
  item: CatalogItem;
};

type ShopResponse = {
  agent_id: string;
  agent_display_name: string;
  listings: ShopListing[];
};

type BuyResponse = {
  ok: boolean;
  error?: string;
  buyer_pebbles?: number;
  slot_index?: number;
};

// ── Rarity colors ─────────────────────────────────────────────────

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

const TYPE_ICON: Record<string, string> = {
  material: "◇",
  tool: "⚒",
  artifact: "✦",
  memory: "◈",
  consumable: "◉",
  decoration: "❋",
};

// ── Shop listing row ──────────────────────────────────────────────

function ShopItemRow({
  listing,
  buyerPebbles,
  buying,
  onBuy,
}: {
  listing: ShopListing;
  buyerPebbles: number;
  buying: boolean;
  onBuy: () => void;
}) {
  const item = listing.item;
  const canAfford = buyerPebbles >= listing.price_pebbles;
  const inStock = listing.stock !== 0; // -1 = unlimited

  return (
    <div
      className="flex items-center gap-3 border-b-[1px] border-[#e8e4d9] px-3 py-2 last:border-b-0"
    >
      {/* Icon */}
      <div
        className="flex h-[40px] w-[40px] shrink-0 items-center justify-center border-[2px]"
        style={{
          borderColor: RARITY_BORDER[item.rarity],
          backgroundColor: RARITY_BG[item.rarity],
        }}
      >
        <span className="text-[16px]" style={{ color: RARITY_BORDER[item.rarity] }}>
          {item.icon_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.icon_url}
              alt={item.display_name}
              className="h-6 w-6"
              style={{ imageRendering: "pixelated" }}
            />
          ) : (
            TYPE_ICON[item.item_type] || "?"
          )}
        </span>
      </div>
      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-bold leading-tight" style={{ color: RARITY_LABEL_COLOR[item.rarity] }}>
          {item.display_name}
        </p>
        <p className="truncate text-[10px] text-[#7f8b98]">{item.description}</p>
        <div className="mt-0.5 flex items-center gap-2">
          <span
            className="font-mono text-[8px] font-bold uppercase tracking-[0.12em]"
            style={{ color: RARITY_BORDER[item.rarity] }}
          >
            {item.rarity}
          </span>
          {listing.stock >= 0 && (
            <span className="font-mono text-[8px] text-[#7f8b98]">
              {listing.stock} left
            </span>
          )}
        </div>
      </div>
      {/* Price + buy */}
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-mono text-[10px] font-bold text-[#1f2a3c]">
          ◉ {listing.price_pebbles}
        </span>
        <button
          type="button"
          disabled={!canAfford || !inStock || buying}
          onClick={onBuy}
          className="border-[2px] border-[#1f2a3c] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] shadow-[2px_2px_0_#1f2a3c] transition-colors disabled:opacity-40"
          style={{
            backgroundColor: canAfford && inStock ? "#d6f4d6" : "#f6f4ea",
            color: "#1f2a3c",
          }}
        >
          {buying ? "…" : !inStock ? "Sold" : !canAfford ? "Need ◉" : "Buy"}
        </button>
      </div>
    </div>
  );
}

// ── Main drawer ───────────────────────────────────────────────────

type Props = {
  sellerAgentId: string;
  buyerAgentId: string;
  onClose: () => void;
  onPurchase?: () => void;
};

export default function AgentShopDrawer({
  sellerAgentId,
  buyerAgentId,
  onClose,
  onPurchase,
}: Props) {
  const [shop, setShop] = useState<ShopResponse | null>(null);
  const [buyerPebbles, setBuyerPebbles] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [buyingItem, setBuyingItem] = useState<number | null>(null);
  const [buyFeedback, setBuyFeedback] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [shopData, invData] = await Promise.all([
        apiGet<ShopResponse>(`/api/agents/${encodeURIComponent(sellerAgentId)}/shop`),
        apiGet<{ pebbles: number }>(`/api/agents/${encodeURIComponent(buyerAgentId)}/inventory`),
      ]);
      setShop(shopData);
      setBuyerPebbles(invData.pebbles);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : String(err));
    }
  }, [sellerAgentId, buyerAgentId]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleBuy = async (itemId: number) => {
    setBuyingItem(itemId);
    setBuyFeedback(null);
    try {
      const resp = await apiPost<BuyResponse>(
        `/api/agents/${encodeURIComponent(sellerAgentId)}/shop/buy`,
        { buyer_agent_id: buyerAgentId, item_id: itemId },
      );
      if (resp.ok) {
        setBuyFeedback("Purchased!");
        if (resp.buyer_pebbles !== undefined) setBuyerPebbles(resp.buyer_pebbles);
        onPurchase?.();
        // Refresh shop (stock may have changed)
        await loadData();
      } else {
        setBuyFeedback(resp.error || "Purchase failed");
      }
    } catch (err) {
      setBuyFeedback(err instanceof ApiError ? err.message : "Purchase failed");
    } finally {
      setBuyingItem(null);
      setTimeout(() => setBuyFeedback(null), 2000);
    }
  };

  return (
    <div className="fixed bottom-0 left-1/2 z-40 w-[min(560px,calc(100vw-1rem))] -translate-x-1/2">
      <div className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[5px_5px_0_#1f2a3c]">
        {/* Header */}
        <header className="flex items-center justify-between border-b-[3px] border-[#1f2a3c] bg-[#ffe17d] px-4 py-3">
          <div>
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#1f2a3c]">
              Shop
            </p>
            {shop && (
              <p className="text-[13px] font-bold text-[#1f2a3c]">
                {shop.agent_display_name}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Buyer pebble balance */}
            <span className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c]">
              ◉ {buyerPebbles} pebbles
            </span>
            <button
              type="button"
              onClick={onClose}
              className="border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
            >
              Close
            </button>
          </div>
        </header>

        {/* Buy feedback toast */}
        {buyFeedback && (
          <div
            className="border-b-[2px] border-[#1f2a3c] px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-wider"
            style={{
              backgroundColor: buyFeedback === "Purchased!" ? "#d6f4d6" : "#f7ddd7",
              color: buyFeedback === "Purchased!" ? "#2d5a2d" : "#6d2d24",
            }}
          >
            {buyFeedback}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="border-b-[2px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24]">
            {error}
          </div>
        )}

        {/* Loading */}
        {!shop && !error && (
          <div className="flex items-center justify-center py-8 font-mono text-[11px] uppercase tracking-wider text-[#7f8b98]">
            Loading…
          </div>
        )}

        {/* Listings */}
        {shop && (
          <div className="max-h-[44vh] min-h-[120px] overflow-y-auto bg-[#f6f4ea]">
            {shop.listings.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#8a7d68]">
                  Nothing for sale
                </p>
                <p className="mt-1 text-[11px] text-[#7f8b98]">
                  This agent hasn&apos;t stocked their shop yet.
                </p>
              </div>
            ) : (
              shop.listings.map((listing) => (
                <ShopItemRow
                  key={listing.listing_id}
                  listing={listing}
                  buyerPebbles={buyerPebbles}
                  buying={buyingItem === listing.item.id}
                  onBuy={() => handleBuy(listing.item.id)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
