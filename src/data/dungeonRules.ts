import { CARDS, levelMult } from "./cardCatalog";
import { CARD_STATS, FOIL_MULT } from "./duelRules";

/**
 * DUNGEON DISPATCH — the second game mode.
 *
 * The player picks a party and SENDS it in; the dungeon plays itself. All of
 * that playing happens HERE, on the server, one floor per request — the
 * client renders events it is handed and can never invent an outcome. This
 * is the same authority rule the duels engine lives by.
 *
 * Design pillars, chosen once and enforced everywhere:
 *  · HP does not reset between floors OR between runs — attrition is the
 *    game. A unit comes home hurt, it stays hurt until healed in the lobby.
 *  · Every 5th floor is a boss. Deeper floors pay more and kill more.
 *  · A wipe loses everything not banked. Recall banks between floors.
 *  · Death is NOT deletion — a dead card can be revived for Arise Points.
 *    Nothing on this platform is ever destroyed, but death must cost enough
 *    that dispatching legendaries into floor 30 isn't free money.
 *  · Injury: come home under 40% health and the unit is INJURED — it fights
 *    at 70% of its max HP until healed. The tension the spec asked for.
 */

export const PARTY_MAX = 4;
export const INJURY_THRESHOLD = 0.4;  // hp under this fraction of max on return
export const INJURY_MAX_HP_MULT = 0.7;
export const HEAL_COST_AP = 80;       // per card: full HP + injury cleared
export const REVIVE_COST_AP = 500;    // per card: back from the dead at half HP
export const MAX_FLOOR_ROUNDS = 40;   // a fight that stalls this long is a stand-off; treat as cleared

export interface DungeonDef {
  id: string;
  name: string;
  depth: number;      // clearing this floor completes the dungeon
  recPower: number;   // shown in the lobby: sum of party atk+hp that fights comfortably
  flavor: string;
  hpMul: number;      // enemy scaling knobs per dungeon
  atkMul: number;
  apMul: number;      // reward scaling
}

export const DUNGEONS: Record<string, DungeonDef> = {
  dgn_cellars: {
    id: "dgn_cellars", name: "The Mildew Cellars", depth: 10, recPower: 90,
    flavor: "Something is growing under the atelier. It has opinions.",
    hpMul: 0.85, atkMul: 0.85, apMul: 0.8,
  },
  dgn_orchard: {
    id: "dgn_orchard", name: "The Bone Orchard", depth: 20, recPower: 180,
    flavor: "The trees fruit once a century. It is not fruit.",
    hpMul: 1.0, atkMul: 1.0, apMul: 1.0,
  },
  dgn_keep: {
    id: "dgn_keep", name: "The Sunless Keep", depth: 30, recPower: 280,
    flavor: "The lights went out on purpose. The garrison never left.",
    hpMul: 1.22, atkMul: 1.18, apMul: 1.4,
  },
};

/** A party member inside a run. Stats mirror the duel formulas exactly —
 *  a card must not fight harder in one mode than the other. */
export interface DgnUnit {
  cardId: string;
  name: string;
  rarity: string;
  maxHp: number;   // effective max for THIS run (injury already applied)
  hp: number;
  atk: number;
  foil: boolean;
}

export interface DgnEnemy {
  name: string;
  hp: number;
  maxHp: number;
  atk: number;
  kind: number;      // sprite index for the client, 0..5
  boss?: boolean;
}

/** One floor's worth of things-that-happened, in order. The client animates
 *  these verbatim; nothing in them is advisory. */
export type FloorEvent =
  | { k: "spawn"; enemies: DgnEnemy[] }
  | { k: "phit"; i: number; e: number; dmg: number; crit?: 1 }
  | { k: "ekill"; e: number }
  | { k: "ehit"; e: number; i: number; dmg: number }
  | { k: "fall"; i: number }
  | { k: "clear"; ap: number; shards: number }
  | { k: "wipe" };

export interface DungeonState {
  dungeon: string;
  floor: number;          // floors CLEARED so far; the next attempt is floor+1
  party: DgnUnit[];
  apEarned: number;       // unbanked
  shardsEarned: number;   // unbanked
}

const ENEMY_NAMES = [
  ["Cellar Mite", "Damp Shambler", "Mildew Knot", "Wall Weeper"],
  ["Orchard Wight", "Bone Picker", "Marrow Wasp", "Grave Tender"],
  ["Keep Sentinel", "Dark Lancer", "Vault Horror", "Sunless Monk"],
];
const BOSS_NAMES = [
  "The Cellar King", "What Tends the Orchard", "Warden of the Sunless",
];

function dungeonTier(id: string): number {
  return id === "dgn_keep" ? 2 : id === "dgn_orchard" ? 1 : 0;
}

/** Duel-identical stat build: rarity base × foil 1.2 × level curve, then the
 *  injury penalty on max HP, then the carried-over current HP clamped in. */
export function makeUnit(
  cardId: string,
  level: number,
  foil: boolean,
  carriedHp: number | null,
  injured: boolean
): DgnUnit | null {
  const def = CARDS[cardId];
  if (!def || def.support) return null; // supports don't raid, same as duels
  const base = CARD_STATS[def.rarity];
  // EXACTLY the duel formula — shared levelMult (with its level-10 clamp)
  // and shared foil multiplier. A card must not fight harder in one mode.
  const mult = (foil ? FOIL_MULT : 1) * levelMult(level);
  const fullMax = Math.round(base.hp * mult);
  const maxHp = injured ? Math.max(1, Math.round(fullMax * INJURY_MAX_HP_MULT)) : fullMax;
  const hp = carriedHp === null ? maxHp : Math.max(1, Math.min(carriedHp, maxHp));
  return {
    cardId,
    name: def.name,
    rarity: def.rarity,
    maxHp,
    hp,
    atk: Math.round(base.atk * mult),
    foil,
  };
}

/** The lobby's honesty number, shared with the client for its estimate. */
export function partyPower(party: DgnUnit[]): number {
  return party.reduce((n, u) => n + u.atk + u.maxHp, 0);
}

/**
 * Resolve ONE floor. Mutates state.party HP and state.apEarned/shardsEarned
 * (on a clear), advances state.floor, and returns the event reel.
 *
 * Balance shape: an on-power party clears its dungeon's early floors nearly
 * untouched, starts bleeding around the middle, and faces real death odds at
 * the boss depths. The 40-round cap can't be farmed — a stand-off pays the
 * floor but the enemies got their swings in the whole time.
 */
export function simulateFloor(state: DungeonState, rng: () => number = Math.random): {
  events: FloorEvent[];
  cleared: boolean;
  wiped: boolean;
} {
  const def = DUNGEONS[state.dungeon];
  const floor = state.floor + 1;
  const tier = dungeonTier(state.dungeon);
  const boss = floor % 5 === 0;
  const events: FloorEvent[] = [];

  const count = boss ? 1 : Math.min(4, 2 + (floor > 6 ? 1 : 0) + (rng() < 0.35 ? 1 : 0));
  const names = ENEMY_NAMES[tier];
  const enemies: DgnEnemy[] = Array.from({ length: count }, (_, j) => {
    const hp = Math.round((14 + floor * 6) * def.hpMul * (boss ? 3.4 : 1) * (0.9 + rng() * 0.2));
    return {
      name: boss ? BOSS_NAMES[tier] : names[Math.floor(rng() * names.length)],
      hp,
      maxHp: hp,
      atk: Math.round((4 + floor * 1.6) * def.atkMul * (boss ? 1.9 : 1)),
      kind: boss ? 5 : (floor + j) % 5,
      boss: boss || undefined,
    };
  });
  events.push({ k: "spawn", enemies: enemies.map((e) => ({ ...e })) });

  let rounds = 0;
  while (rounds < MAX_FLOOR_ROUNDS) {
    rounds++;
    // party swings — always at the weakest thing standing, like a party would
    for (let i = 0; i < state.party.length; i++) {
      const u = state.party[i];
      if (u.hp <= 0) continue;
      const living = enemies.map((e, idx) => ({ e, idx })).filter((x) => x.e.hp > 0);
      if (living.length === 0) break;
      living.sort((a, b) => a.e.hp - b.e.hp);
      const target = living[0];
      const crit = rng() < 0.12;
      const dmg = Math.max(1, Math.round(u.atk * (0.8 + rng() * 0.45) * (crit ? 1.8 : 1)));
      target.e.hp = Math.max(0, target.e.hp - dmg);
      const hit: FloorEvent = crit
        ? { k: "phit", i, e: target.idx, dmg, crit: 1 }
        : { k: "phit", i, e: target.idx, dmg };
      events.push(hit);
      if (target.e.hp === 0) events.push({ k: "ekill", e: target.idx });
    }
    if (enemies.every((e) => e.hp <= 0)) break;

    // enemies swing back — at whoever, that's dungeons for you
    for (let e = 0; e < enemies.length; e++) {
      const en = enemies[e];
      if (en.hp <= 0) continue;
      const living = state.party.map((u, idx) => ({ u, idx })).filter((x) => x.u.hp > 0);
      if (living.length === 0) break;
      const target = living[Math.floor(rng() * living.length)];
      const dmg = Math.max(1, Math.round(en.atk * (0.8 + rng() * 0.4)));
      target.u.hp = Math.max(0, target.u.hp - dmg);
      events.push({ k: "ehit", e, i: target.idx, dmg });
      if (target.u.hp === 0) events.push({ k: "fall", i: target.idx });
    }
    if (state.party.every((u) => u.hp <= 0)) {
      events.push({ k: "wipe" });
      return { events, cleared: false, wiped: true };
    }
  }

  // floor cleared (or stood off past the cap, which pays the same but hurt)
  const ap = Math.round((12 + floor * 7) * def.apMul * (boss ? 3 : 1));
  const shards = boss ? 15 + floor : 0;
  state.apEarned += ap;
  state.shardsEarned += shards;
  state.floor = floor;
  events.push({ k: "clear", ap, shards });
  return { events, cleared: true, wiped: false };
}
