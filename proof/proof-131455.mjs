// Proof for openclaw PR #131455: subagent control (steer) dispatch must use the
// run's retained Gateway owner binding — never the registry-global resolver
// that a replacement Gateway overwrites on activation, and never the generic
// callGateway transport once the owner is stale.
//
// Everything in the dispatch path is the real production module:
//   - real createGatewayInstanceRuntime (real isAvailable()/close() lifecycle,
//     real self-registration in the process-global recovery slot)
//   - real kernel context-resolver fence, the exact pattern from
//     src/gateway/server-kernel-request-runtime.ts
//     (`isAvailable() ? context : undefined`)
//   - real activateSubagentRegistry for BOTH Gateways (B's activation is the
//     production replacement path that overwrites the registry-global resolver)
//   - real bindGatewayContextResolver, mirroring the registration-time binding
//     in subagent-registry-run-launch.ts
//   - real steerControlledSubagentRun dispatch path
// Only the final network transports are recording stubs: each Gateway's
// dispatchAgent/waitForAgent, and the generic callGateway transport (via a
// loader hook that records and refuses the call).
//
// Usage: node --import tsx /tmp/proof-131455.mjs <openclaw-worktree-root>

import module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.argv[2];
if (!root || !fs.existsSync(path.join(root, "src/agents/subagents/registry/subagent-registry.ts"))) {
  console.error("usage: node --import tsx /tmp/proof-131455.mjs <openclaw-worktree-root>");
  process.exit(2);
}

// Enable the registry's built-in test handle (run seeding/reset) and steer
// rate-limit bypass; both are keyed off this env in the production modules.
process.env.VITEST = "true";

// Redirect all OpenClaw state/config to a scratch dir: the proof must never
// touch the operator's real ~/.openclaw state database or config.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-131455-"));
process.env.OPENCLAW_STATE_DIR = path.join(workDir, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(workDir, "openclaw.json");

// Recording shim for the generic callGateway transport. Re-exports the real
// module; only callGateway is replaced (final network transport stub).
const shimPath = new URL("./proof-131455-call-shim.mjs", import.meta.url);
fs.writeFileSync(
  shimPath,
  `export * from ${JSON.stringify(path.join(root, "src/gateway/call.ts"))};
export async function callGateway(request) {
  (globalThis.__PROOF_GENERIC_GATEWAY_CALLS__ ??= []).push({ method: request?.method });
  throw new Error("proof: generic callGateway transport reached (no live gateway)");
}
`,
);
module.register("./proof-131455-hook.mjs", import.meta.url);

const { createGatewayInstanceRuntime } = await import(
  path.join(root, "src/gateway/server-instance-runtime.ts")
);
const { registerGatewayRecoveryRuntime, getGatewayRecoveryRuntime } = await import(
  path.join(root, "src/gateway/server-recovery-runtime-context.ts")
);
const { bindGatewayContextResolver, getGatewayContextResolver } = await import(
  path.join(root, "src/plugins/runtime/gateway-request-scope.ts")
);
const { activateSubagentRegistry } = await import(
  path.join(root, "src/agents/subagents/registry/subagent-registry.ts")
);
const { setSubagentRegistryDepsForTest } = await import(
  path.join(root, "src/agents/subagents/registry/subagent-registry-deps.ts")
);
const { steerControlledSubagentRun } = await import(
  path.join(root, "src/agents/subagents/registry/subagent-control-messaging.ts")
);

const registryApi = globalThis[Symbol.for("openclaw.subagentRegistryTestApi")];
if (!registryApi) {
  console.error("FATAL: subagent registry test handle missing");
  process.exit(2);
}

// Keep registry persistence in-process only (no SQLite writes); unrelated to
// the dispatch routing under test.
setSubagentRegistryDepsForTest({
  persistSubagentRunsToDisk: () => {},
  persistSubagentRunsToDiskOrThrow: () => {},
  restoreSubagentRunsFromDisk: () => 0,
});

const cfg = { session: { store: path.join(workDir, "sessions.json") } };
const controller = {
  controllerSessionKey: "agent:main:main",
  callerSessionKey: "agent:main:main",
  callerIsSubagent: false,
  controlScope: "children",
};

function makeEntry(name) {
  return {
    runId: `run-proof-${name}-old`,
    childSessionKey: `agent:main:subagent:proof-${name}`,
    controllerSessionKey: "agent:main:main",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "old direction",
    cleanup: "keep",
    createdAt: Date.now() - 5_000,
    startedAt: Date.now() - 4_000,
    execution: { status: "running", startedAt: Date.now() - 4_000 },
  };
}

function makeTransport(label, calls, runId) {
  return {
    dispatchAgent: async () => {
      calls[`${label}.dispatchAgent`] += 1;
      return { runId };
    },
    waitForAgent: async () => {
      calls[`${label}.waitForAgent`] += 1;
      return {};
    },
  };
}

function makeGatewayInstance(label, calls, runId) {
  const context = {};
  const instance = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => ({}),
    isDispatchAvailable: () => true,
  });
  const transport = makeTransport(label, calls, runId);
  context.recoveryRuntime = {
    ...instance.recovery,
    dispatchAgent: transport.dispatchAgent,
    waitForAgent: transport.waitForAgent,
  };
  // Exact production kernel fence (src/gateway/server-kernel-request-runtime.ts):
  // the resolver stops resolving the moment the instance becomes unavailable.
  context.resolveGatewayContext = () => (instance.isAvailable() ? context : undefined);
  return { context, instance, transport };
}

async function runScenario(name, { closeOwnerBeforeSteer }) {
  registryApi.resetSubagentRegistryForTests({ persist: false });

  const calls = {
    "A.dispatchAgent": 0,
    "A.waitForAgent": 0,
    "B.dispatchAgent": 0,
    "B.waitForAgent": 0,
  };
  const entry = makeEntry(name);

  // Gateway A activates the registry and owns it.
  const gatewayA = makeGatewayInstance("A", calls, `run-proof-${name}-new-A`);
  activateSubagentRegistry(gatewayA.context.resolveGatewayContext);
  registryApi.addSubagentRunForTests(entry);
  // Mirror the registration-time binding (subagent-registry-run-launch.ts):
  // the run retains the fenced resolver of the Gateway that registered it.
  bindGatewayContextResolver(entry, gatewayA.context.resolveGatewayContext);

  // Replacement Gateway B: takes the process-global recovery slot AND runs the
  // real production activation, which overwrites the registry-global resolver.
  const gatewayB = makeGatewayInstance("B", calls, `run-proof-${name}-new-B`);
  const releaseB = registerGatewayRecoveryRuntime(gatewayB.context.recoveryRuntime);
  activateSubagentRegistry(gatewayB.context.resolveGatewayContext);
  const bindingKeptOnA =
    getGatewayContextResolver(entry) === gatewayA.context.resolveGatewayContext;

  if (closeOwnerBeforeSteer) {
    // Real production close path: flips isAvailable(), so the kernel fence
    // above starts returning undefined while the run still belongs to A.
    gatewayA.instance.close();
  }

  globalThis.__PROOF_GENERIC_GATEWAY_CALLS__ = [];
  const globalIsB =
    getGatewayRecoveryRuntime()?.dispatchAgent === gatewayB.transport.dispatchAgent;
  const result = await steerControlledSubagentRun({
    cfg,
    controller,
    entry,
    message: "proof steer",
  });
  const genericCalls = globalThis.__PROOF_GENERIC_GATEWAY_CALLS__.length;

  releaseB();
  gatewayA.instance.close();
  gatewayB.instance.close();
  return { result, calls, genericCalls, globalIsB, bindingKeptOnA };
}

function printScenario(title, outcome) {
  console.log(`\n[${title}]`);
  console.log(`  steer result: ${JSON.stringify(outcome.result)}`);
  console.log(
    `  dispatch counters: A.dispatchAgent=${outcome.calls["A.dispatchAgent"]} ` +
      `A.waitForAgent=${outcome.calls["A.waitForAgent"]} ` +
      `B.dispatchAgent=${outcome.calls["B.dispatchAgent"]} ` +
      `B.waitForAgent=${outcome.calls["B.waitForAgent"]} ` +
      `genericTransport=${outcome.genericCalls}`,
  );
  console.log(
    `  run binding after B activation: ${outcome.bindingKeptOnA ? "still A (correct)" : "stolen by B"}`,
  );
}

console.log("=== proof-131455: subagent control dispatch vs Gateway replacement ===");
console.log(`worktree: ${root}`);

let failures = 0;

// Scenario 1: owner Gateway A is alive; replacement B holds the process-global
// runtime AND activated the registry. Steer must stay on A's retained binding.
{
  const outcome = await runScenario("active-owner", { closeOwnerBeforeSteer: false });
  printScenario(
    "scenario 1: run bound to A; replacement B global + B activated the registry",
    outcome,
  );
  const stayedOnOwner =
    outcome.result.status === "accepted" &&
    outcome.calls["A.dispatchAgent"] === 1 &&
    outcome.calls["A.waitForAgent"] >= 1 &&
    outcome.calls["B.dispatchAgent"] === 0 &&
    outcome.calls["B.waitForAgent"] === 0 &&
    outcome.genericCalls === 0;
  if (stayedOnOwner) {
    console.log("  PASS: steer dispatch stayed on the run's bound owner Gateway A");
  } else if (outcome.calls["B.dispatchAgent"] > 0 || outcome.calls["B.waitForAgent"] > 0) {
    console.log(
      "  FAIL: steer for an A-bound run was dispatched to replacement Gateway B (split-brain)",
    );
    failures += 1;
  } else if (outcome.genericCalls > 0) {
    console.log("  FAIL: steer fell through to the generic callGateway transport");
    failures += 1;
  } else {
    console.log(`  FAIL: unexpected outcome (status=${outcome.result.status})`);
    failures += 1;
  }
}

// Scenario 2: owner Gateway A closed through the real production close path;
// replacement B still global. Steer must fail closed.
{
  const outcome = await runScenario("stale-owner", { closeOwnerBeforeSteer: true });
  printScenario(
    "scenario 2: registry owner A closed (real instance close); replacement B still global",
    outcome,
  );
  const allZero =
    outcome.calls["A.dispatchAgent"] === 0 &&
    outcome.calls["A.waitForAgent"] === 0 &&
    outcome.calls["B.dispatchAgent"] === 0 &&
    outcome.calls["B.waitForAgent"] === 0 &&
    outcome.genericCalls === 0;
  const failedClosed =
    outcome.result.status === "error" &&
    String(outcome.result.error ?? "").includes("stale") &&
    allZero;
  if (failedClosed) {
    console.log(
      "  PASS: stale owner failed closed (visible error; zero dispatch on A, B, and the generic transport)",
    );
  } else if (outcome.calls["B.dispatchAgent"] > 0 || outcome.calls["B.waitForAgent"] > 0) {
    console.log(
      "  FAIL: stale owner binding fell through to replacement Gateway B (split-brain); " +
        `steer status=${outcome.result.status}`,
    );
    failures += 1;
  } else if (outcome.genericCalls > 0) {
    console.log("  FAIL: stale owner dispatch reached the generic callGateway transport");
    failures += 1;
  } else {
    console.log(
      `  FAIL: unexpected outcome (status=${outcome.result.status} error=${outcome.result.error ?? "none"})`,
    );
    failures += 1;
  }
}

fs.rmSync(workDir, { recursive: true, force: true });
console.log(`\nRESULT: ${failures === 0 ? "PASS" : `FAIL (${failures} failing scenario(s))`}`);
process.exitCode = failures === 0 ? 0 : 1;
