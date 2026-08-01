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

// Each motif is a DIFFERENT procedurally-drawn scene on the client. This is
// what stops 39 cards looking like 39 recolours of one shape.
export type CardMotif =
  | "eye" | "wheel" | "tendril" | "peak" | "lotus" | "storm" | "gate"
  | "ember" | "moth" | "ripple" | "seed" | "scroll" | "path" | "seal"
  | "heart" | "sea" | "dawn" | "web"
  | "leviathan" | "trench" | "blade" | "mask" | "bell" | "comet";

// What a support card DOES when played. Support cards are collected like any
// other card and owned permanently — the limit is one use of each per duel,
// so a card you chased stays yours instead of being burned on a single fight.
export type SupportEffect =
  | { kind: "heal"; power: number }        // restore HP to your active card
  | { kind: "shield" }                     // halve the next damage you take
  | { kind: "block" }                      // negate the next attack entirely
  | { kind: "focus"; power: number }       // multiply your next attack
  | { kind: "mend"; power: number }        // heal EVERY living card you have
  | { kind: "revive"; power: number };     // bring a fallen card back at power%

export interface CardDef {
  id: string;
  name: string;
  rarity: CardRarity;
  set: string;
  hue: number;      // 0-360, drives the palette
  motif: CardMotif; // drives WHAT is drawn
  flavor: string;
  /** Units fight; support cards are played for an effect. Absent = unit. */
  support?: SupportEffect;
}

// The base set. `event` cards are NOT in the normal pack pool (see PACK_POOL) —
// they drop only from event packs the Lead Dev opens up, so they stay rare.
export const CARDS: Record<string, CardDef> = {
  // ── Common (the volume; easy set-completion wins) ──
  card_watcher:    { id: "card_watcher",    name: "The Watcher",        rarity: "common", set: "Ascension", hue: 265, motif: "eye", flavor: "Every journey begins by simply paying attention." },
  card_firstlight: { id: "card_firstlight", name: "First Light",        rarity: "common", set: "Ascension", hue: 45,  motif: "dawn", flavor: "The first heartbeat of a new cultivator." },
  card_scribe:     { id: "card_scribe",     name: "The Scribe",         rarity: "common", set: "Ascension", hue: 200, motif: "scroll", flavor: "Ten thousand chapters, read one at a time." },
  card_seedling:   { id: "card_seedling",   name: "Verdant Seedling",   rarity: "common", set: "Ascension", hue: 140, motif: "seed", flavor: "Small now. Not for long." },
  card_ember:      { id: "card_ember",      name: "Lone Ember",         rarity: "common", set: "Ascension", hue: 20,  motif: "ember", flavor: "It only takes one." },
  card_ripple:     { id: "card_ripple",     name: "Still Ripple",       rarity: "common", set: "Ascension", hue: 190, motif: "ripple", flavor: "Calm water remembers every stone." },
  card_moth:       { id: "card_moth",       name: "Pale Moth",          rarity: "common", set: "Ascension", hue: 280, motif: "moth", flavor: "Drawn to a light it will never reach." },
  card_pilgrim:    { id: "card_pilgrim",    name: "The Pilgrim",        rarity: "common", set: "Ascension", hue: 30,  motif: "path", flavor: "The road is long. Good." },

  // ── Rare ──
  card_heartrank:  { id: "card_heartrank",  name: "Heart Cultivation",  rarity: "rare", set: "Ascension", hue: 330, motif: "heart", flavor: "The rank is not given. It is grown." },
  card_stormcall:  { id: "card_stormcall",  name: "Storm's Herald",     rarity: "rare", set: "Ascension", hue: 210, motif: "storm", flavor: "Thunder is only the storm clearing its throat." },
  card_lotus:      { id: "card_lotus",      name: "Sacred Bloom",       rarity: "rare", set: "Ascension", hue: 320, motif: "lotus", flavor: "It opens for no one, and everyone." },
  card_frost:      { id: "card_frost",      name: "Silent Summit",      rarity: "rare", set: "Ascension", hue: 195, motif: "peak", flavor: "The mountain does not notice the cold." },
  card_ashfall:    { id: "card_ashfall",    name: "Ashfall",            rarity: "rare", set: "Ascension", hue: 5,   motif: "ember", flavor: "Something burned here. Something remained." },
  card_wanderer:   { id: "card_wanderer",   name: "The Wanderer",       rarity: "rare", set: "Ascension", hue: 50,  motif: "path", flavor: "Home is a direction, not a place." },

  // ── Epic ──
  card_voidgaze:   { id: "card_voidgaze",   name: "The Void's Gaze",    rarity: "epic", set: "Ascension", hue: 185, motif: "eye", flavor: "Look long enough and it blinks back." },
  card_ninehands:  { id: "card_ninehands",  name: "Nine-Handed Wheel",  rarity: "epic", set: "Ascension", hue: 42,  motif: "wheel", flavor: "It has adapted to this before." },
  card_crimsonsea: { id: "card_crimsonsea", name: "The Crimson Sea",    rarity: "epic", set: "Ascension", hue: 350, motif: "sea", flavor: "A tide that only ever comes in." },
  card_unblinking: { id: "card_unblinking", name: "The Unblinking",     rarity: "epic", set: "Ascension", hue: 0,   motif: "eye", flavor: "It noticed you the moment you noticed it." },

  // ── Legendary ──
  card_outergod:   { id: "card_outergod",   name: "The Outer God",      rarity: "legendary", set: "Ascension", hue: 172, motif: "tendril", flavor: "It does not want. It simply is, and that is worse." },
  card_gatekey:    { id: "card_gatekey",    name: "The Gate & The Key", rarity: "legendary", set: "Ascension", hue: 275, motif: "gate", flavor: "It is the door, the lock, and the thing on the other side." },

  // ═══ SET · ABYSSAL — deep water, and what keeps its own counsel ═══════════
  // ── Common ──
  card_driftlight:    { id: "card_driftlight",    name: "Drift Light",            rarity: "common", set: "Abyssal", hue: 178, motif: "ember", flavor: "A single glow, drifting where nothing else bothers to shine." },
  card_saltmask:      { id: "card_saltmask",      name: "Salt-Worn Mask",         rarity: "common", set: "Abyssal", hue: 192, motif: "mask", flavor: "The drowned left their faces on the rocks and kept swimming." },
  card_shelfedge:     { id: "card_shelfedge",     name: "The Shelf's Edge",       rarity: "common", set: "Abyssal", hue: 212, motif: "trench", flavor: "The seafloor ends here, and then it keeps ending." },
  card_kelpwood:      { id: "card_kelpwood",      name: "Kelpwood",               rarity: "common", set: "Abyssal", hue: 165, motif: "tendril", flavor: "A forest that sways for a wind no one has ever felt." },
  card_coldcurrent:   { id: "card_coldcurrent",   name: "Cold Current",           rarity: "common", set: "Abyssal", hue: 200, motif: "ripple", flavor: "Something vast went by an hour ago; the water is still shaking." },

  // ── Rare ──
  card_divingbell:    { id: "card_divingbell",    name: "The Diving Bell",        rarity: "rare", set: "Abyssal", hue: 196, motif: "bell", flavor: "Down is the only direction that ever answers." },
  card_lightlessreef: { id: "card_lightlessreef", name: "Lightless Reef",         rarity: "rare", set: "Abyssal", hue: 174, motif: "web", flavor: "It built a city out of patience and calcium." },

  // ── Epic ──
  card_fallenstar:    { id: "card_fallenstar",    name: "The Fallen Star",        rarity: "epic", set: "Abyssal", hue: 232, motif: "comet", flavor: "It came down through the water, and the water made room." },
  card_trenchmaw:     { id: "card_trenchmaw",     name: "The Trench Maw",         rarity: "epic", set: "Abyssal", hue: 220, motif: "trench", flavor: "The charts call it a depth; the sailors call it a mouth." },

  // ── Legendary ──
  card_leviathan:     { id: "card_leviathan",     name: "The Sleeping Leviathan", rarity: "legendary", set: "Abyssal", hue: 186, motif: "leviathan", flavor: "It has not woken in an age, and the tides are only its breathing." },

  // ═══ SET · RONIN — a sword, a road, and no one left to serve ══════════════
  // ── Common ──
  card_strawcloak:  { id: "card_strawcloak",  name: "Straw Cloak",         rarity: "common", set: "Ronin", hue: 38,  motif: "path", flavor: "He walks through the rain because the rain is on the way." },
  card_whetstone:   { id: "card_whetstone",   name: "The Whetstone",       rarity: "common", set: "Ronin", hue: 208, motif: "blade", flavor: "Patience, ground fine enough to cut." },
  card_clancrest:   { id: "card_clancrest",   name: "Broken Clan Crest",   rarity: "common", set: "Ronin", hue: 350, motif: "seal", flavor: "A house remembered only by the shape it left in the wax." },

  // ── Rare ──
  card_duskduel:    { id: "card_duskduel",    name: "Duel at Dusk",        rarity: "rare", set: "Ronin", hue: 22,  motif: "blade", flavor: "Two shadows agree on everything except which one walks away." },
  card_templebell:  { id: "card_templebell",  name: "The Temple Bell",     rarity: "rare", set: "Ronin", hue: 45,  motif: "bell", flavor: "It is rung once for the dead and once for whoever is listening." },
  card_nightcomet:  { id: "card_nightcomet",  name: "Comet Over the Pass", rarity: "rare", set: "Ronin", hue: 232, motif: "comet", flavor: "The banner-men read it as an omen; it was only a stone in a hurry." },

  // ── Epic ──
  card_onimask:     { id: "card_onimask",     name: "The Oni's Face",      rarity: "epic", set: "Ronin", hue: 352, motif: "mask", flavor: "He put it on to frighten bandits and never found a reason to take it off." },

  // ── Legendary ──
  card_lastronin:   { id: "card_lastronin",   name: "The Last Ronin",      rarity: "legendary", set: "Ronin", hue: 8,   motif: "blade", flavor: "No lord remains to serve, and still the blade is drawn at dawn." },

  // ═══ SET · SUCCOUR — the support cards ════════════════════════════════════
  // Collected from packs like everything else and owned forever; each may be
  // played ONCE per duel. Kept in their own set so completing them is its own
  // chase, and so they can be balanced without touching the fighters.
  card_salve:      { id: "card_salve",      name: "Field Salve",      rarity: "common", set: "Succour", hue: 145, motif: "seed",   flavor: "Rough cloth, cold water, and someone willing to stay.", support: { kind: "heal", power: 10 } },
  card_emberdraught:{ id: "card_emberdraught", name: "Ember Draught", rarity: "common", set: "Succour", hue: 28,  motif: "ember",  flavor: "It burns going down. That is rather the point.", support: { kind: "focus", power: 1.5 } },
  card_stillwater: { id: "card_stillwater", name: "Stillwater Rite",  rarity: "common", set: "Succour", hue: 195, motif: "ripple", flavor: "Breathe. The blade will still be there after.", support: { kind: "shield" } },
  card_deepsalve:  { id: "card_deepsalve",  name: "Deep Salve",       rarity: "rare",   set: "Succour", hue: 160, motif: "lotus",  flavor: "Closes what the field salve only quiets.", support: { kind: "heal", power: 22 } },
  card_bulwark:    { id: "card_bulwark",    name: "Bulwark Ward",     rarity: "rare",   set: "Succour", hue: 210, motif: "gate",   flavor: "A door is only a wall that changed its mind.", support: { kind: "block" } },
  card_warcry:     { id: "card_warcry",     name: "War Cry",          rarity: "rare",   set: "Succour", hue: 12,  motif: "bell",   flavor: "Not a plan. A promise, shouted.", support: { kind: "focus", power: 2 } },
  card_communion:  { id: "card_communion",  name: "Quiet Communion",  rarity: "epic",   set: "Succour", hue: 280, motif: "heart",  flavor: "Everyone stands a little straighter, and nobody says why.", support: { kind: "mend", power: 12 } },
  card_secondwind: { id: "card_secondwind", name: "Second Wind",      rarity: "legendary", set: "Succour", hue: 48, motif: "dawn", flavor: "The dead are only the resting, if you argue well enough.", support: { kind: "revive", power: 50 } },

  // ── Event (limited; NOT in normal packs) ──
  card_founder:    { id: "card_founder",    name: "The Founder's Seal", rarity: "event", set: "Genesis", hue: 290, motif: "seal", flavor: "Given to those who were here at the beginning." },
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

// ═══ WHAT SHARDS ARE FOR ═══════════════════════════════════════════════════
// Three sinks, so shards are a currency rather than a number that only goes up:
//   1. CRAFT  — buy a specific card outright (CRAFT_COST above).
//   2. FOIL   — upgrade a card you own into its animated foil variant. It looks
//               incredible AND fights 20% harder in duels (see FOIL_MULT in
//               duelRules), so shards are the bridge between collecting and
//               competing: dust what luck gave you, sharpen what you kept.
//   3. RELIC PACK — a pack guaranteed to contain at least one EPIC or better.
//               Bought with shards, not AP, so a patient collector can convert
//               grinding into targeted luck.
export const FOIL_COST: Record<CardRarity, number> = {
  common: 60, rare: 150, epic: 400, legendary: 900, event: 500,
};
export const RELIC_PACK_SHARDS = 500;

// Roll a relic pack: normal odds, but the first slot is forced to epic+.
export function rollRelicPack(size = PACK_SIZE): string[] {
  const chase = PACK_POOL.filter((c) => c.rarity === "epic" || c.rarity === "legendary");
  const guaranteed = chase[Math.floor(Math.random() * chase.length)].id;
  return [guaranteed, ...rollPack(size - 1)];
}

// ═══ WHAT THE CARDS ARE FOR ════════════════════════════════════════════════
// Completing a set pays out ONCE: Arise Points back, a chunk of shards, and a
// permanent profile title. That's the loop's payoff — the cards aren't just a
// binder, they're a run at something you can wear.
export interface SetReward {
  set: string;
  ap: number;
  shards: number;
  title: string;   // shown on the profile once claimed
}
export const SET_REWARDS: Record<string, SetReward> = {
  Succour:   { set: "Succour",   ap: 2500, shards: 600, title: "Keeper of the Quiet Hand" },
  Ascension: { set: "Ascension", ap: 3000, shards: 500, title: "Archivist of Ascension" },
  Abyssal:   { set: "Abyssal",   ap: 3000, shards: 500, title: "Sounder of the Abyss" },
  Ronin:     { set: "Ronin",     ap: 3000, shards: 500, title: "Sword Without a Lord" },
  Genesis:   { set: "Genesis",   ap: 1000, shards: 200, title: "Keeper of Genesis" },
};

// Distinct card ids belonging to a set (for completion checks).
export function cardsInSet(set: string): string[] {
  return Object.values(CARDS).filter((c) => c.set === set).map((c) => c.id);
}
