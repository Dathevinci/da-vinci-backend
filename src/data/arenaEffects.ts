// ═══════════════════════════════════════════════════════════════════════════
// ARENA EFFECTS — cosmetics that change the DUEL BOARD, not your profile.
//
// Bought with Arise Points like anything else in the shop, but they behave
// differently in one important way: an arena effect is only felt if BOTH
// players agree to play with effects on. It changes the board for the two of
// them, so one person shouldn't be able to impose it.
//
// GRADE DRIVES INTENSITY. A higher grade doesn't just look different, it
// applies MORE of itself: `intensity` is the 0-1 strength the client renders
// at, so an S-grade wash is a tint and an SSS takes the whole arena.
//
// Nothing here touches combat maths. Duels are decided by cards, levels and
// choices — an arena effect that changed damage would mean the richer player
// wins, which is a different game and a worse one.
// ═══════════════════════════════════════════════════════════════════════════

export type ArenaGrade = "A" | "S" | "SS" | "SSS";

export interface ArenaEffectDef {
  id: string;
  name: string;
  grade: ArenaGrade;
  price: number;          // Arise Points
  /** 0-1. How completely the effect takes over the board. */
  intensity: number;
  /** Base hue the client themes the board with. */
  hue: number;
  blurb: string;
}

/** Rarer effects assert themselves harder. This is the whole grade ladder. */
export const GRADE_INTENSITY: Record<ArenaGrade, number> = {
  A: 0.35,
  S: 0.55,
  SS: 0.78,
  SSS: 1,
};

export const ARENA_EFFECTS: Record<string, ArenaEffectDef> = {
  arena_noir: {
    id: "arena_noir",
    name: "Noir",
    grade: "SSS",
    price: 14000,
    intensity: GRADE_INTENSITY.SSS,
    hue: 0,
    blurb:
      "The arena drains to black. Colour leaves the board entirely — cards, cards' art, both sides' lights — and only the strikes bring any of it back. Everything you can see is a shadow of itself until someone lands a hit.",
  },
  arena_voidrift: {
    id: "arena_voidrift",
    name: "Void Rift",
    grade: "SSS",
    price: 12500,
    intensity: GRADE_INTENSITY.SSS,
    hue: 275,
    blurb:
      "A tear opens under the battlefield and the floor falls away into it. The board sits over nothing, lit from below by something that is not light.",
  },
  arena_stormfront: {
    id: "arena_stormfront",
    name: "Stormfront",
    grade: "SS",
    price: 7200,
    intensity: GRADE_INTENSITY.SS,
    hue: 210,
    blurb: "Rain across the board and sheet lightning behind the clash. Every strike lands into thunder.",
  },
  arena_emberfall: {
    id: "arena_emberfall",
    name: "Emberfall",
    grade: "SS",
    price: 6800,
    intensity: GRADE_INTENSITY.SS,
    hue: 22,
    blurb: "Ash and rising embers. The arena reads as the last few minutes of somewhere that used to stand.",
  },
  arena_tidewash: {
    id: "arena_tidewash",
    name: "Tidewash",
    grade: "S",
    price: 3400,
    intensity: GRADE_INTENSITY.S,
    hue: 190,
    blurb: "Cold water light moving over the board, as though the duel were happening a long way down.",
  },
  arena_goldenhour: {
    id: "arena_goldenhour",
    name: "Golden Hour",
    grade: "A",
    price: 1600,
    intensity: GRADE_INTENSITY.A,
    hue: 42,
    blurb: "Low warm sun across the arena. The cheapest way to stop the board looking like a spreadsheet.",
  },
};

export function arenaEffect(id?: string | null): ArenaEffectDef | null {
  return (id && ARENA_EFFECTS[id]) || null;
}

const GRADE_ORDER: ArenaGrade[] = ["A", "S", "SS", "SSS"];

/**
 * Which effect a duel actually plays under.
 *
 * Both sides must have opted in — an arena effect changes the board for BOTH
 * players, so it can't be imposed by one. When both bring one, the RARER wins:
 * the alternative is picking the challenger's every time, which quietly makes
 * the opponent's purchase worthless.
 */
export function resolveArena(
  aOptedIn: boolean, aEffect: string | null | undefined,
  bOptedIn: boolean, bEffect: string | null | undefined
): string | null {
  if (!aOptedIn || !bOptedIn) return null;
  const a = arenaEffect(aEffect);
  const b = arenaEffect(bEffect);
  if (!a) return b?.id ?? null;
  if (!b) return a.id;
  return GRADE_ORDER.indexOf(b.grade) > GRADE_ORDER.indexOf(a.grade) ? b.id : a.id;
}
