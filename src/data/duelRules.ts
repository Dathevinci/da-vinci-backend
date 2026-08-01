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

import { CARDS, CardRarity } from "./cardCatalog";

export const DECK_SIZE = 5;

// Walking out of a staked duel costs you the pot AND a fine on top, paid to the
// player whose time you wasted. Without the fine, quitting is free the moment
// you're losing — the stake was already gone either way — so the whole point is
// that the fine is money you would still have if you had played it out.
export const FORFEIT_FINE_PERCENT = 25;
export function forfeitFine(stake: number): number {
  return Math.ceil((stake * FORFEIT_FINE_PERCENT) / 100);
}

// Rarity is the whole stat line. This is what finally makes a Legendary pull
// matter in play and not just in the binder.
export const CARD_STATS: Record<CardRarity, { hp: number; atk: number }> = {
  common:    { hp: 10, atk: 3 },
  rare:      { hp: 14, atk: 5 },
  epic:      { hp: 20, atk: 8 },
  legendary: { hp: 28, atk: 12 },
  event:     { hp: 24, atk: 10 },
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
}

export interface DuelState {
  a: Side;   // challenger
  b: Side;   // opponent
  turn: string;      // userId whose move it is
  log: string[];
  round: number;
}

export function buildFighter(cardId: string, foil: boolean): Fighter | null {
  const def = CARDS[cardId];
  // Support cards are played, never fielded — they have no stat line, so
  // letting one into a deck would field a fighter with undefined HP.
  if (!def || def.support) return null;
  const base = CARD_STATS[def.rarity];
  const mult = foil ? FOIL_MULT : 1;
  const hp = Math.round(base.hp * mult);
  return {
    cardId,
    name: def.name,
    rarity: def.rarity,
    maxHp: hp,
    hp,
    atk: Math.round(base.atk * mult),
    foil,
  };
}

export function makeSide(
  userId: string,
  username: string,
  deck: string[],
  foils: Set<string>,
  items: Record<string, number>
): Side {
  const fighters = deck
    .map((id) => buildFighter(id, foils.has(id)))
    .filter((f): f is Fighter => !!f);
  // active = -1 means NOBODY is on the field yet. The arena opens empty and
  // your first move is genuinely choosing who walks in, instead of the engine
  // having silently already picked for you.
  return { userId, username, fighters, active: -1, items, shield: false, focus: false, usedSupports: [] };
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
    | { type: "support"; cardId: string; target?: number },
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
    const used: string[] = me.usedSupports || (me.usedSupports = []);
    if (used.includes(action.cardId)) return { state, finished: false };

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
    const dealt = Math.max(1, Math.round(dmg));
    theirs.hp = Math.max(0, theirs.hp - dealt);
    s.log.push(`${mine.name} struck ${theirs.name} for ${dealt}.`);

    if (theirs.hp === 0) {
      s.log.push(`${theirs.name} fell.`);
      // Their field empties. They pick who steps up next, on their turn.
      foe.active = -1;
    }
  }

  // Win check
  if (sideDefeated(foe)) {
    s.log.push(`${me.username} wins the duel.`);
    return { state: s, finished: true, winnerId: me.userId };
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
