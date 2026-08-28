// Proof: memory-core forget rewrites MEMORY.md after the index purge commits.
// Scenario 1: if that rewrite fails mid-write (ENOSPC), the original long-term
//   memory file must survive.
// Scenario 2: if directory ACLs reject the temp-file replacement (EACCES) while
//   the target file itself is writable, the rewrite must still complete through
//   the checked in-place fallback (the pre-atomic direct write succeeded there).
// Run: node --import tsx scripts/proof-memory-forget-atomic.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-forget-proof-")),
);
process.env.OPENCLAW_STATE_DIR = stateDir;

const { configureMemoryCoreDreamingStateForTests } = await import(
  "../extensions/memory-core/src/test-helpers.ts"
);
const { upsertSessionEntry, deleteSessionEntry } = await import(
  "openclaw/plugin-sdk/session-store-runtime"
);
const { recordMemoryEntryOrigins } = await import(
  "../extensions/memory-core/src/memory-entry-origins.ts"
);
const { forgetMemoryEntries } = await import("../extensions/memory-core/src/memory-forget.ts");

await configureMemoryCoreDreamingStateForTests();
const cfg = {
  agents: { defaults: { workspace: undefined }, list: [{ id: "main", default: true }] },
};

let failures = 0;

async function seedScenario(sessionId) {
  const workspaceDir = path.join(stateDir, `workspace-${sessionId}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  cfg.agents.defaults.workspace = workspaceDir;
  const sessionKey = `agent:main:${sessionId}`;
  await upsertSessionEntry({
    agentId: "main",
    sessionKey,
    entry: { sessionId, updatedAt: 1_000 },
  });
  const entryKey = `${sessionId}-entry`;
  recordMemoryEntryOrigins({
    agentId: "main",
    origins: [
      {
        entryKey,
        agentId: "main",
        sessionId,
        sessionKey,
        originClass: "owner",
        observedAt: 1_000,
      },
    ],
  });
  const memoryPath = path.join(workspaceDir, "MEMORY.md");
  const originalContent =
    "# Long-Term Memory\n" +
    "Curated operator fact that must survive.\n" +
    `<!-- openclaw-memory-promotion:${entryKey} -->\n` +
    "- Archived secret to forget.\n";
  await fs.writeFile(memoryPath, originalContent);
  await deleteSessionEntry({
    agentId: "main",
    sessionKey,
    expectedSessionId: sessionId,
    archiveTranscript: true,
  });
  return { workspaceDir, memoryPath, originalContent };
}

// Fault injection covering both rewrite implementations:
// - pre-fix main: the loop calls fs.writeFile(targetPath, content) directly.
// - post-fix: fs-safe writes the temp blob via fs.open(tempPath, "wx") +
//   FileHandle.writeFile, so the temp open is hooked instead.
const realWriteFile = fs.writeFile.bind(fs);
const realOpen = fs.open.bind(fs);
function installMidWriteEnospc(memoryPath) {
  fs.writeFile = async (target, content, options) => {
    if (typeof target === "string" && target.includes("MEMORY.md")) {
      const text = typeof content === "string" ? content : String(content);
      await realWriteFile(target, text.slice(0, Math.ceil(text.length / 2)), options);
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return await realWriteFile(target, content, options);
  };
  fs.open = async (target, ...rest) => {
    if (typeof target === "string" && target.startsWith(`${memoryPath}.forget.`)) {
      const handle = await realOpen(target, ...rest);
      await handle.writeFile("Curated ope");
      await handle.close();
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return await realOpen(target, ...rest);
  };
}
function installTempReplacementEacces(memoryPath) {
  fs.open = async (target, ...rest) => {
    if (typeof target === "string" && target.startsWith(`${memoryPath}.forget.`)) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return await realOpen(target, ...rest);
  };
}
function restoreFs() {
  fs.writeFile = realWriteFile;
  fs.open = realOpen;
}

// --- Scenario 1: ENOSPC halfway through the MEMORY.md rewrite ---
{
  const { memoryPath, originalContent } = await seedScenario("archived-enospc");
  installMidWriteEnospc(memoryPath);
  let forgetError;
  try {
    await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["archived-enospc"] });
  } catch (error) {
    forgetError = error;
  } finally {
    restoreFs();
  }

  console.log("=== Scenario 1: ENOSPC halfway through the MEMORY.md rewrite ===");
  console.log(`forgetMemoryEntries error: ${forgetError?.code ?? forgetError ?? "(none)"}`);
  const surviving = await fs.readFile(memoryPath, "utf8");
  console.log("--- MEMORY.md after failed forget ---");
  console.log(surviving);
  console.log("---------------------------------------");
  if (!forgetError || forgetError.code !== "ENOSPC") {
    console.log("UNEXPECTED: forget did not surface the injected ENOSPC");
    failures += 1;
  }
  if (surviving !== originalContent) {
    console.log(
      "FAIL: original MEMORY.md was destroyed by the failed rewrite (long-term memory lost)",
    );
    failures += 1;
  } else {
    console.log("PASS: original MEMORY.md intact after the failed rewrite");
  }
}

// --- Scenario 2: EACCES on temp-file replacement, target file writable ---
{
  const { memoryPath } = await seedScenario("archived-eacces");
  installTempReplacementEacces(memoryPath);
  let forgetError;
  try {
    await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["archived-eacces"] });
  } catch (error) {
    forgetError = error;
  } finally {
    restoreFs();
  }

  console.log("=== Scenario 2: directory rejects temp-file replacement (EACCES) ===");
  console.log(`forgetMemoryEntries error: ${forgetError?.code ?? forgetError ?? "(none)"}`);
  const rewritten = await fs.readFile(memoryPath, "utf8");
  console.log("--- MEMORY.md after forget ---");
  console.log(rewritten);
  console.log("---------------------------------------");
  if (forgetError) {
    console.log("FAIL: writable memory file could not be rewritten (compatibility regression)");
    failures += 1;
  } else if (rewritten.includes("Archived secret")) {
    console.log("FAIL: forget completed but the archived entry survived");
    failures += 1;
  } else {
    console.log("PASS: writable-file fallback completed the rewrite");
  }
}

await fs.rm(stateDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
