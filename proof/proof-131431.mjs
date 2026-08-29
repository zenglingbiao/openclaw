// proof-131431.mjs — drives the real FileSettingsStorage from a repo checkout.
// Usage: node --import tsx proof-131431.mjs <repo-root>
// Scenario 1: a real EFBIG (child process under ulimit -f) mid-write failure.
// Scenario 2: an existing final settings.json symlink must survive the save
//             while its operator-managed target receives the update.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.argv[2];
if (!repoRoot) {
  console.error("usage: node --import tsx proof-131431.mjs <repo-root>");
  process.exit(2);
}
console.log(`repo: ${repoRoot}`);

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures += 1;
  }
}

// ------------------------------------------------- Scenario 1: real EFBIG tear
console.log("\n=== Scenario 1: save fails partway through the write (real EFBIG) ===");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-settings-proof-"));
try {
  const agentDir = path.join(work, "agent");
  const cwd = path.join(work, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const settingsPath = path.join(agentDir, "settings.json");
  const original = JSON.stringify({ packages: ["npm:@openclaw/keep"] });
  fs.writeFileSync(settingsPath, original, "utf-8");
  const payload = JSON.stringify({
    packages: Array.from({ length: 400 }, (_, i) => `npm:@openclaw/pkg-${i}`),
  });
  console.log(`original bytes: ${original.length} | payload bytes: ${payload.length}`);

  const childSource = `
    import { FileSettingsStorage } from ${JSON.stringify(
      pathToFileURL(path.join(repoRoot, "src/agents/sessions/settings-storage.ts")).href,
    )};
    const storage = new FileSettingsStorage(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)});
    try {
      storage.withLock("global", () => ${JSON.stringify(payload)});
      console.log("child save completed without error");
    } catch (error) {
      console.log("child save error: " + (error && error.code ? error.code : error));
    }
  `;
  const childScript = path.join(work, "child-save.mjs");
  fs.writeFileSync(childScript, childSource, "utf-8");
  try {
    const out = execFileSync(
      "bash",
      ["-c", `ulimit -f 6; exec node --import tsx ${JSON.stringify(childScript)}`],
      { stdio: ["ignore", "pipe", "pipe"], cwd: repoRoot },
    );
    process.stdout.write(String(out));
  } catch (error) {
    process.stdout.write(String(error.stdout ?? ""));
    process.stderr.write(String(error.stderr ?? ""));
  }

  const afterBytes = fs.readFileSync(settingsPath, "utf-8");
  console.log(`settings.json bytes after failed save: ${afterBytes.length}`);
  let packagesAfter = "unparseable";
  try {
    packagesAfter = JSON.stringify(JSON.parse(afterBytes).packages ?? []);
  } catch {
    // torn JSON: stays "unparseable"
  }
  console.log(`packages after reload: ${packagesAfter}`);
  check(afterBytes === original, "settings.json fully preserved after failed save", `${afterBytes.length} bytes`);
  check(packagesAfter === '["npm:@openclaw/keep"]', "user packages setting survives the reload");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

// --------------------------------------- Scenario 2: final symlink preservation
console.log("\n=== Scenario 2: existing final settings.json symlink ===");
const work2 = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-settings-link-proof-"));
try {
  const { FileSettingsStorage } = await import(
    pathToFileURL(path.join(repoRoot, "src/agents/sessions/settings-storage.ts")).href
  );
  const agentDir = path.join(work2, "agent");
  const cwd = path.join(work2, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const target = path.join(agentDir, "operator-managed-settings.json");
  const link = path.join(agentDir, "settings.json");
  const next = JSON.stringify({ packages: ["new"] });
  fs.writeFileSync(target, JSON.stringify({ packages: ["old"] }), "utf-8");
  fs.symlinkSync(target, link);

  new FileSettingsStorage(cwd, agentDir).withLock("global", () => next);

  const linkSurvives = fs.lstatSync(link).isSymbolicLink();
  const targetContent = fs.readFileSync(target, "utf-8");
  console.log(`settings.json is still a symlink: ${linkSurvives}`);
  console.log(`operator-managed target content: ${targetContent}`);
  check(linkSurvives, "final settings.json symlink preserved");
  check(targetContent === next, "symlink target received the update", targetContent);
} finally {
  fs.rmSync(work2, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
