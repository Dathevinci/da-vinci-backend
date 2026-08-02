import { CARDS, levelMult, DOMAINS, domainPower, DomainDef } from "./cardCatalog";
import { CARD_STATS, FOIL_MULT } from "./duelRules";

/**
 * DUNGEON DISPATCH — the second game mode.
 *
 * The player picks a party and SENDS IT IN; the dungeon plays itself. All of
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
 *  · Injury: come home under 40% health and the unit fights at 70% of its
 *    max HP until healed. The tension the spec asked for.
 *  · LEGENDARIES EXPAND THEIR DOMAINS — automatically, because nobody is
 *    holding the controller. Once per run, at the card's trained rank, on
 *    the first boss floor or the moment the card first falls below 40%
 *    health, whichever the dungeon serves up first. One domain per round,
 *    so two legendaries firing together stay two MOMENTS.
 */

export const PARTY_MAX = 4;
export const INJURY_THRESHOLD = 0.4;  // hp under this fraction of max on return
export const INJURY_MAX_HP_MULT = 0.7;
export const HEAL_COST_AP = 80;       // per card: full HP + injury cleared

/**
 * Revival pricing — the spec's spine: rarity sets the base, and every death
 * a SPECIFIC card has already suffered makes its next one dearer. A ★4 on
 * its third death should genuinely hurt to bring back.
 */
export const REVIVE_BASE_AP: Record<string, number> = {
  common: 150, rare: 250, epic: 400, legendary: 700, event: 500,
};
export function reviveCost(rarity: string, priorDeaths: number): number {
  const base = REVIVE_BASE_AP[rarity] ?? 400;
  return Math.round(base * (1 + 0.5 * Math.max(0, priorDeaths)));
}
/** @deprecated flat price kept so older clients render SOMETHING sane. */
export const REVIVE_COST_AP = 500;
export const MAX_FLOOR_ROUNDS = 40;   // a fight that stalls this long is a stand-off; treat as cleared
export const DOMAIN_HP_TRIGGER = 0.4; // a legendary under this fraction expands in desperation

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
  /** Legendary domain, carried at the card's trained rank. Fired is
   *  persisted in run state: once per RUN, not once per floor. */
  domainKind?: string;
  domainName?: string;
  domainRank?: number;
  domainFired?: boolean;
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
  | { k: "domain"; i: number; name: string; text: string }
  | { k: "pheal"; i: number; amt: number }
  | { k: "note"; text: string }
  | { k: "clear"; ap: number; shards: number }
  | { k: "wipe" };

export interface DungeonState {
  dungeon: string;
  floor: number;          // floors CLEARED so far; the next attempt is floor+1
  party: DgnUnit[];
  apEarned: number;       // unbanked
  shardsEarned: number;   // unbanked
  /** Run-lasting domain gifts. Ascend/monarch feed the first, adapt the second. */
  atkBonusPct?: number;
  guardPct?: number;
  /**
   * THE PACK — up to three of the player's own SUPPORT CARDS, chosen at
   * dispatch. Same cards, same effects as the duel arena, one use each per
   * run — and the PLAYER plays them from topside, any time the run is
   * live. Nothing is consumed; a support card is knowledge, not a potion.
   */
  supports?: { id: string; used: boolean }[];
  /** Armed by the player between floors, spent by the next floor's opening. */
  pendingWard?: number;     // enemy volleys halved, this many
  pendingFocus?: boolean;   // party's opening volley boosted…
  focusPower?: number;      // …by this multiplier (the card's own power)
  pendingBlock?: boolean;   // the next enemy volley is negated outright
}

export const PACK_MAX = 3;

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
 *  injury penalty on max HP, then the carried-over current HP clamped in.
 *  A legendary also packs its domain at the trained rank. */
export function makeUnit(
  cardId: string,
  level: number,
  foil: boolean,
  carriedHp: number | null,
  injured: boolean,
  skillLevel = 1
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
  const dom: DomainDef | undefined = DOMAINS[cardId];
  return {
    cardId,
    name: def.name,
    rarity: def.rarity,
    maxHp,
    hp,
    atk: Math.round(base.atk * mult),
    foil,
    ...(dom ? {
      domainKind: dom.kind,
      domainName: dom.name,
      domainRank: Math.max(1, Math.floor(skillLevel || 1)),
      domainFired: false,
    } : {}),
  };
}

/** The lobby's honesty number, shared with the client for its estimate. */
export function partyPower(party: DgnUnit[]): number {
  return party.reduce((n, u) => n + u.atk + u.maxHp, 0);
}

/** Floor-local status effects a domain can leave behind. Reset every floor —
 *  run-lasting gifts live on DungeonState instead. */
interface FloorStatus {
  enemyAtkDownPct: number;    // eclipse / seal / shatter
  enemyAtkDownRounds: number; // 0 = rest of floor when pct > 0
  enemyFrozenRounds: number;  // chains
  partyImmuneRounds: number;  // nullify
  reflectRounds: number;      // abyss
  enemyBleedPct: number;      // bloodmoon / wildfire, % of current hp per round
  doomRounds: number;         // inevitability countdown; -1 = none
  doomPower: number;
}

/**
 * Resolve ONE floor. Mutates state (party HP, earnings, run-lasting buffs,
 * domainFired flags), advances state.floor, and returns the event reel.
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

  const st: FloorStatus = {
    enemyAtkDownPct: 0, enemyAtkDownRounds: 0, enemyFrozenRounds: 0,
    partyImmuneRounds: 0, reflectRounds: 0, enemyBleedPct: 0,
    doomRounds: -1, doomPower: 0,
  };

  // ── the player's played supports, armed between floors, land here ──
  let wardVolleys = 0;
  let focusVolley = false;
  let focusMult = 1.75;
  let blockVolley = false;
  if (state.pendingWard && state.pendingWard > 0) {
    wardVolleys = state.pendingWard;
    state.pendingWard = undefined;
    events.push({ k: "note", text: `> the ward settles over the party — the next ${wardVolleys} enemy volleys land HALVED.` });
  }
  if (state.pendingFocus) {
    focusVolley = true;
    focusMult = state.focusPower && state.focusPower > 1 ? state.focusPower : 1.75;
    state.pendingFocus = undefined;
    state.focusPower = undefined;
    events.push({ k: "note", text: `> the war cry carries down — the opening volley hits ${Math.round((focusMult - 1) * 100)}% HARDER.` });
  }
  if (state.pendingBlock) {
    blockVolley = true;
    state.pendingBlock = undefined;
    events.push({ k: "note", text: "> a bulwark stands with them — the first enemy volley will NOT land." });
  }

  const livingEnemies = () => enemies.map((e, idx) => ({ e, idx })).filter((x) => x.e.hp > 0);
  const strongest = () => livingEnemies().sort((a, b) => b.e.hp - a.e.hp)[0];
  const damageEnemy = (idx: number, dmg: number) => {
    const e = enemies[idx];
    const dealt = Math.min(e.hp, Math.max(0, dmg));
    e.hp = Math.max(0, e.hp - dmg);
    if (e.hp === 0 && dealt > 0) events.push({ k: "ekill", e: idx });
    return dealt;
  };
  const healUnit = (i: number, amt: number) => {
    const u = state.party[i];
    if (u.hp <= 0 || amt <= 0) return;
    const healed = Math.min(u.maxHp - u.hp, Math.round(amt));
    if (healed <= 0) return;
    u.hp += healed;
    events.push({ k: "pheal", i, amt: healed });
  };

  /**
   * The domain table, dungeon-shaped. Same names, same ranks, same soul as
   * the duel versions — retargeted at a corridor full of monsters. Each
   * returns the log line the client prints under the banner.
   */
  const expandDomain = (i: number): void => {
    const u = state.party[i];
    if (!u.domainKind || u.domainFired) return;
    u.domainFired = true;
    const dom = DOMAINS[u.cardId];
    if (!dom) return;
    const p = domainPower(dom, u.domainRank || 1);
    events.push({ k: "domain", i, name: dom.name, text: dom.text(p) });
    const k = u.domainKind;

    if (k === "revival") {
      let raised = 0;
      state.party.forEach((m, mi) => {
        if (m.hp <= 0) { m.hp = Math.max(1, Math.round((m.maxHp * p) / 100)); raised++; events.push({ k: "pheal", i: mi, amt: m.hp }); }
      });
      events.push({ k: "note", text: raised ? `> ${raised} fallen stood back up.` : "> the door opened on an empty room." });
    } else if (k === "massacre" || k === "shatter" || k === "wildfire") {
      const each = Math.max(1, Math.round(u.atk * (p / 100)));
      for (const { idx } of livingEnemies()) {
        events.push({ k: "phit", i, e: idx, dmg: each, crit: 1 });
        damageEnemy(idx, each);
      }
      if (k === "wildfire") {
        st.enemyBleedPct = Math.max(st.enemyBleedPct, 8);
        events.push({ k: "note", text: "> the fire stays. everything keeps burning." });
      }
      if (k === "shatter") {
        st.enemyAtkDownPct = Math.max(st.enemyAtkDownPct, 25);
        st.enemyAtkDownRounds = 0; // rest of floor
        events.push({ k: "note", text: "> their weapons crack — 25% weaker from here." });
      }
    } else if (k === "nullify") {
      st.partyImmuneRounds = Math.max(st.partyImmuneRounds, p);
      events.push({ k: "note", text: `> nothing will reach the party for ${p} round${p === 1 ? "" : "s"}.` });
    } else if (k === "siphon") {
      let taken = 0;
      for (const { e, idx } of livingEnemies()) {
        const t = Math.max(1, Math.round((e.hp * p) / 100));
        events.push({ k: "phit", i, e: idx, dmg: t });
        taken += damageEnemy(idx, t);
      }
      healUnit(i, taken);
    } else if (k === "ascend") {
      state.atkBonusPct = (state.atkBonusPct || 0) + p;
      events.push({ k: "note", text: `> the party strikes ${state.atkBonusPct}% harder for the rest of the run.` });
    } else if (k === "judgement") {
      const felled = livingEnemies().sort((a, b) => a.e.hp - b.e.hp).slice(0, Math.max(1, p));
      for (const { e, idx } of felled) {
        events.push({ k: "phit", i, e: idx, dmg: e.hp, crit: 1 });
        damageEnemy(idx, e.hp);
      }
      events.push({ k: "note", text: `> ${felled.length} fell where they stood. no roll.` });
    } else if (k === "seal") {
      st.enemyAtkDownPct = Math.max(st.enemyAtkDownPct, 50);
      st.enemyAtkDownRounds = p + 1;
      events.push({ k: "note", text: `> the enemy forgets how to fight for ${p + 1} rounds.` });
    } else if (k === "inevitability") {
      st.doomRounds = 3;
      st.doomPower = p;
      events.push({ k: "note", text: "> something is coming for all of them. three rounds." });
    } else if (k === "eclipse") {
      st.enemyAtkDownPct = Math.max(st.enemyAtkDownPct, p);
      st.enemyAtkDownRounds = 3;
      events.push({ k: "note", text: `> the light dies — enemy blows land ${p}% weaker.` });
    } else if (k === "carrion") {
      const fallenAll = state.party.filter((m) => m.hp <= 0).length + enemies.filter((e) => e.hp <= 0).length;
      const s = strongest();
      if (s && fallenAll > 0) {
        const feast = Math.max(1, Math.round(u.atk * (p / 100) * fallenAll));
        events.push({ k: "phit", i, e: s.idx, dmg: feast, crit: 1 });
        healUnit(i, damageEnemy(s.idx, feast));
      } else {
        events.push({ k: "note", text: "> the crows found nothing to carry." });
      }
    } else if (k === "bloodmoon") {
      st.enemyBleedPct = Math.max(st.enemyBleedPct, p);
      events.push({ k: "note", text: `> everything here bleeds ${p}% of itself, every round.` });
    } else if (k === "chains") {
      st.enemyFrozenRounds = Math.max(st.enemyFrozenRounds, p);
      events.push({ k: "note", text: `> chained. no enemy moves for ${p} round${p === 1 ? "" : "s"}.` });
    } else if (k === "monarch") {
      const fallenMine = state.party.filter((m) => m.hp <= 0).length;
      if (fallenMine > 0) {
        const gain = p * fallenMine;
        state.atkBonusPct = (state.atkBonusPct || 0) + gain;
        events.push({ k: "note", text: `> ${fallenMine} fallen answered — the party strikes ${gain}% harder, for good.` });
      } else {
        events.push({ k: "note", text: "> the dead did not answer. nobody has died." });
      }
    } else if (k === "terror") {
      const s = strongest();
      if (s) {
        const bite = Math.min(Math.max(0, s.e.hp - 1), Math.max(1, Math.round((s.e.hp * p) / 100)));
        events.push({ k: "phit", i, e: s.idx, dmg: bite, crit: 1 });
        damageEnemy(s.idx, bite);
        events.push({ k: "note", text: `> ${s.e.name} saw it smile.` });
      }
    } else if (k === "abyss") {
      st.reflectRounds = Math.max(st.reflectRounds, p);
      events.push({ k: "note", text: `> for ${p} round${p === 1 ? "" : "s"}, what lands comes straight back.` });
    } else if (k === "tempest") {
      const s = strongest();
      if (s) {
        const each = Math.max(1, Math.round(u.atk * (p / 100)));
        for (let n = 0; n < 3; n++) {
          const cur = strongest();
          if (!cur) break;
          events.push({ k: "phit", i, e: cur.idx, dmg: each, crit: 1 });
          damageEnemy(cur.idx, each);
        }
      }
    } else if (k === "unchained") {
      const s = strongest();
      if (s) {
        const lash = Math.max(1, Math.round(u.atk * (p / 100)));
        events.push({ k: "phit", i, e: s.idx, dmg: lash, crit: 1 });
        healUnit(i, damageEnemy(s.idx, lash));
      }
    } else if (k === "vessel") {
      const s = strongest();
      if (s) {
        const steal = Math.max(1, Math.round((s.e.atk * p) / 100));
        s.e.atk = Math.max(1, s.e.atk - steal);
        u.atk += steal; // persists for the whole run — it lives on the unit
        events.push({ k: "note", text: `> took ${steal} ATK out of ${s.e.name}'s hands. permanently.` });
      }
    } else if (k === "adapt") {
      state.guardPct = Math.min(50, (state.guardPct || 0) + p);
      events.push({ k: "note", text: `> the party adapts — ${state.guardPct}% of every blow shed, rest of the run.` });
    } else if (k === "floodtide") {
      const s = strongest();
      if (s) {
        const surge = Math.max(1, Math.round(u.atk * (p / 100)));
        events.push({ k: "phit", i, e: s.idx, dmg: surge, crit: 1 });
        const taken = damageEnemy(s.idx, surge);
        const living = state.party.map((m, mi) => ({ m, mi })).filter((x) => x.m.hp > 0);
        const share = Math.max(1, Math.round(taken / Math.max(1, living.length)));
        for (const { mi } of living) healUnit(mi, share);
      }
    }
  };

  let rounds = 0;
  while (rounds < MAX_FLOOR_ROUNDS) {
    rounds++;

    // ── domains first: desperation or a boss in the doorway. ONE per round,
    // so simultaneous legendaries stay separate moments.
    const candidate = state.party.findIndex((m) =>
      m.hp > 0 && m.domainKind && !m.domainFired &&
      (boss || m.hp < m.maxHp * DOMAIN_HP_TRIGGER)
    );
    if (candidate >= 0) expandDomain(candidate);
    if (enemies.every((e) => e.hp <= 0)) break;

    // ── the doom ticks, if one was promised
    if (st.doomRounds > 0) {
      st.doomRounds--;
      if (st.doomRounds === 0) {
        const caster = state.party.find((m) => m.domainKind === "inevitability");
        const power = Math.max(1, Math.round(((caster?.atk || 10) * st.doomPower) / 100));
        events.push({ k: "note", text: "> it arrives. it was always going to." });
        for (const { idx } of livingEnemies()) {
          events.push({ k: "phit", i: Math.max(0, state.party.indexOf(caster || state.party[0])), e: idx, dmg: power, crit: 1 });
          damageEnemy(idx, power);
        }
        if (enemies.every((e) => e.hp <= 0)) break;
      }
    }

    // ── the bleed ticks
    if (st.enemyBleedPct > 0) {
      for (const { e, idx } of livingEnemies()) {
        const tick = Math.max(1, Math.round((e.hp * st.enemyBleedPct) / 100));
        damageEnemy(idx, tick);
      }
      if (enemies.every((e) => e.hp <= 0)) { events.push({ k: "note", text: "> the bleeding finished it." }); break; }
    }

    // ── party swings — always at the weakest thing standing
    const atkMul = (1 + (state.atkBonusPct || 0) / 100) * (focusVolley ? focusMult : 1);
    for (let i = 0; i < state.party.length; i++) {
      const u = state.party[i];
      if (u.hp <= 0) continue;
      const living = livingEnemies();
      if (living.length === 0) break;
      living.sort((a, b) => a.e.hp - b.e.hp);
      const target = living[0];
      const crit = rng() < 0.12;
      const dmg = Math.max(1, Math.round(u.atk * atkMul * (0.8 + rng() * 0.45) * (crit ? 1.8 : 1)));
      const hit: FloorEvent = crit
        ? { k: "phit", i, e: target.idx, dmg, crit: 1 }
        : { k: "phit", i, e: target.idx, dmg };
      events.push(hit);
      damageEnemy(target.idx, dmg);
    }
    focusVolley = false; // one volley, exactly as sold
    if (enemies.every((e) => e.hp <= 0)) break;

    // ── enemies swing back, unless a domain says otherwise
    if (blockVolley) {
      blockVolley = false;
      events.push({ k: "note", text: "> the bulwark takes the whole volley. nothing gets through." });
    } else if (st.enemyFrozenRounds > 0) {
      st.enemyFrozenRounds--;
      events.push({ k: "note", text: "> the chains hold. nothing moves." });
    } else if (st.partyImmuneRounds > 0) {
      st.partyImmuneRounds--;
      events.push({ k: "note", text: "> their blows land on nothing at all." });
    } else {
      const atkDown = st.enemyAtkDownPct > 0 && (st.enemyAtkDownRounds === 0 || st.enemyAtkDownRounds > 0);
      for (let e = 0; e < enemies.length; e++) {
        const en = enemies[e];
        if (en.hp <= 0) continue;
        const living = state.party.map((u, idx) => ({ u, idx })).filter((x) => x.u.hp > 0);
        if (living.length === 0) break;
        const target = living[Math.floor(rng() * living.length)];
        let dmg = Math.max(1, Math.round(en.atk * (0.8 + rng() * 0.4)));
        if (atkDown) dmg = Math.max(1, Math.round(dmg * (1 - st.enemyAtkDownPct / 100)));
        if (state.guardPct) dmg = Math.max(1, Math.round(dmg * (1 - state.guardPct / 100)));
        if (wardVolleys > 0) dmg = Math.max(1, Math.round(dmg * 0.5));
        target.u.hp = Math.max(0, target.u.hp - dmg);
        events.push({ k: "ehit", e, i: target.idx, dmg });
        if (st.reflectRounds > 0) damageEnemy(e, dmg);
        if (target.u.hp === 0) events.push({ k: "fall", i: target.idx });
      }
      if (wardVolleys > 0) wardVolleys--;
      if (st.reflectRounds > 0) st.reflectRounds--;
      if (st.enemyAtkDownRounds > 0) {
        st.enemyAtkDownRounds--;
        if (st.enemyAtkDownRounds === 0 && st.enemyFrozenRounds === 0) st.enemyAtkDownPct = 0;
      }
    }
    if (state.party.every((u) => u.hp <= 0)) {
      events.push({ k: "wipe" });
      return { events, cleared: false, wiped: true };
    }
    if (enemies.every((e) => e.hp <= 0)) break;
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
