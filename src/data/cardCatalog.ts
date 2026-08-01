// ═══════════════════════════════════════════════════════════════════════════
// ARISE CARDS — the collectible set.
//
// Server-authoritative, exactly like the shop catalog: the client never says
// which card it got or what a pack costs. Art is procedural (a hue + rarity is
// enough for the client to draw the whole card), so a new card is one line here
// and needs no image.
//
// The ONLY Arise-Points movement in the whole card system is buying a pack —
// that is the repeatable sink. Duplicates dust into SHARDS (a separate,
// card-only currency) and shards craft a specific card, so bad luck never fully
// blocks a determined collector, and none of that touches AP.
// ═══════════════════════════════════════════════════════════════════════════

export type CardRarity = "common" | "rare" | "epic" | "legendary" | "event";

export interface CardDef {
  id: string;
  name: string;
  rarity: CardRarity;
  set: string;
  hue: number;     // 0-360, drives the procedural art
  flavor: string;
}

// The base set. `event` cards are NOT in the normal pack pool (see PACK_POOL) —
// they drop only from event packs the Lead Dev opens up, so they stay rare.
export const CARDS: Record<string, CardDef> = {
  // ── Common (the volume; easy set-completion wins) ──
  card_watcher:    { id: "card_watcher",    name: "The Watcher",        rarity: "common", set: "Ascension", hue: 265, flavor: "Every journey begins by simply paying attention." },
  card_firstlight: { id: "card_firstlight", name: "First Light",        rarity: "common", set: "Ascension", hue: 45,  flavor: "The first heartbeat of a new cultivator." },
  card_scribe:     { id: "card_scribe",     name: "The Scribe",         rarity: "common", set: "Ascension", hue: 200, flavor: "Ten thousand chapters, read one at a time." },
  card_seedling:   { id: "card_seedling",   name: "Verdant Seedling",   rarity: "common", set: "Ascension", hue: 140, flavor: "Small now. Not for long." },
  card_ember:      { id: "card_ember",      name: "Lone Ember",         rarity: "common", set: "Ascension", hue: 20,  flavor: "It only takes one." },
  card_ripple:     { id: "card_ripple",     name: "Still Ripple",       rarity: "common", set: "Ascension", hue: 190, flavor: "Calm water remembers every stone." },
  card_moth:       { id: "card_moth",       name: "Pale Moth",          rarity: "common", set: "Ascension", hue: 280, flavor: "Drawn to a light it will never reach." },
  card_pilgrim:    { id: "card_pilgrim",    name: "The Pilgrim",        rarity: "common", set: "Ascension", hue: 30,  flavor: "The road is long. Good." },

  // ── Rare ──
  card_heartrank:  { id: "card_heartrank",  name: "Heart Cultivation",  rarity: "rare", set: "Ascension", hue: 330, flavor: "The rank is not given. It is grown." },
  card_stormcall:  { id: "card_stormcall",  name: "Storm's Herald",     rarity: "rare", set: "Ascension", hue: 210, flavor: "Thunder is only the storm clearing its throat." },
  card_lotus:      { id: "card_lotus",      name: "Sacred Bloom",       rarity: "rare", set: "Ascension", hue: 320, flavor: "It opens for no one, and everyone." },
  card_frost:      { id: "card_frost",      name: "Silent Summit",      rarity: "rare", set: "Ascension", hue: 195, flavor: "The mountain does not notice the cold." },
  card_ashfall:    { id: "card_ashfall",    name: "Ashfall",            rarity: "rare", set: "Ascension", hue: 5,   flavor: "Something burned here. Something remained." },
  card_wanderer:   { id: "card_wanderer",   name: "The Wanderer",       rarity: "rare", set: "Ascension", hue: 50,  flavor: "Home is a direction, not a place." },

  // ── Epic ──
  card_voidgaze:   { id: "card_voidgaze",   name: "The Void's Gaze",    rarity: "epic", set: "Ascension", hue: 185, flavor: "Look long enough and it blinks back." },
  card_ninehands:  { id: "card_ninehands",  name: "Nine-Handed Wheel",  rarity: "epic", set: "Ascension", hue: 42,  flavor: "It has adapted to this before." },
  card_crimsonsea: { id: "card_crimsonsea", name: "The Crimson Sea",    rarity: "epic", set: "Ascension", hue: 350, flavor: "A tide that only ever comes in." },
  card_unblinking: { id: "card_unblinking", name: "The Unblinking",     rarity: "epic", set: "Ascension", hue: 0,   flavor: "It noticed you the moment you noticed it." },

  // ── Legendary ──
  card_outergod:   { id: "card_outergod",   name: "The Outer God",      rarity: "legendary", set: "Ascension", hue: 172, flavor: "It does not want. It simply is, and that is worse." },
  card_gatekey:    { id: "card_gatekey",    name: "The Gate & The Key", rarity: "legendary", set: "Ascension", hue: 275, flavor: "It is the door, the lock, and the thing on the other side." },

  // ── Event (limited; NOT in normal packs) ──
  card_founder:    { id: "card_founder",    name: "The Founder's Seal", rarity: "event", set: "Genesis", hue: 290, flavor: "Given to those who were here at the beginning." },
};

// Normal packs can roll everything EXCEPT event cards.
const PACK_POOL = Object.values(CARDS).filter((c) => c.rarity !== "event");

export const PACK_PRICE = 250;   // AP — reachable even for sub-500 balances
export const PACK_SIZE = 4;

// Per-card rarity roll for a normal pack. Weighted so a pack usually feels like
// commons + a rare, with epics/legendaries as the chase.
const RARITY_WEIGHTS: Record<Exclude<CardRarity, "event">, number> = {
  common: 62,
  rare: 27,
  epic: 9,
  legendary: 2,
};

// Dust value (shards you get for one duplicate) and craft cost (shards to make a
// chosen card). Craft costs MORE than dust returns at the same rarity — recycling
// is a grind, not an exploit, so you can't dust-and-craft your way to profit.
export const DUST_VALUE: Record<CardRarity, number> = {
  common: 5, rare: 15, epic: 40, legendary: 120, event: 0, // event cards can't be dusted
};
export const CRAFT_COST: Record<CardRarity, number> = {
  common: 40, rare: 120, epic: 340, legendary: 1000, event: 0, // event can't be crafted
};

// Roll one pack → a list of card ids. Uses Math.random (fine on the server).
export function rollPack(size = PACK_SIZE): string[] {
  const byRarity: Record<string, CardDef[]> = {};
  for (const c of PACK_POOL) (byRarity[c.rarity] ||= []).push(c);
  const totalW = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);

  const out: string[] = [];
  for (let i = 0; i < size; i++) {
    let r = Math.random() * totalW;
    let picked: CardRarity = "common";
    for (const [rar, w] of Object.entries(RARITY_WEIGHTS)) {
      r -= w;
      if (r <= 0) { picked = rar as CardRarity; break; }
    }
    const pool = byRarity[picked] || byRarity.common;
    out.push(pool[Math.floor(Math.random() * pool.length)].id);
  }
  return out;
}

// How many distinct cards a full collection has (for set-completion %).
export const TOTAL_CARDS = Object.keys(CARDS).length;
