// Server-side Ko-fi money → Arise Points rules. The webhook grants AP based on
// the amount PAID (Ko-fi reports it), so no per-item code wiring is needed — a
// £5 shop item and a £5 tip both map to the same bundle. Keep the price/AP pairs
// in sync with the frontend display list (src/lib/kofiBundles.ts).

export interface ApBundle {
  price: number; // in the Ko-fi account currency (GBP)
  ap: number;
}

// Sorted ascending by price. Bigger bundles give bonus AP.
export const AP_BUNDLES: ApBundle[] = [
  { price: 2, ap: 1000 },
  { price: 5, ap: 3000 },
  { price: 10, ap: 7000 },
  { price: 20, ap: 16000 },
];

// For amounts that don't land on a bundle, grant a flat rate per currency unit
// so every payment still credits something.
export const AP_FLAT_RATE = 400; // AP per £1

// Any payment at/above this (in account currency) earns the Supporter badge.
export const SUPPORTER_MIN_AMOUNT = 1;

// AP a recurring membership grants each cycle when the tier amount is unknown.
// (Normally the amount is present and the bundle logic handles it.)
export const MEMBERSHIP_FALLBACK_AP = 1000;

// Ko-fi sends this token in every webhook payload; set it in Render env as
// KOFI_VERIFICATION_TOKEN (copy it from Ko-fi → Settings → Webhooks/API).
export function kofiToken(): string {
  return process.env.KOFI_VERIFICATION_TOKEN || "";
}

// Resolve the AP to grant for a paid amount.
export function apForAmount(amount: number): number {
  let best = 0;
  for (const b of AP_BUNDLES) {
    if (amount + 1e-6 >= b.price && b.ap > best) best = b.ap;
  }
  if (best > 0) return best;
  return Math.max(0, Math.round(amount * AP_FLAT_RATE));
}
