import app from "./app";
import { env } from "./config/env";
import { backfillLegendaryPrints } from "./lib/printBackfill";
import { pruneOrphanedShowcases } from "./lib/showcaseBackfill";

const PORT = env.PORT || 5000;

app.listen(PORT as number, "0.0.0.0", () => {
  console.log(`🚀 Server running in ${env.NODE_ENV} mode on port ${PORT}`);
  // After listen, never blocking it: existing legendary copies get their
  // print identities minted. Idempotent — see printBackfill.ts.
  void backfillLegendaryPrints();
  // Clears showcase pins for cards their owner no longer has. Idempotent —
  // see showcaseBackfill.ts.
  void pruneOrphanedShowcases();
});
