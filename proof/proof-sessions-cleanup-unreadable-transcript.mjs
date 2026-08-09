// Proof: `sessions cleanup --fix-missing` classifies "transcript read failed"
// as "transcript missing" and deletes the session entry. A session whose
// transcript holds 3 message rows — one torn by a crashed write (event_json
// truncated) — is fed to the REAL runSessionsCleanup with a real temp store
// and real per-agent SQLite. The parse-all probe (session-accessor.sqlite-read
// .ts JSON.parse per row) throws on the torn row; on main the catch returns
// false and the whole session is pruned, orphaning the readable messages.
// Run: node --import tsx scripts/proof-sessions-cleanup-unreadable-transcript.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSessionsCleanup } from "../src/config/sessions/cleanup-service.ts";
import { loadSessionEntry, replaceSessionEntry } from "../src/config/sessions/session-accessor.ts";
import { replaceSqliteTranscriptEvents } from "../src/config/sessions/session-accessor.sqlite.ts";
import { resolveSqliteTargetFromSessionStorePath } from "../src/config/sessions/session-sqlite-target.ts";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../src/state/openclaw-agent-db.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-missing-proof-"));
const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");

const messageEvent = (id, content) => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "user", content },
});

// Victim session: 3 message rows, middle one torn by a crashed write.
await replaceSessionEntry(
  { sessionKey: "agent:main:alice", storePath },
  { sessionId: "alice-session", updatedAt: Date.now() },
);
await replaceSqliteTranscriptEvents(
  { sessionKey: "agent:main:alice", sessionId: "alice-session", storePath },
  [messageEvent("m1", "hello"), messageEvent("m2", "from"), messageEvent("m3", "alice")],
);
// Control session: fully healthy transcript — must survive every run.
await replaceSessionEntry(
  { sessionKey: "agent:main:bob", storePath },
  { sessionId: "bob-session", updatedAt: Date.now() },
);
await replaceSqliteTranscriptEvents(
  { sessionKey: "agent:main:bob", sessionId: "bob-session", storePath },
  [messageEvent("m1", "bob is fine")],
);

// Tear alice's middle row: the row exists but its JSON is truncated, so the
// probe's parse-all read throws — one deterministic member of the failure
// class "transcript unreadable after the store loaded" (SQLITE_BUSY/EACCES
// against a live gateway are the transient cousins).
const dbPath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
const database = openOpenClawAgentDatabase({ agentId: "main", path: dbPath });
database.db
  .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = ?")
  .run("alice-session", 1);
const intactRows = database.db
  .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
  .get("alice-session").count;
console.log(`alice transcript rows on disk: ${intactRows} (2 fully readable, 1 torn)`);

const result = await runSessionsCleanup({
  cfg: {},
  opts: { fixMissing: true },
  targets: [{ agentId: "main", storePath }],
});
const summary = result.appliedSummaries?.[0] ?? result.previewResults?.[0]?.summary ?? {};
console.log(
  `cleanup summary: beforeCount=${summary.beforeCount} afterCount=${summary.afterCount} missing=${summary.missing}`,
);

const alice = loadSessionEntry({ sessionKey: "agent:main:alice", storePath });
const bob = loadSessionEntry({ sessionKey: "agent:main:bob", storePath });
console.log(`alice entry after cleanup: ${alice ? "KEPT" : "DELETED"}`);
console.log(`bob entry after cleanup:   ${bob ? "KEPT" : "DELETED"}`);

closeOpenClawAgentDatabasesForTest();
fs.rmSync(tempDir, { recursive: true, force: true });

if (!alice && bob) {
  console.log(
    "FAIL: one torn row made --fix-missing delete a session whose transcript still holds 2 readable messages — the session vanished from routing/listing while its data stayed on disk (data loss)",
  );
  process.exitCode = 1;
} else if (alice && bob) {
  console.log(
    "PASS: unreadable transcript treated as unavailable, not missing — entry kept and a warning was logged; healthy sessions unaffected",
  );
} else {
  console.log(`UNEXPECTED: alice=${JSON.stringify(alice)} bob=${JSON.stringify(bob)}`);
  process.exitCode = 1;
}
