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

import { CARDS, CardRarity, levelMult, abilityFor, skillPower, domainPower } from "./cardCatalog";

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
}

export interface DuelState {
  a: Side;   // challenger
  b: Side;   // opponent
  turn: string;      // userId whose move it is
  log: string[];
  round: number;
}

export function buildFighter(cardId: string, foil: boolean, level = 1, skillLevel = 1): Fighter | null {
  const def = CARDS[cardId];
  // Support cards are played, never fielded — they have no stat line, so
  // letting one into a deck would field a fighter with undefined HP.
  if (!def || def.support) return null;
  const base = CARD_STATS[def.rarity];
  // Foil and level stack. Levels are shard-bought, so they have to show up
  // HERE — a level that only changed a number on the card page would be a
  // currency sink that sells nothing.
  const mult = (foil ? FOIL_MULT : 1) * levelMult(level);
  const hp = Math.round(base.hp * mult);
  return {
    cardId,
    name: def.name,
    rarity: def.rarity,
    maxHp: hp,
    hp,
    atk: Math.round(base.atk * mult),
    foil,
    level,
    skillLevel,
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
  skillLevels: Record<string, number> = {}
): Side {
  const fighters = deck
    .map((id) => buildFighter(id, foils.has(id), levels[id] || 1, skillLevels[id] || 1))
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

    if (eff.kind === "heal") {
      // You can only mend the living — bringing someone back is Second Wind's job.
      const t = me.fighters[wanted];
      const tgt = explicit ? t : (t && t.hp > 0 ? t : me.fighters[livingIndex(me)]);
      // Refuse rather than burn the card's one use on nothing.
      if (!tgt || tgt.hp <= 0 || tgt.hp >= tgt.maxHp) return { state, finished: false };
      used.push(action.cardId);
      const before = tgt.hp;
      tgt.hp = Math.min(tgt.maxHp, tgt.hp + eff.power);
      s.log.push(`${me.username} played ${def.name} — ${tgt.name} recovered ${tgt.hp - before} HP.`);
    } else if (eff.kind === "revive") {
      // Target must be a card that has actually fallen. An aimed drop on a
      // living card is refused, not redirected to whoever happens to be dead.
      const t = me.fighters[wanted];
      const tgt = explicit ? t : me.fighters.find((f) => f.hp <= 0);
      if (!tgt || tgt.hp > 0) return { state, finished: false };
      used.push(action.cardId);
      tgt.hp = Math.max(1, Math.round((tgt.maxHp * eff.power) / 100));
      s.log.push(`${me.username} played ${def.name} — ${tgt.name} rose again at ${tgt.hp} HP.`);
    } else if (eff.kind === "mend") {
      const wounded = me.fighters.some((f) => f.hp > 0 && f.hp < f.maxHp);
      if (!wounded) return { state, finished: false };
      used.push(action.cardId);
      let healed = 0;
      for (const f of me.fighters) {
        if (f.hp > 0 && f.hp < f.maxHp) {
          const b = f.hp;
          f.hp = Math.min(f.maxHp, f.hp + eff.power);
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
      me.focusMult = eff.power;
      s.log.push(`${me.username} played ${def.name} — the next strike will hit far harder.`);
    } else {
      return { state, finished: false };
    }

    // Playing a support card passes the turn, so it costs tempo.
    s.turn = foe.userId;
    s.round += 1;
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
      } else {
        s.log.pop();
        return { state, finished: false };
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
