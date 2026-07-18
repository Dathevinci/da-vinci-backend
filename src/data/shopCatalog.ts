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
  effect_unblinking: { type: "effect", price: 20000 },
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
