// proof-131464.mjs — drives the real A2aTaskStore from a repo checkout.
// Usage: node --import tsx proof-131464.mjs <repo-root>
// Scenarios:
//   [real-time]       late final from an already-terminal older task
//   [time-compressed] Date.now shifted: hung-task sweep + terminal retention
//   [deadline-first]  final delivery is the first store op after the deadline
//   [timer-driven]    captured setTimeout: idle task fails with no store access
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.argv[2];
if (!repoRoot) {
  console.error("usage: node --import tsx proof-131464.mjs <repo-root>");
  process.exit(2);
}
console.log(`repo: ${repoRoot}`);

const { A2aTaskStore } = await import(
  pathToFileURL(path.join(repoRoot, "extensions/a2a/src/task-store.ts")).href
);

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures += 1;
  }
}

const store = new A2aTaskStore();
const hasCompleteTask = typeof store.completeTask === "function";
console.log(
  `delivery API detected: ${hasCompleteTask ? "completeTask (bound to originating task)" : "completeNext (conversation FIFO head)"}`,
);

// ---------------------------------------------------------------- S1 real-time
console.log("\n[real-time] late final reply from an already-terminal older task");
const t1 = store.create("ctx-a");
store.start(t1.id);
store.fail(t1.id, new Error("older turn failed"));
const t2 = store.create("ctx-a");
store.start(t2.id);

if (hasCompleteTask) {
  const delivered = store.completeTask(t1.id, "stale reply from T1");
  check(delivered === undefined, "T1's late reply is dropped instead of stored", "completeTask returned undefined");
} else {
  store.completeNext("ctx-a", "stale reply from T1");
}
check(
  t1.status.state === "TASK_STATE_FAILED" && t1.artifacts.length === 0,
  "T1 keeps its terminal state unchanged",
  `state=${t1.status.state} artifacts=${t1.artifacts.length}`,
);
const t2Artifact = t2.artifacts[0]?.parts?.[0]?.text;
check(
  t2.status.state !== "TASK_STATE_COMPLETED" && t2Artifact === undefined,
  "T2 is not completed by T1's late reply",
  `state=${t2.status.state} artifact=${JSON.stringify(t2Artifact)}`,
);
if (hasCompleteTask) {
  store.completeTask(t2.id, "fresh reply for T2");
} else {
  store.completeNext("ctx-a", "fresh reply for T2");
}
const t2Final = t2.artifacts[0]?.parts?.[0]?.text;
check(
  t2.status.state === "TASK_STATE_COMPLETED" && t2Final === "fresh reply for T2",
  "T2 completes with its own reply text",
  `state=${t2.status.state} artifact=${JSON.stringify(t2Final)}`,
);

// ------------------------------------------------------- S2/S3 time-compressed
console.log("\n[time-compressed] Date.now shifted: hung task sweep + terminal retention");
const realNow = Date.now;
const base = 1_800_000_000_000;
Date.now = () => base;
const stuck = store.create("ctx-stuck");
store.start(stuck.id);

Date.now = () => base + 61 * 60 * 1000;
store.create("ctx-unrelated"); // crossing store op triggers the sweep
check(
  stuck.status.state === "TASK_STATE_FAILED",
  "hung task becomes TASK_STATE_FAILED after 1h without a status change",
  `state=${stuck.status.state}`,
);

Date.now = () => base + 61 * 60 * 1000 + 25 * 60 * 60 * 1000;
store.create("ctx-unrelated-2");
check(
  store.get(stuck.id) === undefined,
  "task no longer occupies the store after terminal retention (24h)",
  store.get(stuck.id) ? `still tracked: ${stuck.status.state}` : "reaped",
);

console.log("\n[deadline-first] final delivery is the first store operation after the deadline");
Date.now = () => base;
const lone = store.create("ctx-lone");
store.start(lone.id);
Date.now = () => base + 61 * 60 * 1000;
// No create/get crosses the deadline: the delivery itself must enforce it.
if (hasCompleteTask) {
  const delivered = store.completeTask(lone.id, "late reply after idle hour");
  check(delivered === undefined, "post-deadline delivery is rejected", "completeTask returned undefined");
} else {
  store.completeNext("ctx-lone", "late reply after idle hour");
}
check(
  lone.status.state === "TASK_STATE_FAILED" && lone.artifacts.length === 0,
  "idle task is failed, not completed, by the first post-deadline delivery",
  `state=${lone.status.state} artifacts=${lone.artifacts.length}`,
);
Date.now = realNow;

// ---------------------------------------------------------------- S4 timer-driven
console.log("\n[timer-driven] captured setTimeout: idle task fails with no store access at all");
const captured = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (cb, ms, ...args) => {
  const handle = realSetTimeout(() => {}, 0);
  handle.unref();
  captured.push({ cb, ms, handle, cleared: false });
  return handle;
};
globalThis.clearTimeout = (h) => {
  for (const entry of captured) {
    if (entry.handle === h) {
      entry.cleared = true;
    }
  }
  realClearTimeout(h);
};
try {
  const idle = store.create("ctx-idle");
  const expiryTimers = captured.filter((e) => !e.cleared);
  check(
    expiryTimers.length === 1 && expiryTimers[0].ms === 60 * 60 * 1000,
    "task owns a 1h expiry timer at creation",
    `timers=${expiryTimers.length} ms=${expiryTimers[0]?.ms}`,
  );
  if (expiryTimers.length > 0) {
    expiryTimers[0].cb(); // fire the deadline: no store call involved
  }
  check(
    idle.status.state === "TASK_STATE_FAILED",
    "idle task fails on its own timer without any store access",
    `state=${idle.status.state}`,
  );

  captured.length = 0;
  const settled = store.create("ctx-settled");
  if (hasCompleteTask) {
    store.completeTask(settled.id, "done");
    const live = captured.filter((e) => !e.cleared);
    check(
      live.length === 0 && settled.status.state === "TASK_STATE_COMPLETED",
      "terminal transition disarms the expiry timer",
      `liveTimers=${live.length} state=${settled.status.state}`,
    );
  } else {
    check(false, "terminal transition disarms the expiry timer", "completeTask API missing");
  }
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

store.stop();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
