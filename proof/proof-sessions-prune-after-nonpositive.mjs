// Proof: a plugin-supplied `maintenanceConfig.pruneAfterMs: 0` bypasses the
// openclaw.json duration schema (the plugin SDK forwards raw numbers) and
// reaches pruneStaleEntries, where cutoff = Date.now() - 0 = now — so one
// maintenance pass deletes EVERY session entry with a past updatedAt.
// Run: node --import tsx scripts/proof-sessions-prune-after-nonpositive.mjs
import {
  normalizeResolvedMaintenanceConfigInput,
  pruneStaleEntries,
} from "../src/config/sessions/store-maintenance.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

// What a plugin passes via patchSessionEntry({ maintenanceConfig: ... }): the
// plugin SDK path (plugin-sdk/session-store-runtime.ts) forwards the raw
// number, without the zod positive-duration guard that openclaw.json gets.
const maintenance = normalizeResolvedMaintenanceConfigInput({
  mode: "enforce",
  pruneAfterMs: 0,
  maxEntries: 100,
  resetArchiveRetentionMs: null,
  maxDiskBytes: null,
  highWaterBytes: null,
});
console.log("resolved pruneAfterMs:", maintenance.pruneAfterMs);

// Two live sessions: one stale (31d old), one fresh (1h old).
const store = {
  "agent:main:user-alice": { sessionId: "sess-alice", updatedAt: now - 31 * DAY_MS },
  "agent:main:user-bob": { sessionId: "sess-bob", updatedAt: now - 60 * 60 * 1000 },
};

// The exact call the enforce-mode maintenance pass makes
// (store-maintenance-operations.ts / session-accessor.sqlite-maintenance.ts).
const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, { log: false });

const remaining = Object.keys(store);
console.log(`entries before: 2 | pruned: ${pruned} | remaining: ${remaining.length}`);

if (pruned === 2 && remaining.length === 0) {
  console.log(
    "FAIL: pruneAfterMs=0 deleted every session entry — live sessions vanished from routing/listing (data loss)",
  );
  process.exitCode = 1;
} else if (pruned === 0 && remaining.length === 2) {
  console.log("PASS: non-positive pruneAfterMs disables age pruning; both sessions kept");
} else {
  console.log(`UNEXPECTED: pruned=${pruned} remaining=${remaining.length}`);
  process.exitCode = 1;
}
