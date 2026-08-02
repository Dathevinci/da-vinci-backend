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
  card_voidgaze:   { id: "card_voidgaze",   name: "What Watches Below", rarity: "epic", set: "Ascension", hue: 185, motif: "eye", flavor: "Look long enough and it blinks back." },
  card_ninehands:  { id: "card_ninehands",  name: "Nine-Handed Wheel",  rarity: "epic", set: "Ascension", hue: 42,  motif: "wheel", flavor: "It has adapted to this before." },
  card_crimsonsea: { id: "card_crimsonsea", name: "The Last Crossing",  rarity: "epic", set: "Ascension", hue: 350, motif: "sea", flavor: "Everyone crosses once. Nobody has described the far bank." },
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
  card_onimask:     { id: "card_onimask",     name: "The Hundred Masks",   rarity: "epic", set: "Ronin", hue: 352, motif: "mask", flavor: "He wore one to frighten bandits. The other ninety-nine came on their own." },

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

  // ── More Succour: support you collect, one use per duel each ──
  card_lastlight:  { id: "card_lastlight",  name: "Last Light",       rarity: "common", set: "Succour", hue: 52,  motif: "dawn",   flavor: "Enough to see by. Not enough to rest.", support: { kind: "heal", power: 15 } },
  card_emberward:  { id: "card_emberward",  name: "Ember Ward",       rarity: "common", set: "Succour", hue: 20,  motif: "ember",  flavor: "Hold the coal. It will hold you back.", support: { kind: "shield" } },
  card_tidecall:   { id: "card_tidecall",   name: "Tidecall",         rarity: "rare",   set: "Succour", hue: 188, motif: "sea",    flavor: "The water remembers everyone who stood in it.", support: { kind: "mend", power: 8 } },
  card_ironvow:    { id: "card_ironvow",    name: "Iron Vow",         rarity: "epic",   set: "Succour", hue: 215, motif: "seal",   flavor: "Spoken once, and the next blow simply declines to land.", support: { kind: "block" } },
  card_gravebloom: { id: "card_gravebloom", name: "Gravebloom",       rarity: "epic",   set: "Succour", hue: 305, motif: "lotus",  flavor: "It only grows where something ended.", support: { kind: "revive", power: 35 } },

  // ── More Abyssal ──
  card_drownbell:  { id: "card_drownbell",  name: "The Drowned Bell", rarity: "common", set: "Abyssal", hue: 198, motif: "bell",   flavor: "It still rings. Nobody agrees on what for." },
  card_shallowpact:{ id: "card_shallowpact",name: "The Shallow Pact",  rarity: "common", set: "Abyssal", hue: 176, motif: "seal",   flavor: "Signed in the tide line, where nothing stays written." },
  card_undertow:   { id: "card_undertow",   name: "The Undertow",     rarity: "rare",   set: "Abyssal", hue: 205, motif: "ripple", flavor: "Pulls politely, at first." },
  card_blackreach: { id: "card_blackreach", name: "Blackreach",       rarity: "epic",   set: "Abyssal", hue: 232, motif: "trench", flavor: "Down where pressure does the arguing." },
  card_hollowtide: { id: "card_hollowtide", name: "Hollow Tide",      rarity: "legendary", set: "Abyssal", hue: 190, motif: "leviathan", flavor: "The sea exhaled once, and a coastline stopped existing." },

  // ── More Ronin ──
  card_ashblade:   { id: "card_ashblade",   name: "Ashblade",         rarity: "common", set: "Ronin",   hue: 14,  motif: "blade",  flavor: "Sharpened on the way out of a burning house." },
  card_lanternoath:{ id: "card_lanternoath",name: "Lantern Oath",     rarity: "common", set: "Ronin",   hue: 42,  motif: "ember",  flavor: "A promise you can carry in one hand." },
  card_thousandcut:{ id: "card_thousandcut",name: "Thousand Cuts",    rarity: "rare",   set: "Ronin",   hue: 348, motif: "web",    flavor: "None of them decisive. All of them counted." },
  card_lastretainer:{id: "card_lastretainer",name:"The Last Retainer", rarity: "epic",   set: "Ronin",   hue: 355, motif: "path",   flavor: "Still standing at a gate whose house is gone." },
  card_swordsaint: { id: "card_swordsaint",  name: "The Sword Saint",  rarity: "legendary", set: "Ronin", hue: 8,  motif: "storm",  flavor: "Drew once, at dawn. The duel had ended by breakfast." },

  // ── Vigil: the long watch ──
  card_nightporter:{ id: "card_nightporter",name: "Night Porter",     rarity: "common", set: "Vigil",   hue: 250, motif: "path",   flavor: "Somebody has to keep the road open until morning." },
  card_thinhour:   { id: "card_thinhour",   name: "The Thin Hour",    rarity: "common", set: "Vigil",   hue: 268, motif: "moth",   flavor: "Three in the morning, where most resolve is lost." },
  card_paleorbit:  { id: "card_paleorbit",  name: "Pale Orbit",       rarity: "common", set: "Vigil",   hue: 222, motif: "wheel",  flavor: "It has gone around longer than anyone watching." },
  card_sleeplessone:{id: "card_sleeplessone",name:"The Sleepless One", rarity: "rare",   set: "Vigil",   hue: 288, motif: "eye",    flavor: "Blinks on a schedule of its own choosing." },
  card_coldvigil:  { id: "card_coldvigil",  name: "Cold Vigil",       rarity: "rare",   set: "Vigil",   hue: 200, motif: "peak",   flavor: "Waiting, at altitude, without complaint." },
  card_lampofhours:{ id: "card_lampofhours",name: "Lamp of Hours",    rarity: "epic",   set: "Vigil",   hue: 46,  motif: "seed",   flavor: "Burns down exactly as fast as it is needed." },
  card_longmorrow: { id: "card_longmorrow",  name: "The Long Morrow",  rarity: "legendary", set: "Vigil", hue: 275, motif: "comet", flavor: "It arrives. It has always been going to arrive." },

  // ═══ SET · REQUIEM — seven legendaries and nothing else ═══════════════════
  // A set with no commons to pad it: every card in it is a chase. Kept as its
  // own set so adding seven legendaries doesn't quietly make the existing
  // sets impossible to finish for anyone mid-collection.
  card_blacksun:    { id: "card_blacksun",    name: "The Sun That Bleeds",     rarity: "legendary", set: "Requiem", hue: 350, motif: "dawn",  flavor: "It rose black over the cathedral, and what it shed was not light." },
  card_crowfeast:   { id: "card_crowfeast",   name: "What the Crows Keep",     rarity: "legendary", set: "Requiem", hue: 35,  motif: "path",  flavor: "They circle nothing. They are very patient about it." },
  card_redmoon:     { id: "card_redmoon",     name: "The Rite of the Red Moon", rarity: "legendary", set: "Requiem", hue: 355, motif: "bell",  flavor: "The steps are bone because everyone who climbed them stayed." },
  card_palepilgrim: { id: "card_palepilgrim", name: "The Pale Pilgrim",        rarity: "legendary", set: "Requiem", hue: 200, motif: "peak",  flavor: "Winter follows at a respectful distance, in chains." },
  card_monarch:     { id: "card_monarch",     name: "The Sword That Remembers", rarity: "legendary", set: "Requiem", hue: 210, motif: "blade", flavor: "Every hand that ever held it is still holding it." },
  card_grin:        { id: "card_grin",        name: "The Grin in the Dark",    rarity: "legendary", set: "Requiem", hue: 280, motif: "mask",  flavor: "You do not find it. It notices you." },
  card_drownedgate: { id: "card_drownedgate", name: "The Drowned Gate",        rarity: "legendary", set: "Requiem", hue: 220, motif: "gate",  flavor: "The shrine went under mid-prayer, and the water finished it." },

  // ── Requiem, second movement — seven more chases, same rules ──
  card_awakening:   { id: "card_awakening",   name: "What Woke Up",            rarity: "legendary", set: "Requiem", hue: 225, motif: "dawn",  flavor: "The lightning did not strike him. It answered." },
  card_shattered:   { id: "card_shattered",   name: "The Shattered Oath",      rarity: "legendary", set: "Requiem", hue: 275, motif: "blade", flavor: "Every promise breaks the same way: all at once." },
  card_unchained:   { id: "card_unchained",   name: "The Unchained",           rarity: "legendary", set: "Requiem", hue: 330, motif: "path",  flavor: "They measured the shackles for someone who agreed to wear them." },
  card_vessel:      { id: "card_vessel",      name: "The Willing Vessel",      rarity: "legendary", set: "Requiem", hue: 0,   motif: "mask",  flavor: "It knocked. He answered. Neither will say who invited whom." },
  card_wheel:       { id: "card_wheel",       name: "The Turning Wheel",       rarity: "legendary", set: "Requiem", hue: 12,  motif: "seal",  flavor: "Whatever you bring, bring it once. It learns." },
  card_ashgarden:   { id: "card_ashgarden",   name: "The Ash Garden",          rarity: "legendary", set: "Requiem", hue: 30,  motif: "ember", flavor: "The shrine burned for three days. He tended nothing else." },
  card_floodwalker: { id: "card_floodwalker", name: "He Who Walks the Flood",  rarity: "legendary", set: "Requiem", hue: 358, motif: "sea",   flavor: "The tide came in red, and did not go out again." },

  // ── Event (limited; NOT in normal packs) ──
  card_founder:    { id: "card_founder",    name: "The Founder's Seal", rarity: "event", set: "Genesis", hue: 290, motif: "seal", flavor: "Given to those who were here at the beginning." },
};

// Normal packs can roll everything EXCEPT event cards.
const PACK_POOL = Object.values(CARDS).filter((c) => c.rarity !== "event");

export const PACK_PRICE = 250;   // AP — reachable even for sub-500 balances
export const PACK_SIZE = 4;

// Per-card rarity roll for a normal pack. Weighted so a pack usually feels like
// commons + a rare, with epics/legendaries as the chase.
/**
 * Pull odds. Legendary dropped from 2% to 1% per card.
 *
 * The squeeze is bigger than that number looks, because it compounds with the
 * pool: the legendary tier went from 5 cards to 8, so the chance of any ONE
 * named legendary fell from 0.4% to 0.125% per card — roughly a third of what
 * it was. A four-card pack now carries about a 4% chance of a legendary at all.
 *
 * Crafting is the deliberate escape hatch. Odds this long without a
 * deterministic path just punish unlucky players indefinitely.
 */
/**
 * Legendary squeezed again: 1% → 0.6% per card. The tier just went from 8
 * cards to 15, so without this the chance of pulling SOME legendary would
 * have stayed flat while each named one halved — the owner asked for the
 * whole tier to get harder, not merely more diluted. At 0.6% a four-card
 * pack carries ~2.4% odds of any legendary; craft stays the escape hatch.
 * Weights are floats now — the roll multiplies Math.random() by the sum, so
 * nothing anywhere assumes integers.
 */
const RARITY_WEIGHTS: Record<Exclude<CardRarity, "event">, number> = {
  common: 64,
  rare: 27.4,
  epic: 8,
  legendary: 0.6,
};

// Dust value (shards you get for one duplicate) and craft cost (shards to make a
// chosen card). Craft costs MORE than dust returns at the same rarity — recycling
// is a grind, not an exploit, so you can't dust-and-craft your way to profit.
export const DUST_VALUE: Record<CardRarity, number> = {
  common: 5, rare: 15, epic: 40, legendary: 120, event: 0, // event cards can't be dusted
};
export const CRAFT_COST: Record<CardRarity, number> = {
  // Legendary 1000 → 1500 alongside the pull-rate squeeze: the deterministic
  // path gets longer in step with the lucky one, or crafting becomes the
  // obvious bypass and the squeeze does nothing.
  common: 40, rare: 120, epic: 340, legendary: 1500, event: 0, // event can't be crafted
};

/**
 * PULL SIZES. A single is priced slightly above the per-card rate and the
 * bigger pulls slightly below, so buying in bulk is the better deal without
 * making a single pull feel like a punishment for being short on points.
 *
 * The list is closed on purpose: the size AND the price are both read from
 * here rather than from the request, so a hand-rolled call can't ask for a
 * hundred cards or name its own price.
 */
export const PULL_SIZES = [1, 3, PACK_SIZE];
export const PULL_PRICES: Record<number, number> = {
  1: 70,
  3: 195,
  [PACK_SIZE]: PACK_PRICE,
};

/**
 * CARD LEVELS — shard-bought power.
 *
 * Levels exist so shards keep mattering after you own everything, and so a
 * common you actually invested in can outfight a legendary nobody touched.
 * +7% per level compounds to roughly +80% at cap, which is enough to matter
 * without making an un-levelled card unplayable.
 */
export const MAX_CARD_LEVEL = 10;
export const LEVEL_STEP = 0.07;

/** Multiplier applied to a card's base ATK and HP. Level 1 is exactly base. */
export function levelMult(level: number): number {
  const l = Math.max(1, Math.min(MAX_CARD_LEVEL, Math.floor(level || 1)));
  return 1 + (l - 1) * LEVEL_STEP;
}

/**
 * Shards to go from `level` to `level + 1`. Rarer cards cost more per step and
 * every step costs more than the last, so levelling a legendary to cap is a
 * genuine project rather than an afternoon of dusting.
 */
export function upgradeCost(rarity: CardRarity, level: number): number {
  const base: Record<CardRarity, number> = {
    common: 30, rare: 70, epic: 160, legendary: 380, event: 300,
  };
  const l = Math.max(1, Math.floor(level || 1));
  return Math.round((base[rarity] ?? 30) * Math.pow(1.35, l - 1));
}

/**
 * Waking a hibernating card. Deliberately well under CRAFT_COST: the card is
 * already yours, so this is a fee for losing with it, not a second purchase.
 * Pulling another copy from a pack wakes it for free, which keeps packs
 * relevant to veterans who already own most of the set.
 */
export const WAKE_COST: Record<CardRarity, number> = {
  common: 15, rare: 45, epic: 120, legendary: 340, event: 200,
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
// The chase slot is WEIGHTED, not uniform over cards. Uniform was fine when
// legendaries were 8 cards against 13 epics (~38%), but at 15 legendaries a
// uniform pick would have made the guaranteed slot MORE likely to be
// legendary than epic — growing the tier would have made it easier to hit,
// the exact opposite of the squeeze everywhere else.
export function rollRelicPack(size = PACK_SIZE): string[] {
  const rarity = Math.random() < 0.2 ? "legendary" : "epic";
  const pool = PACK_POOL.filter((c) => c.rarity === rarity);
  const guaranteed = pool[Math.floor(Math.random() * pool.length)].id;
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
  Vigil:     { set: "Vigil",     ap: 3200, shards: 550, title: "Keeper of the Long Watch" },
  Genesis:   { set: "Genesis",   ap: 1000, shards: 200, title: "Keeper of Genesis" },
  // Seven legendaries, no padding — completing this is the longest chase in
  // the game, and the payout is sized like it.
  Requiem:   { set: "Requiem",   ap: 8000, shards: 1500, title: "The Requiem Made Whole" },
};

// Distinct card ids belonging to a set (for completion checks).
export function cardsInSet(set: string): string[] {
  return Object.values(CARDS).filter((c) => c.set === set).map((c) => c.id);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * LEGENDARY SKILLS
 *
 * Only legendaries carry one. That is the point: a skill is the reason a
 * legendary is worth chasing beyond a bigger stat line, and giving every card
 * one would make the word meaningless.
 *
 * Skills level SEPARATELY from the card, on their own shard track. A card
 * level raises ATK and HP; a skill level raises the one thing that card
 * uniquely does. Keeping the two apart means a player can choose what to sink
 * shards into rather than having the decision made for them.
 *
 * Keyed by card id, never by name — the names above are editable copy and
 * have already been rewritten once.
 * ═══════════════════════════════════════════════════════════════════════════ */

export type SkillKind =
  | "burst" | "drain" | "guard" | "rally" | "execute"
  | "pierce" | "cleave" | "venom" | "stagger" | "bulwark" | "mendself" | "sap" | "empower";

export interface SkillDef {
  name: string;
  kind: SkillKind;
  /** Effect strength at skill level 1, as a percent. */
  base: number;
  /** Added to `base` per level beyond the first. */
  step: number;
  /** One line, written so the number reads as the subject. */
  text: (power: number) => string;
}

export const MAX_SKILL_LEVEL = 5;

export const SKILLS: Record<string, SkillDef> = {
  // EPIC ONLY — legendaries carry a DOMAIN instead.
  //
  // THIRTEEN CARDS, THIRTEEN VERBS. The first pass gave four of these "guard"
  // and three of them "rally", so half the tier was the same move at a
  // different number and picking between them was picking a colour. Every one
  // below now does something no other card in the game does.
  card_voidgaze: {
    name: "Seen Through", kind: "pierce", base: 105, step: 15,
    text: (p) => `Deal ${p}% ATK that ignores wards, guards and shields entirely.`,
  },
  card_ninehands: {
    name: "Nine Hands", kind: "cleave", base: 85, step: 13,
    text: (p) => `Deal ${p}% ATK to the card opposite AND half that to the next one behind it.`,
  },
  card_crimsonsea: {
    name: "The Far Bank", kind: "venom", base: 8, step: 2,
    text: (p) => `The card opposite loses ${p}% of its max health at the end of each of your turns.`,
  },
  card_unblinking: {
    name: "It Noticed You", kind: "execute", base: 20, step: 4,
    text: (p) => `Finish any card already below ${p}% health outright.`,
  },
  card_fallenstar: {
    name: "Long Fall", kind: "burst", base: 130, step: 20,
    text: (p) => `Deal ${p}% ATK to whoever is standing opposite.`,
  },
  card_trenchmaw: {
    name: "Swallow Whole", kind: "drain", base: 100, step: 16,
    text: (p) => `Deal ${p}% ATK and take back half of it as health.`,
  },
  card_onimask: {
    name: "Ninety-Nine Faces", kind: "stagger", base: 50, step: 10,
    text: (p) => `The other side's next attack lands ${p}% weaker.`,
  },
  card_blackreach: {
    name: "No Bottom", kind: "guard", base: 20, step: 4,
    text: (p) => `Shed ${p}% of every blow for the rest of the duel.`,
  },
  card_lastretainer: {
    name: "Hold the Gate", kind: "bulwark", base: 1, step: 1,
    text: (p) => `The next ${p} attack${p === 1 ? "" : "s"} against you do not land at all.`,
  },
  card_lampofhours: {
    name: "Burn as Needed", kind: "mendself", base: 45, step: 12,
    text: (p) => `This card alone recovers ${p}% of its max health.`,
  },
  card_communion: {
    name: "Nobody Says Why", kind: "rally", base: 22, step: 5,
    text: (p) => `Restore ${p}% of max health to your whole line.`,
  },
  card_ironvow: {
    name: "Spoken Once", kind: "sap", base: 20, step: 5,
    text: (p) => `The other side hits ${p}% weaker for the rest of the duel.`,
  },
  card_gravebloom: {
    name: "Where Something Ended", kind: "empower", base: 25, step: 8,
    text: (p) => `This card's attack rises ${p}% permanently. It keeps it if it falls and returns.`,
  },
};

export function skillFor(cardId: string): SkillDef | null {
  return SKILLS[cardId] ?? null;
}

/** The skill's number at a given level. Level 1 is exactly `base`. */
export function skillPower(def: SkillDef, level: number): number {
  const l = Math.max(1, Math.min(MAX_SKILL_LEVEL, Math.floor(level || 1)));
  return def.base + (l - 1) * def.step;
}

/**
 * Shards to take a skill from `level` to `level + 1`.
 *
 * Priced by RARITY, not flat. An epic skill is the common case — thirteen
 * cards carry one — so charging legendary rates would make the whole tier
 * ornamental. A legendary skill stays expensive because there are eight of
 * them and a mastered one should be something other players notice.
 *
 * Still steeper per step than upgradeCost() at both tiers, and capped five
 * levels lower, so a skill is a project rather than an afternoon of dusting.
 */
export function skillUpgradeCost(level: number, rarity: CardRarity = "legendary"): number {
  const base: Partial<Record<CardRarity, number>> = { epic: 200, legendary: 500 };
  const l = Math.max(1, Math.floor(level || 1));
  return Math.round((base[rarity] ?? 200) * Math.pow(1.6, l - 1));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * DOMAIN EXPANSIONS — legendaries only.
 *
 * A skill does a thing. A domain changes the terms of the fight, and it is
 * the reason a legendary is a different KIND of card rather than an epic with
 * bigger numbers — which is exactly what went wrong the first time, when both
 * tiers drew from the same five verbs and a legendary just executed at a
 * higher threshold than an epic did.
 *
 * So the kinds below are DISJOINT from SkillKind. No overlap, on purpose.
 * Nothing here is a percentage of ATK; every one of them rewrites a rule.
 *
 * One per duel, and unmissable when it lands.
 * ═══════════════════════════════════════════════════════════════════════════ */

export type DomainKind =
  | "revival"       // your fallen cards stand back up
  | "massacre"      // strikes the WHOLE enemy line at once
  | "nullify"       // nothing reaches you for a span
  | "siphon"        // drains the whole enemy line into your own
  | "ascend"        // your line keeps the power, permanently
  | "judgement"     // fells the weakest thing standing, no roll
  | "seal"          // the other side loses its supports
  | "inevitability" // a doom that lands later no matter what happens
  | "eclipse"       // the enemy's next attacks land weakened
  | "carrion"       // feeds on every fallen card on the board
  | "bloodmoon"     // the enemy's active card bleeds, and keeps bleeding
  | "chains"        // the enemy simply cannot attack for a span
  | "monarch"       // your fallen lend their strength to the living
  | "terror"        // the thing standing opposite loses its nerve, and its health
  | "abyss"         // for a span, damage dealt to you comes back on the dealer
  | "tempest"       // three strikes in one breath on whoever stands opposite
  | "shatter"       // breaks every protection the other side holds, then hits
  | "unchained"     // sheds every affliction on your side; the links lash back
  | "vessel"        // takes a piece of the enemy's strength, permanently
  | "adapt"         // lasting guard — your side sheds part of every blow
  | "wildfire"      // burns the whole enemy line, and the fire stays
  | "floodtide";    // drowns the card opposite and feeds your whole line

export interface DomainDef {
  name: string;
  kind: DomainKind;
  base: number;
  step: number;
  text: (power: number) => string;
}

export const MAX_DOMAIN_LEVEL = 3;

export const DOMAINS: Record<string, DomainDef> = {
  card_gatekey: {
    name: "The Door Stands Open", kind: "revival", base: 40, step: 20,
    text: (p) => `Every card you have lost stands back up at ${p}% health.`,
  },
  card_outergod: {
    name: "The Indifferent Vast", kind: "massacre", base: 70, step: 25,
    text: (p) => `Strike every card the other side has for ${p}% ATK at once.`,
  },
  card_leviathan: {
    name: "It Has Not Woken", kind: "nullify", base: 2, step: 1,
    text: (p) => `Nothing reaches you at all for ${p} turn${p === 1 ? "" : "s"}.`,
  },
  card_hollowtide: {
    name: "The Coastline Ends", kind: "siphon", base: 35, step: 15,
    text: (p) => `Take ${p}% of the health of every enemy card and keep it.`,
  },
  card_lastronin: {
    name: "No Lord To Serve", kind: "ascend", base: 30, step: 12,
    text: (p) => `Your whole line gains ${p}% ATK for the rest of the duel.`,
  },
  card_swordsaint: {
    name: "Ended By Breakfast", kind: "judgement", base: 1, step: 1,
    text: (p) => `Fell the ${p} weakest card${p === 1 ? "" : "s"} still standing. No roll.`,
  },
  card_secondwind: {
    name: "Only The Resting", kind: "seal", base: 2, step: 1,
    text: (p) => `The other side cannot play a support for ${p} turn${p === 1 ? "" : "s"}.`,
  },
  card_longmorrow: {
    name: "It Has Always Been Coming", kind: "inevitability", base: 200, step: 80,
    text: (p) => `In three turns, ${p}% ATK lands on whoever is standing. Nothing stops it.`,
  },

  // ── The Requiem seven ──
  card_blacksun: {
    name: "The Sun Goes Out", kind: "eclipse", base: 30, step: 10,
    text: (p) => `The enemy's next three attacks land ${p}% weaker. They swing in the dark.`,
  },
  card_crowfeast: {
    name: "The Field Is Theirs", kind: "carrion", base: 40, step: 15,
    text: (p) => `${p}% ATK for every fallen card on the board, dealt to whoever stands opposite — and eaten as healing.`,
  },
  card_redmoon: {
    name: "The Moon Drinks", kind: "bloodmoon", base: 8, step: 3,
    text: (p) => `The card opposite bleeds ${p}% of its health every turn. It does not stop.`,
  },
  card_palepilgrim: {
    name: "The Long Chain", kind: "chains", base: 1, step: 1,
    text: (p) => `The other side cannot attack for ${p} turn${p === 1 ? "" : "s"}. The chain holds.`,
  },
  card_monarch: {
    name: "The Dead March Behind", kind: "monarch", base: 12, step: 6,
    text: (p) => `+${p}% ATK for every one of your fallen cards, kept for the rest of the duel.`,
  },
  card_grin: {
    name: "It Smiles Back", kind: "terror", base: 35, step: 15,
    text: (p) => `The card opposite loses ${p}% of its CURRENT health. No roll, no guard.`,
  },
  card_drownedgate: {
    name: "The Water Remembers", kind: "abyss", base: 2, step: 1,
    text: (p) => `For the enemy's next ${p} attack${p === 1 ? "" : "s"}, half of what they deal comes straight back on them.`,
  },

  // ── The second movement ──
  card_awakening: {
    name: "The Hour It Woke", kind: "tempest", base: 40, step: 12,
    text: (p) => `Three strikes in one breath, each at ${p}% ATK, on whoever stands opposite.`,
  },
  card_shattered: {
    name: "Everything Breaks", kind: "shatter", base: 60, step: 20,
    text: (p) => `Shatter every ward, block and bulwark the other side holds — then strike for ${p}% ATK.`,
  },
  card_unchained: {
    name: "The Chains Come Off", kind: "unchained", base: 70, step: 25,
    text: (p) => `Shed every bleed, chain, seal and doom on your side. The broken links lash for ${p}% ATK.`,
  },
  card_vessel: {
    name: "Make Room", kind: "vessel", base: 25, step: 10,
    text: (p) => `Take ${p}% of the enemy active card's ATK. Yours now, permanently.`,
  },
  card_wheel: {
    name: "It Adapts", kind: "adapt", base: 15, step: 7,
    text: (p) => `Your side sheds ${p}% of every incoming blow for the rest of the duel.`,
  },
  card_ashgarden: {
    name: "The Garden Alight", kind: "wildfire", base: 30, step: 10,
    text: (p) => `Every enemy card burns for ${p}% ATK at once — and the one standing keeps burning.`,
  },
  card_floodwalker: {
    name: "The Tide Comes In", kind: "floodtide", base: 65, step: 20,
    text: (p) => `The flood takes ${p}% ATK from the card opposite and feeds every card you have.`,
  },
};

export function domainFor(cardId: string): DomainDef | null {
  return DOMAINS[cardId] ?? null;
}

export function domainPower(def: DomainDef, level: number): number {
  const l = Math.max(1, Math.min(MAX_DOMAIN_LEVEL, Math.floor(level || 1)));
  return def.base + (l - 1) * def.step;
}

/**
 * Domains cap at three ranks rather than five, and each one costs more than a
 * maxed epic skill. Fifteen cards in the game have one; it should read as a
 * different order of investment, not a longer version of the same one.
 */
export function domainUpgradeCost(level: number): number {
  const l = Math.max(1, Math.floor(level || 1));
  return Math.round(1200 * Math.pow(1.8, l - 1));
}

/**
 * The one ability a card has, whichever kind it is. Every caller wants this
 * rather than the two maps — a card can never carry both, so branching on
 * rarity at each call site would be the same check written eight times.
 */
export function abilityFor(cardId: string):
  | { type: "domain"; def: DomainDef; max: number }
  | { type: "skill"; def: SkillDef; max: number }
  | null {
  const d = DOMAINS[cardId];
  if (d) return { type: "domain", def: d, max: MAX_DOMAIN_LEVEL };
  const s = SKILLS[cardId];
  if (s) return { type: "skill", def: s, max: MAX_SKILL_LEVEL };
  return null;
}
