// Canonical, server-side price list for gifting. The client tells us WHICH item
// and WHO gets it, but the server decides the price and which inventory array it
// lands in — so nobody can gift a 25,000-point effect for free.
//
// Only shop-PURCHASABLE items live here. Non-purchasable / donor-exclusive ids
// (e.g. effect_crimson) are intentionally absent, so they can never be gifted.
// Keep in sync with the frontend SHOP_ITEMS.

export type ShopItemType = "effect" | "frame";

export interface CatalogEntry {
  type: ShopItemType;
  price: number;
  // Limited-time drops: after this ISO instant the item can no longer be
  // bought OR gifted (checked server-side in gift.controller). Owners keep it.
  availableUntil?: string;
}

// True when a catalog item is still purchasable/giftable right now.
export function isAvailable(item: CatalogEntry): boolean {
  return !item.availableUntil || Date.now() <= new Date(item.availableUntil).getTime();
}

export const SHOP_CATALOG: Record<string, CatalogEntry> = {
  // ── effects ──
  effect_ritual: { type: "effect", price: 25000 },
  effect_himalaya: { type: "effect", price: 25500 },
  effect_samurai: { type: "effect", price: 12000 },
  effect_lotus: { type: "effect", price: 12000 },
  effect_mango: { type: "effect", price: 12500 },
  effect_jungle: { type: "effect", price: 12500 },
  effect_canopy: { type: "effect", price: 10000 },
  effect_mahoraga: { type: "effect", price: 8000 },
  effect_tempest: { type: "effect", price: 7500 },
  effect_blackhole: { type: "effect", price: 7500 },
  effect_void: { type: "effect", price: 21200 },
  effect_unblinking: { type: "effect", price: 20000 },
  effect_hollow: { type: "effect", price: 17500 },
  // LIMITED DROP — vanishes from sale after the window closes (owners keep it).
  effect_dejavu: { type: "effect", price: 15000, availableUntil: "2026-07-24T23:59:59Z" },
  effect_evernight: { type: "effect", price: 6500 },
  effect_fool: { type: "effect", price: 6000 },
  effect_ascension: { type: "effect", price: 5000 },
  effect_froggie: { type: "effect", price: 500 },
  effect_aura: { type: "effect", price: 110 },
  effect_sparkles: { type: "effect", price: 100 },
  effect_snow: { type: "effect", price: 90 },
  effect_embers: { type: "effect", price: 90 },

  // ── frames ──
  frame_amethyst: { type: "frame", price: 90 },
  frame_gold: { type: "frame", price: 110 },
  frame_ember: { type: "frame", price: 100 },
  frame_frost: { type: "frame", price: 100 },
  frame_verdant: { type: "frame", price: 90 },
};

// Which "purchasedX" array an item type lands in.
export const PURCHASED_FIELD: Record<ShopItemType, "purchasedEffects" | "purchasedFrames"> = {
  effect: "purchasedEffects",
  frame: "purchasedFrames",
};

/**
 * Themed bundles — buy a whole collection at a discount.
 *
 * Server-authoritative, exactly like SHOP_CATALOG: the client never sends a
 * price. The backend decides which of the set you still need, sums those, and
 * applies the discount to that remainder — so someone who already owns three of
 * four does not pay for all four.
 *
 * The member lists mirror the collections shown on the shop page. They live here
 * as well because the frontend copy is display-only; this one is the one that
 * decides what you are charged and what you receive.
 */
export const BUNDLE_DISCOUNT = 0.2; // 20% off the items you don't already own

export interface BundleEntry {
  name: string;
  items: string[];
}

export const SHOP_BUNDLES: Record<string, BundleEntry> = {
  bundle_jujutsu: {
    name: "The Sorcery Collection",
    items: ["effect_void", "effect_hollow", "effect_mahoraga", "effect_ritual"],
  },
  bundle_mysteries: {
    name: "The Mysteries Collection",
    items: ["effect_fool", "effect_evernight"],
  },
  bundle_nature: {
    name: "The Wild Collection",
    items: ["effect_himalaya", "effect_jungle", "effect_lotus", "effect_canopy"],
  },
  bundle_cosmic: {
    name: "The Cosmic Collection",
    items: ["effect_blackhole", "effect_ascension", "effect_unblinking"],
  },
};
