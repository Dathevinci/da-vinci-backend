// ═══════════════════════════════════════════════════════════════════════════
// DUEL RULES — the combat engine.
//
// Deliberately PURE: every function here takes state and returns new state, no
// database and no randomness that isn't passed in. That means the rules can be
// reasoned about (and later tested) in isolation, and — more importantly — the
// engine lives ONLY on the server, so a client can never post a result.
//
// The design goal is a match that resolves in 6-12 turns: long enough to make a
// choice matter, short enough to finish while you're still looking at it.
// ═══════════════════════════════════════════════════════════════════════════

import { CARDS, CardRarity, levelMult, abilityFor, skillPower, domainPower, FORGE_ATK_STEP, FORGE_HP_STEP, MYTHIC_MODS, MYTHIC_AFFIXES } from "./cardCatalog";

export const DECK_SIZE = 5;

// How many DIFFERENT support cards one player may play in a single duel.
// Owning more is fine; picking which three matter is the decision.
export const SUPPORTS_PER_DUEL = 3;

// Walking out of a staked duel costs you the pot AND a fine on top, paid to the
// player whose time you wasted. Without the fine, quitting is free the moment
// you're losing — the stake was already gone either way — so the whole point is
// that the fine is money you would still have if you had played it out.
export const FORFEIT_FINE_PERCENT = 25;
export function forfeitFine(stake: number): number {
  return Math.ceil((stake * FORFEIT_FINE_PERCENT) / 100);
}

// Rarity is a REAL edge, not a decided outcome.
//
// The old curve ran 10/3 to 28/12, so a legendary killed a common in 4 swings
// while the common needed 10 to answer — a 2.5x gap on top of a 4x gap, which
// is not a fight, it is a queue. Compressed to roughly 2:1 overall: a
// legendary still wins the even matchup comfortably, but a common that gets a
// hit in is doing real work rather than politely waiting.
//
// Foil (x1.2) and levels (up to x1.63) stack on top, so an INVESTED card still
// pulls far ahead. That gap is earned rather than drawn from a pack.
export const CARD_STATS: Record<CardRarity, { hp: number; atk: number }> = {
  common:    { hp: 18, atk: 7 },
  rare:      { hp: 20, atk: 8 },
  epic:      { hp: 23, atk: 9 },
  legendary: { hp: 26, atk: 10 },
  event:     { hp: 24, atk: 9 },
  // The ★5 premium: costs two consumed legendaries, so it must clearly
  // outrank one — without one card deciding every duel.
  mythic:    { hp: 30, atk: 12 },
};

// Foil copies fight ~20% harder — a real reason to spend shards on one.
export const FOIL_MULT = 1.2;

// Support items, bought with SHARDS. Each is single-use within a duel.
export const ITEMS = {
  heal:   { id: "heal",   name: "Salve",      shards: 120, desc: "Restore 10 HP to your active card." },
  shield: { id: "shield", name: "Ward",       shards: 150, desc: "Halve the next damage you take." },
  focus:  { id: "focus",  name: "Focus",      shards: 180, desc: "Your next attack deals +75%." },
} as const;
export type ItemId = keyof typeof ITEMS;

export interface Fighter {
  cardId: string;
  name: string;
  rarity: CardRarity;
  maxHp: number;
  hp: number;
  atk: number;
  foil: boolean;
  level?: number;
  /** Rank of this copy's skill or domain. Absent means rank 1. */
  skillLevel?: number;
  /** A Mythic's rolled eruption mod (key into MYTHIC_MODS). */
  mythMod?: string;
}

export interface Side {
  userId: string;
  username: string;
  fighters: Fighter[];
  active: number;          // index into fighters
  items: Record<string, number>; // itemId -> charges remaining
  shield: boolean;         // next incoming damage halved
  focus: boolean;          // next outgoing attack boosted (legacy item)
  block?: boolean;         // next incoming attack negated outright
  focusMult?: number;      // multiplier from a support card's focus effect
  usedSupports?: string[]; // support card ids already played THIS duel

  // ── ABILITY STATE ── set by skills and domains, read by the damage maths.
  usedAbilities?: string[];  // cardIds whose skill/domain has already fired
  guardPct?: number;         // percent shed from every incoming blow, lasting
  nullifyTurns?: number;     // incoming damage ignored entirely, counts down
  atkBonus?: number;         // percent added to this side's attacks, lasting
  sealTurns?: number;        // this side cannot play supports, counts down
  bulwarks?: number;         // incoming attacks that will not land, counts down
  weaken?: number;           // percent off this side's NEXT attack, one shot
  /** Bleed on this side's active card, ticking at the end of the enemy turn. */
  bleed?: { pct: number; from: string };
  /** A doom that lands on this side in `turns`, for `power` percent of ATK. */
  doom?: { turns: number; power: number; from: string };
  /** Eclipse: this side's next `turns` attacks land `pct` percent weaker. */
  atkDown?: { pct: number; turns: number };
  /** Chains: this side cannot attack at all while > 0, spent per attempt. */
  chainTurns?: number;
  /** Abyss: while > 0, half of what lands ON this side comes back on the
   *  attacker. Spent per attack that actually deals damage. */
  reflectTurns?: number;
  /** Ophanim: `pct` percent of what lands on this side returns to the
   *  attacker, for the next `volleys` blows that actually land. */
  judge?: { pct: number; volleys: number };
  /** Mirror: `pct` percent of what lands returns to the attacker AND heals
   *  the card it landed on. Lasting — the sliver is small on purpose. */
  mirror?: { pct: number };
  /** A Mythic's armed second stage: `rounds` ticks after the cast it ERUPTS —
   *  every living enemy takes `power`% of the caster's ATK and this side's
   *  living line recovers `healPct`% of max HP. The rolled mod shapes it. */
  ascended?: { cardId: string; name: string; rounds: number; power: number; healPct: number };
}

export interface DuelState {
  a: Side;   // challenger
  b: Side;   // opponent
  turn: string;      // userId whose move it is
  log: string[];
  round: number;
  /** Health-over-time: total HP per side, appended once per RESOLVED action
   *  by the controller. This exists because the log is capped at 60 lines —
   *  a post-match graph derived from it would lie about long fights, and
   *  this game does not show reconstructed numbers. Optional so every state
   *  serialized before the field existed still parses. */
  timeline?: { a: number; b: number }[];
}

export function buildFighter(
  cardId: string, foil: boolean, level = 1, skillLevel = 1,
  atkForge = 0, hpForge = 0, affix = "", mythMod = ""
): Fighter | null {
  const def = CARDS[cardId];
  // Support cards are played, never fielded — they have no stat line, so
  // letting one into a deck would field a fighter with undefined HP.
  if (!def || def.support) return null;
  const base = CARD_STATS[def.rarity];
  // Foil and level stack. Levels are shard-bought, so they have to show up
  // HERE — a level that only changed a number on the card page would be a
  // currency sink that sells nothing. The FORGE lands after the multipliers
  // as flat points, same reason: bought power fights or it isn't power.
  const mult = (foil ? FOIL_MULT : 1) * levelMult(level);
  // A Mythic's rolled affix is a PERCENT on top of everything multiplicative,
  // before the flat forge points — a roll that only changed a tooltip would
  // give re-forging nothing to chase.
  const af = MYTHIC_AFFIXES[affix];
  const afAtk = 1 + (af?.atkPct || 0) / 100;
  const afHp = 1 + (af?.hpPct || 0) / 100;
  const hp = Math.round(base.hp * mult * afHp) + Math.max(0, hpForge) * FORGE_HP_STEP;
  return {
    cardId,
    name: def.name,
    rarity: def.rarity,
    maxHp: hp,
    hp,
    atk: Math.round(base.atk * mult * afAtk) + Math.max(0, atkForge) * FORGE_ATK_STEP,
    foil,
    level,
    skillLevel,
    mythMod: mythMod || undefined,
  };
}

export function makeSide(
  userId: string,
  username: string,
  deck: string[],
  foils: Set<string>,
  items: Record<string, number>,
  // cardId -> level. Absent means level 1, so an old duel or a caller that
  // doesn't know about levels still builds exactly the fighters it used to.
  levels: Record<string, number> = {},
  // cardId -> skill/domain rank. Same contract as `levels`: absent means 1,
  // so an in-flight duel from before abilities existed still builds.
  skillLevels: Record<string, number> = {},
  // cardId -> forge ranks. Absent means unforged — same contract as levels.
  atkForges: Record<string, number> = {},
  hpForges: Record<string, number> = {},
  // Mythic rolls: cardId -> affix key / mod key. Absent = not a mythic.
  affixes: Record<string, string> = {},
  mythMods: Record<string, string> = {}
): Side {
  const fighters = deck
    .map((id) => buildFighter(id, foils.has(id), levels[id] || 1, skillLevels[id] || 1, atkForges[id] || 0, hpForges[id] || 0, affixes[id] || "", mythMods[id] || ""))
    .filter((f): f is Fighter => !!f);
  // active = -1 means NOBODY is on the field yet. The arena opens empty and
  // your first move is genuinely choosing who walks in, instead of the engine
  // having silently already picked for you.
  return { userId, username, fighters, active: -1, items, shield: false, focus: false, usedSupports: [], usedAbilities: [] };
}

function livingIndex(side: Side): number {
  return side.fighters.findIndex((f) => f.hp > 0);
}

export function sideDefeated(side: Side): boolean {
  return side.fighters.every((f) => f.hp <= 0);
}

/** Whose side object is this userId? */
export function sideOf(state: DuelState, userId: string): "a" | "b" | null {
  if (state.a.userId === userId) return "a";
  if (state.b.userId === userId) return "b";
  return null;
}

/**
 * Apply one action. Returns the new state plus whether the duel ended.
 * `roll` is a 0..1 number supplied by the caller so the engine stays pure —
 * it drives the small damage variance that stops matches feeling scripted.
 */
export function applyAction(
  state: DuelState,
  userId: string,
  // `index` on an attack is the card you're SENDING IN this turn — the
  // tactical choice. It becomes your front fighter, which also makes it the
  // one that eats the counter-attack, so leading with your legendary is a real
  // decision rather than a free one.
  action:
    // Deploying and attacking are SEPARATE moves. They used to be one — an
    // attack carried the card index and sent it in on the way past — which
    // meant dragging a card onto the field immediately swung with it, and the
    // defender was force-deployed for them so neither player ever chose who
    // walked out. Now you send a card in (costing the turn), they send theirs
    // in, and only then does anyone swing.
    | { type: "deploy"; index: number }
    | { type: "attack"; index?: number }
    | { type: "item"; item: ItemId }
    // `target` is the fighter a support card was dropped ON. Only heal and
    // revive care; the rest are side-wide and ignore it.
    | { type: "support"; cardId: string; target?: number }
    // The card on the field uses its own skill or domain. Once per duel per
    // card, and it costs the turn like everything else.
    | { type: "ability" },
  roll: number
): { state: DuelState; finished: boolean; winnerId?: string } {
  const meKey = sideOf(state, userId);
  if (!meKey) return { state, finished: false };
  if (state.turn !== userId) return { state, finished: false };

  const s: DuelState = JSON.parse(JSON.stringify(state));
  const me = meKey === "a" ? s.a : s.b;
  const foe = meKey === "a" ? s.b : s.a;

  // ── DEPLOY ── send a card out. Costs the turn, deals nothing.
  // Charging a turn for it is what stops you swapping to your best attacker
  // every round for free; committing a card is a real decision.
  if (action.type === "deploy") {
    const pick = me.fighters[action.index];
    // Never field a corpse, and never spend a turn re-sending the card that is
    // already out there.
    if (!pick || pick.hp <= 0 || action.index === me.active) {
      return { state, finished: false };
    }
    me.active = action.index;
    s.log.push(`${me.username} sent out ${pick.name}.`);
    s.turn = foe.userId;
    s.round += 1;
    if (s.log.length > 60) s.log = s.log.slice(-60);
    return { state: s, finished: false };
  }

  // You cannot swing with nobody on the field, and you cannot swing at an empty
  // one. The defender is NOT dragged out automatically any more — they choose
  // their own card on their own turn.
  if (action.type === "attack" && me.active < 0) return { state, finished: false };
  if (action.type === "attack" && foe.active < 0) return { state, finished: false };
  // Items act on YOUR active card (heal) or your side's next exchange. With
  // nobody on the field there is nothing to apply them to, and the caller would
  // otherwise burn the charge for no effect. Returning the ORIGINAL state makes
  // the controller's no-op check fire BEFORE it opens the transaction.
  if (action.type === "item" && me.active < 0) return { state, finished: false };

  // ── Playing a SUPPORT CARD ────────────────────────────────────────────────
  // Resolved BEFORE the field is normalised below, because a support card is
  // playable even when you have nobody on the field yet — healing the bench or
  // raising a ward is a legitimate opening move. Previously this sat under the
  // `if (!mine || !theirs)` guard, so playing one before deploying silently did
  // nothing at all and the player just lost the tap.
  //
  // Ownership is checked by the caller (it needs the DB); the engine enforces
  // the once-per-duel rule, so a card you own is never spent — only its use.
  if (action.type === "support") {
    const def = CARDS[action.cardId];
    const eff = def?.support;
    if (!eff) return { state, finished: false };
    // Held in a local so the narrowing survives — `usedSupports` is optional on
    // Side, and property narrowing across the branches below is fragile.
    // Sealed by an enemy domain — the card is not spent, the play is refused.
    if (me.sealTurns && me.sealTurns > 0) return { state, finished: false };
    const used: string[] = me.usedSupports || (me.usedSupports = []);
    if (used.includes(action.cardId)) return { state, finished: false };
    /**
     * At most SUPPORTS_PER_DUEL different supports in one duel.
     *
     * Enforced HERE rather than by trusting a client-side loadout, because a
     * hand-rolled request would otherwise let someone play their entire
     * collection of supports across a single match. Owning more is fine —
     * choosing which three matter is the decision.
     */
    if (used.length >= SUPPORTS_PER_DUEL) return { state, finished: false };

    // `target` is the card the player dropped this onto. When it's absent (a
    // tap rather than a drag) we fall back to the active fighter — but when the
    // player AIMED, a bad aim must be refused, never quietly redirected.
    // Silently retargeting spends the card's single use on the wrong fighter.
    const explicit = typeof action.target === "number";
    const wanted = explicit ? (action.target as number) : me.active;

    // A LEVELLED support is a STRONGER EFFECT — supports have no ATK or HP,
    // so their shard levels buy power where the card actually lives: the
    // same +7%/level curve as fighters, applied to what the card DOES.
    const supMult = levelMult((action as any).level || 1);

    if (eff.kind === "heal") {
      // You can only mend the living — bringing someone back is Second Wind's job.
      const t = me.fighters[wanted];
      const tgt = explicit ? t : (t && t.hp > 0 ? t : me.fighters[livingIndex(me)]);
      // Refuse rather than burn the card's one use on nothing.
      if (!tgt || tgt.hp <= 0 || tgt.hp >= tgt.maxHp) return { state, finished: false };
      used.push(action.cardId);
      const before = tgt.hp;
      tgt.hp = Math.min(tgt.maxHp, tgt.hp + Math.round(eff.power * supMult));
      s.log.push(`${me.username} played ${def.name} — ${tgt.name} recovered ${tgt.hp - before} HP.`);
    } else if (eff.kind === "revive") {
      // Target must be a card that has actually fallen. An aimed drop on a
      // living card is refused, not redirected to whoever happens to be dead.
      const t = me.fighters[wanted];
      const tgt = explicit ? t : me.fighters.find((f) => f.hp <= 0);
      if (!tgt || tgt.hp > 0) return { state, finished: false };
      used.push(action.cardId);
      tgt.hp = Math.max(1, Math.round((tgt.maxHp * Math.min(95, Math.round(eff.power * supMult))) / 100));
      s.log.push(`${me.username} played ${def.name} — ${tgt.name} rose again at ${tgt.hp} HP.`);
    } else if (eff.kind === "mend") {
      const wounded = me.fighters.some((f) => f.hp > 0 && f.hp < f.maxHp);
      if (!wounded) return { state, finished: false };
      used.push(action.cardId);
      let healed = 0;
      for (const f of me.fighters) {
        if (f.hp > 0 && f.hp < f.maxHp) {
          const b = f.hp;
          f.hp = Math.min(f.maxHp, f.hp + Math.round(eff.power * supMult));
          healed += f.hp - b;
        }
      }
      s.log.push(`${me.username} played ${def.name} — the whole line recovered ${healed} HP.`);
    } else if (eff.kind === "shield") {
      used.push(action.cardId);
      me.shield = true;
      s.log.push(`${me.username} played ${def.name}. The next blow will glance.`);
    } else if (eff.kind === "block") {
      used.push(action.cardId);
      me.block = true;
      s.log.push(`${me.username} played ${def.name}. The next attack will not land at all.`);
    } else if (eff.kind === "focus") {
      used.push(action.cardId);
      // Level scales the BONUS part: a ×1.5 card at level 10 is ×1.8, not ×2.4.
      me.focusMult = 1 + (eff.power - 1) * supMult;
      s.log.push(`${me.username} played ${def.name} — the next strike will hit far harder.`);
    } else if (eff.kind === "bless") {
      // Seraphim — a PERCENT mend across every living ally. Caps keep a
      // level-10 blessing strong rather than absolute.
      const wounded = me.fighters.some((f) => f.hp > 0 && f.hp < f.maxHp);
      if (!wounded) return { state, finished: false };
      used.push(action.cardId);
      const pct = Math.min(80, Math.round(eff.power * 100 * supMult));
      let healed = 0;
      for (const f of me.fighters) {
        if (f.hp > 0 && f.hp < f.maxHp) {
          const b = f.hp;
          f.hp = Math.min(f.maxHp, f.hp + Math.max(1, Math.round((f.maxHp * pct) / 100)));
          healed += f.hp - b;
        }
      }
      s.log.push(`${me.username} played ${def.name} — a blessing restored ${healed} HP across the line.`);
    } else if (eff.kind === "reflect") {
      used.push(action.cardId);
      const pct = Math.min(80, Math.round(eff.power * 100 * supMult));
      me.judge = { pct, volleys: 3 };
      s.log.push(`${me.username} played ${def.name} — for the next 3 blows that land, judgment answers with ${pct}% in kind.`);
    } else if (eff.kind === "pact") {
      // Trade with the Devil — the contract needs a living signer with HP
      // to give. The PRICE is fixed; only the payout scales with level.
      const t = me.active >= 0 ? me.fighters[me.active] : undefined;
      if (!t || t.hp <= 1) return { state, finished: false };
      used.push(action.cardId);
      const price = Math.max(1, Math.round(t.hp * eff.power));
      t.hp = Math.max(1, t.hp - price);
      const bonus = Math.min(90, Math.round(50 * supMult));
      me.atkBonus = Math.max(me.atkBonus || 0, bonus);
      me.guardPct = Math.max(me.guardPct || 0, 25);
      s.log.push(`${me.username} played ${def.name} — ${t.name} paid ${price} HP, and the contract pays back in power.`);
    } else if (eff.kind === "stone") {
      used.push(action.cardId);
      const bonus = Math.min(60, Math.round(eff.power * supMult));
      me.atkBonus = Math.max(me.atkBonus || 0, bonus);
      // Untargetable rides the same rail as a domain's bulwarks: the next
      // two enemy attacks simply do not land.
      me.bulwarks = Math.max(me.bulwarks || 0, 2);
      s.log.push(`${me.username} played ${def.name} — stone hands hit ${bonus}% harder, and the next 2 attacks find nothing.`);
    } else if (eff.kind === "mirror") {
      used.push(action.cardId);
      const pct = Math.min(30, Math.round(eff.power * 100 * supMult));
      me.mirror = { pct };
      s.log.push(`${me.username} played ${def.name} — the glass returns ${pct}% of every blow, and drinks what it returns.`);
    } else if (eff.kind === "arise") {
      // ALL the fallen, at once — that is the whole card.
      const fallen = me.fighters.filter((f) => f.hp <= 0);
      if (fallen.length === 0) return { state, finished: false };
      used.push(action.cardId);
      const pct = Math.min(25, Math.round(eff.power * 100 * supMult));
      for (const f of fallen) f.hp = Math.max(1, Math.round((f.maxHp * pct) / 100));
      const bonus = Math.min(40, Math.round(20 * supMult));
      me.atkBonus = Math.max(me.atkBonus || 0, bonus);
      s.log.push(`${me.username} played ${def.name} — ARISE. ${fallen.length} fallen stood back up, angrier.`);
    } else {
      return { state, finished: false };
    }

    /**
     * Playing a support KEEPS your turn.
     *
     * It used to pass, which made every support a trade: heal for 12 and hand
     * the opponent a free swing worth more than the heal. Rationally you never
     * played one, so three cards you had to collect and choose between sat
     * unused all match.
     *
     * The cost is already the card itself — one use each, three per duel, and
     * they do not come back. That is the real limit; spending the turn on top
     * of it just priced them out of the game.
     */
    if (s.log.length > 60) s.log = s.log.slice(-60);
    return { state: s, finished: false };
  }

  /* ── ABILITY ── the card on the field uses its skill or its domain ───────
   *
   * Once per duel PER CARD, tracked on the side rather than the fighter so it
   * survives the card falling and being revived — a domain that could be
   * re-cast by dying and coming back would be the whole game.
   *
   * Skills touch numbers; domains rewrite a rule. That split is why they are
   * resolved in two blocks here rather than one table of multipliers.
   */
  if (action.type === "ability") {
    if (me.active < 0) return { state, finished: false };
    const self = me.fighters[me.active];
    if (!self || self.hp <= 0) return { state, finished: false };

    const fired: string[] = me.usedAbilities || (me.usedAbilities = []);
    if (fired.includes(self.cardId)) return { state, finished: false };

    const ability = abilityFor(self.cardId);
    if (!ability) return { state, finished: false };

    const rank = self.skillLevel || 1;
    const target = foe.active >= 0 ? foe.fighters[foe.active] : undefined;

    if (ability.type === "skill") {
      const p = skillPower(ability.def, rank);
      const k = ability.def.kind;

      // Anything that needs someone to hit is refused rather than wasted.
      const needsTarget = ["burst", "drain", "execute", "pierce", "cleave", "venom", "stagger"];
      if (needsTarget.includes(k) && !target) return { state, finished: false };

      if (k === "burst") {
        const dealt = Math.max(1, Math.round(self.atk * (p / 100)));
        target!.hp = Math.max(0, target!.hp - dealt);
        s.log.push(`${self.name} used ${ability.def.name} — ${dealt} to ${target!.name}.`);
      } else if (k === "drain") {
        const dealt = Math.max(1, Math.round(self.atk * (p / 100)));
        target!.hp = Math.max(0, target!.hp - dealt);
        const back = Math.round(dealt / 2);
        self.hp = Math.min(self.maxHp, self.hp + back);
        s.log.push(`${self.name} used ${ability.def.name} — ${dealt} to ${target!.name}, ${back} back.`);
      } else if (k === "execute") {
        // A threshold finisher, not a nuke: it only ever converts a nearly-won
        // exchange, so it can't steal a fight from full health.
        if (target!.hp > (target!.maxHp * p) / 100) {
          s.log.push(`${self.name} reached for ${ability.def.name}, but ${target!.name} was still standing too well.`);
        } else {
          target!.hp = 0;
          s.log.push(`${self.name} used ${ability.def.name} — ${target!.name} was finished outright.`);
        }
      } else if (k === "guard") {
        // Stacks additively but is capped: 100% shed would be unkillable.
        me.guardPct = Math.min(75, (me.guardPct || 0) + p);
        s.log.push(`${self.name} used ${ability.def.name} — this side now sheds ${me.guardPct}% of every blow.`);
      } else if (k === "rally") {
        let healed = 0;
        for (const f of me.fighters) {
          if (f.hp > 0 && f.hp < f.maxHp) {
            const b = f.hp;
            f.hp = Math.min(f.maxHp, f.hp + Math.round((f.maxHp * p) / 100));
            healed += f.hp - b;
          }
        }
        if (healed === 0) return { state, finished: false };
        s.log.push(`${self.name} used ${ability.def.name} — the line recovered ${healed} HP.`);
      } else if (k === "pierce") {
        // Ignores every defence on purpose — that IS the skill, so it is
        // resolved here rather than going through the attack maths.
        const dealt = Math.max(1, Math.round(self.atk * (p / 100)));
        target!.hp = Math.max(0, target!.hp - dealt);
        s.log.push(`${self.name} used ${ability.def.name} — ${dealt} straight through every guard.`);
      } else if (k === "cleave") {
        const dealt = Math.max(1, Math.round(self.atk * (p / 100)));
        target!.hp = Math.max(0, target!.hp - dealt);
        // The next LIVING card behind the one in front, not simply index+1 —
        // the bench is rarely in tidy order by the time this matters.
        const behind = foe.fighters.find((f, i) => i !== foe.active && f.hp > 0);
        if (behind) {
          const splash = Math.max(1, Math.round(dealt / 2));
          behind.hp = Math.max(0, behind.hp - splash);
          s.log.push(`${self.name} used ${ability.def.name} — ${dealt} to ${target!.name}, ${splash} to ${behind.name} behind it.`);
        } else {
          s.log.push(`${self.name} used ${ability.def.name} — ${dealt} to ${target!.name}.`);
        }
      } else if (k === "venom") {
        foe.bleed = { pct: p, from: ability.def.name };
        s.log.push(`${self.name} used ${ability.def.name} — it will not stop bleeding.`);
      } else if (k === "stagger") {
        foe.weaken = Math.min(90, (foe.weaken || 0) + p);
        s.log.push(`${self.name} used ${ability.def.name} — the next blow against you lands ${foe.weaken}% weaker.`);
      } else if (k === "bulwark") {
        me.bulwarks = (me.bulwarks || 0) + Math.max(1, p);
        s.log.push(`${self.name} used ${ability.def.name} — the next ${me.bulwarks} attack(s) will not land.`);
      } else if (k === "mendself") {
        if (self.hp >= self.maxHp) return { state, finished: false };
        const before = self.hp;
        self.hp = Math.min(self.maxHp, self.hp + Math.round((self.maxHp * p) / 100));
        s.log.push(`${self.name} used ${ability.def.name} — recovered ${self.hp - before} HP.`);
      } else if (k === "sap") {
        // Stored as a NEGATIVE attack bonus on them, so it runs through the
        // same multiplier the ascend domain uses. Floored so it can never
        // invert an attack into healing.
        foe.atkBonus = Math.max(-80, (foe.atkBonus || 0) - p);
        s.log.push(`${self.name} used ${ability.def.name} — ${foe.username} now strikes ${Math.abs(foe.atkBonus)}% weaker.`);
      } else if (k === "empower") {
        // Written onto the FIGHTER, so it survives the card falling and being
        // revived — which is what the card text promises.
        const gain = Math.max(1, Math.round((self.atk * p) / 100));
        self.atk += gain;
        s.log.push(`${self.name} used ${ability.def.name} — its attack rose to ${self.atk}, permanently.`);
      } else {
        return { state, finished: false };
      }
    } else {
      const p = domainPower(ability.def, rank);
      const k = ability.def.kind;
      s.log.push(`▲ ${me.username} expanded a domain — ${ability.def.name}.`);

      if (k === "revival") {
        const fallen = me.fighters.filter((f) => f.hp <= 0);
        if (fallen.length === 0) {
          // Refuse rather than burn the once-per-duel use on nothing.
          s.log.pop();
          return { state, finished: false };
        }
        for (const f of fallen) f.hp = Math.max(1, Math.round((f.maxHp * p) / 100));
        s.log.push(`${fallen.length} fallen card${fallen.length === 1 ? "" : "s"} stood back up.`);
      } else if (k === "massacre") {
        const living = foe.fighters.filter((f) => f.hp > 0);
        if (living.length === 0) { s.log.pop(); return { state, finished: false }; }
        const each = Math.max(1, Math.round(self.atk * (p / 100)));
        for (const f of living) f.hp = Math.max(0, f.hp - each);
        s.log.push(`Every card opposite took ${each}.`);
      } else if (k === "nullify") {
        me.nullifyTurns = (me.nullifyTurns || 0) + p;
        s.log.push(`Nothing will reach ${me.username} for ${me.nullifyTurns} turns.`);
      } else if (k === "siphon") {
        const living = foe.fighters.filter((f) => f.hp > 0);
        if (living.length === 0) { s.log.pop(); return { state, finished: false }; }
        let taken = 0;
        for (const f of living) {
          const t = Math.max(1, Math.round((f.hp * p) / 100));
          f.hp = Math.max(0, f.hp - t);
          taken += t;
        }
        self.hp = Math.min(self.maxHp, self.hp + taken);
        s.log.push(`${taken} HP drained out of the other line and into ${self.name}.`);
      } else if (k === "ascend") {
        me.atkBonus = (me.atkBonus || 0) + p;
        s.log.push(`${me.username}'s whole line strikes ${me.atkBonus}% harder for the rest of the duel.`);
      } else if (k === "judgement") {
        const living = foe.fighters.filter((f) => f.hp > 0).sort((a, b) => a.hp - b.hp);
        if (living.length === 0) { s.log.pop(); return { state, finished: false }; }
        const felled = living.slice(0, Math.max(1, p));
        for (const f of felled) f.hp = 0;
        s.log.push(`${felled.map((f) => f.name).join(", ")} fell where they stood.`);
      } else if (k === "seal") {
        foe.sealTurns = (foe.sealTurns || 0) + p;
        s.log.push(`${foe.username} cannot play a support for ${foe.sealTurns} turns.`);
      } else if (k === "inevitability") {
        // Lands in three turns no matter what. Stored on the SIDE it will hit.
        foe.doom = { turns: 3, power: p, from: self.name };
        s.log.push(`Something is coming for ${foe.username}. Three turns.`);
      } else if (k === "eclipse") {
        // A lasting dimming on the ENEMY's swings, spent per attack they make.
        foe.atkDown = { pct: p, turns: 3 };
        s.log.push(`The sun went out over ${foe.username} — their next 3 attacks land ${p}% weaker.`);
      } else if (k === "carrion") {
        // Feeds on every fallen card on the board, BOTH sides — the crows do
        // not care whose dead they are.
        const fallenAll =
          me.fighters.filter((f) => f.hp <= 0).length +
          foe.fighters.filter((f) => f.hp <= 0).length;
        if (fallenAll === 0 || !target) { s.log.pop(); return { state, finished: false }; }
        // The crows can only carry what was actually there — the heal is
        // what was TAKEN, not the theoretical feast.
        const feast = Math.max(1, Math.round(self.atk * (p / 100) * fallenAll));
        const taken = Math.min(feast, target.hp);
        target.hp = Math.max(0, target.hp - feast);
        self.hp = Math.min(self.maxHp, self.hp + taken);
        s.log.push(`The crows took ${taken} from ${target.name} and fed it to ${self.name}.`);
      } else if (k === "bloodmoon") {
        if (!target) { s.log.pop(); return { state, finished: false }; }
        // Reuses the bleed channel, but never DOWNGRADES it — a rank-5 venom
        // bleeds harder than a rank-1 moon, and casting the domain over it
        // must not halve the poison you already landed.
        const pct = Math.max(foe.bleed?.pct ?? 0, p);
        foe.bleed = { pct, from: ability.def.name };
        s.log.push(`${target.name} began to bleed ${pct}% of its health every turn. It will not stop.`);
      } else if (k === "chains") {
        foe.chainTurns = (foe.chainTurns || 0) + p;
        s.log.push(`${foe.username} is chained — no attacks for ${foe.chainTurns} turn${foe.chainTurns === 1 ? "" : "s"}.`);
      } else if (k === "monarch") {
        // The fallen lend their strength. Rides the same lasting atkBonus as
        // ascend, scaled by how many of yours are down — refuse on none, so
        // the once-per-duel use is never burnt for zero.
        const fallenMine = me.fighters.filter((f) => f.hp <= 0).length;
        if (fallenMine === 0) { s.log.pop(); return { state, finished: false }; }
        const gain = p * fallenMine;
        me.atkBonus = (me.atkBonus || 0) + gain;
        s.log.push(`${fallenMine} fallen answered the call — ${me.username}'s line strikes ${gain}% harder, for good.`);
      } else if (k === "terror") {
        if (!target) { s.log.pop(); return { state, finished: false }; }
        // Percent of CURRENT health: never lethal on its own, devastating on
        // anything healthy, and it ignores guard by design — nerve is not
        // something armour helps with. The cap at hp-1 is what makes "never
        // lethal" literally true — without it the 1-damage floor executed a
        // card sitting on its last hit point.
        const bite = Math.min(Math.max(0, target.hp - 1), Math.max(1, Math.round((target.hp * p) / 100)));
        if (bite <= 0) { s.log.pop(); return { state, finished: false }; }
        target.hp = Math.max(0, target.hp - bite);
        s.log.push(`${target.name} saw it smile, and lost ${bite}.`);
      } else if (k === "abyss") {
        me.reflectTurns = (me.reflectTurns || 0) + p;
        s.log.push(`The water remembers — for ${me.reflectTurns} attack${me.reflectTurns === 1 ? "" : "s"}, what lands on ${me.username} comes back on the dealer.`);
      } else if (k === "tempest") {
        if (!target) { s.log.pop(); return { state, finished: false }; }
        // Three strikes as ONE resolution — a single number in the log, not
        // three lines, because the whole point is one breath.
        const total = Math.max(3, Math.round(self.atk * (p / 100)) * 3);
        target.hp = Math.max(0, target.hp - total);
        s.log.push(`Three strikes in one breath — ${target.name} took ${total}.`);
      } else if (k === "shatter") {
        const had = (foe.shield ? 1 : 0) + (foe.block ? 1 : 0) + (foe.bulwarks || 0) + ((foe.guardPct || 0) > 0 ? 1 : 0);
        foe.shield = false; foe.block = false; foe.bulwarks = 0; foe.guardPct = 0;
        if (!target) { s.log.pop(); return { state, finished: false }; }
        const hit = Math.max(1, Math.round(self.atk * (p / 100)));
        target.hp = Math.max(0, target.hp - hit);
        s.log.push(had > 0
          ? `Every protection ${foe.username} held shattered at once — and ${target.name} took ${hit}.`
          : `${target.name} took ${hit}. There was nothing left to break first.`);
      } else if (k === "unchained") {
        const afflicted = !!(me.bleed || me.chainTurns || me.sealTurns || me.doom || me.atkDown || me.weaken);
        me.bleed = undefined; me.chainTurns = 0; me.sealTurns = 0;
        me.doom = undefined; me.atkDown = undefined; me.weaken = 0;
        if (!target) { s.log.pop(); return { state, finished: false }; }
        const lash = Math.max(1, Math.round(self.atk * (p / 100)));
        target.hp = Math.max(0, target.hp - lash);
        s.log.push(afflicted
          ? `${me.username} shed every chain on them — and the broken links lashed ${target.name} for ${lash}.`
          : `The chains swung free — ${target.name} took ${lash}.`);
      } else if (k === "vessel") {
        if (!target) { s.log.pop(); return { state, finished: false }; }
        // Written on the FIGHTERS, like empower: it survives falls, revives,
        // everything. Floored so a card is never stripped to nothing.
        const steal = Math.max(1, Math.round((target.atk * p) / 100));
        target.atk = Math.max(1, target.atk - steal);
        self.atk += steal;
        s.log.push(`${self.name} took ${steal} ATK out of ${target.name}'s hands. It is not giving it back.`);
      } else if (k === "adapt") {
        // Additive with the guard skill, capped — two turtles stack, but the
        // wall never passes 60% or attacks would stop mattering at all.
        me.guardPct = Math.min(60, (me.guardPct || 0) + p);
        s.log.push(`${me.username}'s side adapts — ${me.guardPct}% of every blow is shed, for the rest of the duel.`);
      } else if (k === "wildfire") {
        const living = foe.fighters.filter((f) => f.hp > 0);
        if (living.length === 0) { s.log.pop(); return { state, finished: false }; }
        const each = Math.max(1, Math.round(self.atk * (p / 100)));
        for (const f of living) f.hp = Math.max(0, f.hp - each);
        // The fire stays: a standing bleed, never downgrading one already
        // burning hotter (the bloodmoon lesson).
        foe.bleed = { pct: Math.max(foe.bleed?.pct ?? 0, 6), from: ability.def.name };
        s.log.push(`The garden went up — every card opposite took ${each}, and the fire stayed.`);
      } else if (k === "floodtide") {
        if (!target) { s.log.pop(); return { state, finished: false }; }
        // Heals what was actually TAKEN, split across your living line — the
        // carrion rule: the tide can only carry what was there.
        const surge = Math.max(1, Math.round(self.atk * (p / 100)));
        const taken = Math.min(surge, target.hp);
        target.hp = Math.max(0, target.hp - surge);
        const mineLiving = me.fighters.filter((f) => f.hp > 0);
        const share = Math.max(1, Math.round(taken / Math.max(1, mineLiving.length)));
        for (const f of mineLiving) f.hp = Math.min(f.maxHp, f.hp + share);
        s.log.push(`The tide took ${taken} from ${target.name} and fed the line ${share} each.`);
      } else {
        s.log.pop();
        return { state, finished: false };
      }

      // ── THE ASCENDED SECOND STAGE ── a Mythic's domain doesn't end when
      // it fires: two rounds on (the rolled mod can move that), it ERUPTS —
      // every living enemy takes a share of the caster's ATK and your line
      // steadies. Armed here, resolved in the lasting-effects tick.
      if (CARDS[self.cardId]?.rarity === "mythic") {
        const mod = MYTHIC_MODS[self.mythMod || ""];
        me.ascended = {
          cardId: self.cardId,
          name: ability.def.name,
          rounds: mod?.delay ?? 2,
          power: Math.round((50 + 15 * rank) * (mod?.powerMult ?? 1)),
          healPct: mod?.healPct ?? 10,
        };
        s.log.push(`…and the domain HOLDS. It will erupt again.`);
      }
    }

    fired.push(self.cardId);
    s.turn = foe.userId;
    s.round += 1;

    // A domain can empty a whole line, so the duel may be over right here.
    const foeDown = foe.fighters.every((f) => f.hp <= 0);
    const meDown = me.fighters.every((f) => f.hp <= 0);
    if (foe.active >= 0 && foe.fighters[foe.active]?.hp <= 0) foe.active = -1;
    if (s.log.length > 60) s.log = s.log.slice(-60);
    if (foeDown || meDown) {
      const winnerId = foeDown ? me.userId : foe.userId;
      s.log.push(`${foeDown ? me.username : foe.username} won the duel.`);
      return { state: s, finished: true, winnerId };
    }
    return { state: s, finished: false };
  }

  // A fallen card leaves the field EMPTY rather than the next one sliding in
  // automatically. Whoever lost a card chooses their own replacement on their
  // own turn — having the engine pick for them was the thing that made the
  // board feel like it was playing itself.
  if (me.active >= 0 && me.fighters[me.active]?.hp <= 0) me.active = -1;
  if (foe.active >= 0 && foe.fighters[foe.active]?.hp <= 0) foe.active = -1;

  const mine = me.fighters[me.active];
  // An item only ever touches YOUR side, so it must not require an enemy on the
  // field. Requiring one is what let a first-turn item fall through to the bail
  // below — which returned the CLONE, so the controller saw a "changed" state,
  // opened the transaction and spent the charge for no effect.
  const theirs = foe.active >= 0 ? foe.fighters[foe.active] : undefined;
  if (!mine) return { state, finished: false };
  if (action.type !== "item" && !theirs) return { state, finished: false };

  if (action.type === "item") {
    // The CALLER has already verified and consumed a charge from the user's
    // bag inside its transaction — the engine stays pure and just applies the
    // effect. (Charges live on the user, not the duel, so an item bought
    // mid-match is usable immediately and never trapped in a finished duel.)
    if (action.item === "heal") {
      const before = mine.hp;
      mine.hp = Math.min(mine.maxHp, mine.hp + 10);
      s.log.push(`${me.username} used Salve — ${mine.name} recovered ${mine.hp - before} HP.`);
    } else if (action.item === "shield") {
      me.shield = true;
      s.log.push(`${me.username} raised a Ward.`);
    } else if (action.item === "focus") {
      me.focus = true;
      s.log.push(`${me.username} is focusing.`);
    }
  } else {
    // Unreachable after the force-deploy above, but strict tsc can't see that
    // and `theirs` is now optional — narrow it rather than assert non-null.
    if (!theirs) return { state, finished: false };
    // Chained by The Long Chain: the swing simply does not happen. Spent per
    // ATTEMPTED attack, and the turn still passes — that is the whole cost.
    // Checked before bulwark/block so the defender's wards aren't wasted on
    // an attack that was never going to arrive.
    if (me.chainTurns && me.chainTurns > 0) {
      me.chainTurns -= 1;
      s.log.push(`${mine.name} pulled against the chain — the swing never came. ${me.chainTurns} turn${me.chainTurns === 1 ? "" : "s"} of chain left.`);
      s.turn = foe.userId;
      s.round += 1;
      if (s.log.length > 60) s.log = s.log.slice(-60);
      return { state: s, finished: false };
    }
    // A block negates the hit entirely and is consumed. Checked BEFORE the
    // focus buffs are spent: attacking into a Bulwark used to burn your Focus
    // and your War Cry for zero damage, which made the counter feel like a bug.
    // The buff survives to be spent on the next swing instead.
    // Bulwark absorbs whole attacks and stacks; checked alongside block for
    // the same reason — the attacker's buffs must survive being turned aside.
    if (foe.bulwarks && foe.bulwarks > 0) {
      foe.bulwarks -= 1;
      s.log.push(`${theirs.name} did not let the blow land. ${foe.bulwarks} left.`);
      s.turn = foe.userId;
      s.round += 1;
      if (s.log.length > 60) s.log = s.log.slice(-60);
      return { state: s, finished: false };
    }
    if (foe.block) {
      foe.block = false;
      s.log.push(`${theirs.name} turned the blow aside completely.`);
      s.turn = foe.userId;
      s.round += 1;
      if (s.log.length > 60) s.log = s.log.slice(-60);
      return { state: s, finished: false };
    }
    // Damage: base attack, +/-15% variance, focus bonus, shield reduction.
    let dmg = mine.atk * (0.85 + roll * 0.3);
    // Ascend is a lasting, side-wide multiplier, so it applies before the
    // one-shot buffs rather than competing with them.
    if (me.atkBonus) dmg *= 1 + me.atkBonus / 100;
    // Eclipse: this side swings in the dark for a few attacks. Spent per
    // swing, capped so it can never zero a blow outright.
    if (me.atkDown && me.atkDown.turns > 0) {
      dmg *= 1 - Math.min(90, me.atkDown.pct) / 100;
      me.atkDown.turns -= 1;
      if (me.atkDown.turns <= 0) me.atkDown = undefined;
    }
    // One-shot weakening from an enemy stagger, spent whether it kills or not.
    if (me.weaken) { dmg *= 1 - Math.min(90, me.weaken) / 100; me.weaken = undefined; }
    if (me.focus) {
      dmg *= 1.75;
      me.focus = false;
    }
    if (me.focusMult && me.focusMult > 1) {
      dmg *= me.focusMult;
      me.focusMult = undefined;
    }
    if (foe.shield) {
      dmg *= 0.5;
      foe.shield = false;
    }
    // A lasting guard, on top of any one-shot ward. Capped at 75% where it is
    // set, so this can never reach zero.
    if (foe.guardPct) dmg *= 1 - foe.guardPct / 100;
    // Nullify beats everything, including the Math.max(1) floor below: the
    // domain says nothing reaches you, so nothing does.
    if (foe.nullifyTurns && foe.nullifyTurns > 0) {
      foe.nullifyTurns -= 1;
      s.log.push(`The blow found nothing to land on. ${foe.nullifyTurns} turns remain.`);
      s.turn = foe.userId;
      s.round += 1;
      if (s.log.length > 60) s.log = s.log.slice(-60);
      return { state: s, finished: false };
    }
    const dealt = Math.max(1, Math.round(dmg));
    theirs.hp = Math.max(0, theirs.hp - dealt);
    s.log.push(`${mine.name} struck ${theirs.name} for ${dealt}.`);

    if (theirs.hp === 0) {
      s.log.push(`${theirs.name} fell.`);
      // Their field empties. They pick who steps up next, on their turn.
      foe.active = -1;
    }

    // The abyss answers: half of what landed comes straight back on the
    // attacker. Spent per attack that actually dealt damage — a nullified or
    // blocked swing never reaches this code, which is correct: nothing
    // landed, so there is nothing for the water to remember.
    if (foe.reflectTurns && foe.reflectTurns > 0) {
      foe.reflectTurns -= 1;
      const back = Math.max(1, Math.round(dealt / 2));
      mine.hp = Math.max(0, mine.hp - back);
      s.log.push(`The water returned ${back} of it to ${mine.name}.`);
      if (mine.hp === 0) {
        s.log.push(`${mine.name} fell.`);
        me.active = -1;
      }
    }
    // Divine Judgment: a share of what landed comes back, spent per blow
    // that actually landed — same rule as the abyss above.
    if (foe.judge && foe.judge.volleys > 0) {
      foe.judge.volleys -= 1;
      const back = Math.max(1, Math.round((dealt * foe.judge.pct) / 100));
      mine.hp = Math.max(0, mine.hp - back);
      s.log.push(`Judgment returned ${back} to ${mine.name}. ${foe.judge.volleys} answer(s) remain.`);
      if (foe.judge.volleys <= 0) foe.judge = undefined;
      if (mine.hp === 0) {
        s.log.push(`${mine.name} fell.`);
        me.active = -1;
      }
    }
    // The mirror: a sliver returns AND heals the card it landed on. Only
    // while that card still stands — broken glass reflects nothing.
    if (foe.mirror && theirs.hp > 0) {
      const back = Math.max(1, Math.round((dealt * foe.mirror.pct) / 100));
      mine.hp = Math.max(0, mine.hp - back);
      theirs.hp = Math.min(theirs.maxHp, theirs.hp + back);
      s.log.push(`The mirror returned ${back} — and drank it.`);
      if (mine.hp === 0) {
        s.log.push(`${mine.name} fell.`);
        me.active = -1;
      }
    }
  }

  /* ── LASTING EFFECTS TICK ──────────────────────────────────────────────
   * Counted down at the END of the acting player's turn, so "two turns" means
   * two of THEIRS rather than two half-turns. The doom is resolved here too:
   * it landing is the point, so nothing in the branch above can cancel it.
   */
  // Bleed ticks on the side that was poisoned, at the end of the poisoner's
  // turn, so "each of your turns" in the card text is literally what happens.
  if (foe.bleed) {
    const v = foe.active >= 0 ? foe.fighters[foe.active] : undefined;
    if (v && v.hp > 0) {
      const t = Math.max(1, Math.round((v.maxHp * foe.bleed.pct) / 100));
      v.hp = Math.max(0, v.hp - t);
      s.log.push(`${v.name} lost ${t} to ${foe.bleed.from}.`);
      if (v.hp === 0) { s.log.push(`${v.name} fell.`); foe.active = -1; }
    }
  }
  if (me.sealTurns && me.sealTurns > 0) {
    me.sealTurns -= 1;
    if (me.sealTurns === 0) s.log.push(`${me.username} can play supports again.`);
  }
  // ── THE ERUPTION ── a Mythic's armed second stage counts down with the
  // dooms, and lands the same way: nothing above can cancel it. Every living
  // enemy takes the share; the caster's LIVING line steadies.
  for (const side of [me, foe]) {
    if (!side.ascended) continue;
    side.ascended.rounds -= 1;
    if (side.ascended.rounds > 0) continue;
    const other = side === me ? foe : me;
    const caster = side.fighters.find((f) => f.cardId === side.ascended!.cardId);
    // The caster may be dead by now — the domain erupts anyway, off the
    // stored power and the caster's BASE-built atk if it still stands,
    // else a floor of its printed attack. An eruption that fizzles when
    // the caster falls would make focusing the mythic erase the whole tell.
    const atkRef = caster?.atk ?? CARD_STATS.mythic.atk;
    const hit = Math.max(1, Math.round((atkRef * side.ascended.power) / 100));
    let struck = 0;
    for (const f of other.fighters) {
      if (f.hp <= 0) continue;
      f.hp = Math.max(0, f.hp - hit);
      struck++;
      if (f.hp === 0) s.log.push(`${f.name} fell.`);
    }
    for (const f of side.fighters) {
      if (f.hp <= 0) continue;
      f.hp = Math.min(f.maxHp, f.hp + Math.max(1, Math.round((f.maxHp * side.ascended.healPct) / 100)));
    }
    s.log.push(`▲▲ ${side.ascended.name} ERUPTED — ${struck} card${struck === 1 ? "" : "s"} took ${hit}, and ${side.username}'s line steadied.`);
    if (other.active >= 0 && other.fighters[other.active]?.hp <= 0) other.active = -1;
    side.ascended = undefined;
  }
  for (const side of [me, foe]) {
    if (!side.doom) continue;
    side.doom.turns -= 1;
    if (side.doom.turns > 0) continue;
    const victim = side.active >= 0 ? side.fighters[side.active] : side.fighters.find((f) => f.hp > 0);
    if (victim) {
      // Reads off the doom's stored power, not the caster's current ATK — the
      // card that set it may be dead by now, and it lands regardless.
      const hit = Math.max(1, Math.round((victim.maxHp * side.doom.power) / 100));
      victim.hp = Math.max(0, victim.hp - hit);
      s.log.push(`It arrived. ${victim.name} took ${hit} from ${side.doom.from}.`);
      if (victim.hp === 0) {
        s.log.push(`${victim.name} fell.`);
        if (side.active >= 0 && side.fighters[side.active]?.hp <= 0) side.active = -1;
      }
    }
    side.doom = undefined;
  }

  // Win check — after the tick, because a doom can end the duel.
  if (sideDefeated(foe)) {
    s.log.push(`${me.username} wins the duel.`);
    return { state: s, finished: true, winnerId: me.userId };
  }
  if (sideDefeated(me)) {
    s.log.push(`${foe.username} wins the duel.`);
    return { state: s, finished: true, winnerId: foe.userId };
  }

  // Pass the turn
  s.turn = foe.userId;
  s.round += 1;
  // Keep the log from growing without bound on a long match.
  if (s.log.length > 60) s.log = s.log.slice(-60);
  return { state: s, finished: false };
}

// ── Ranking ────────────────────────────────────────────────────────────────
// Standard Elo. K=32 gives a visible move per match at this population size
// without letting one lucky win rewrite someone's standing.
export const ELO_K = 32;
export function eloDelta(myRating: number, theirRating: number, won: boolean): number {
  const expected = 1 / (1 + Math.pow(10, (theirRating - myRating) / 400));
  return Math.round(ELO_K * ((won ? 1 : 0) - expected));
}

// The house takes a cut of every pot and BURNS it — competitive play is a sink,
// not just points sloshing between the same few players.
export const RAKE_PERCENT = 10;
export function payout(stake: number): { pot: number; rake: number; toWinner: number } {
  const pot = stake * 2;
  const rake = Math.floor((pot * RAKE_PERCENT) / 100);
  return { pot, rake, toWinner: pot - rake };
}

export const MIN_STAKE = 50;
export const MAX_STAKE = 5000;
export const DUEL_EXPIRY_HOURS = 24;
