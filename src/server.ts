import app from "./app";
import { env } from "./config/env";
import { backfillLegendaryPrints } from "./lib/printBackfill";
import { pruneOrphanedShowcases } from "./lib/showcaseBackfill";
import { refundWipedCards } from "./lib/cardResetRefund";
import { resetCardProgress } from "./lib/cardResetProgress";

const PORT = env.PORT || 5000;

app.listen(PORT as number, "0.0.0.0", () => {
  console.log(`🚀 Server running in ${env.NODE_ENV} mode on port ${PORT}`);
  // After listen, never blocking it: existing legendary copies get their
  // print identities minted. Idempotent — see printBackfill.ts.
  void backfillLegendaryPrints();
  // Clears showcase pins for cards their owner no longer has. Idempotent —
  // see showcaseBackfill.ts.
  void pruneOrphanedShowcases();
  // Pays everyone out for the tiers about to be wiped, THEN clears the
  // progress the old card game left behind. Chained, never fired side by
  // side: both touch the same users and the refund is the one that must land
  // first — clearing a profile before paying for it would be unrecoverable.
  // Both idempotent; see cardResetRefund.ts and cardResetProgress.ts.
  void refundWipedCards().then(() => resetCardProgress());
});
