// Proof: apply_patch host write (workspaceOnly:false) must not truncate the
// original file when the write fails partway. Run: node --import tsx proof.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePatchFileOps } from "./src/agents/apply-patch-file-ops.ts";

const originalContent = `original\n${"important content\n".repeat(64)}`;
const newContent = `replacement\n${"patched content\n".repeat(80)}`;

const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "proof-patch-host-")));
const filePath = path.join(dir, "important.txt");
await fs.writeFile(filePath, originalContent);

// Fault injection A: bare fs.writeFile writes half then dies (pre-fix path).
const realWriteFile = fs.writeFile.bind(fs);
fs.writeFile = async (target, data, options) => {
  if (String(target) === filePath) {
    const text = String(data);
    await realWriteFile(target, text.slice(0, Math.floor(text.length / 2)), options);
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  }
  return realWriteFile(target, data, options);
};

// Fault injection B: r+ handle write fails partway through the prefix (post-fix path).
const realOpen = fs.open.bind(fs);
fs.open = async (target, flags, mode) => {
  const handle = await realOpen(target, flags, mode);
  if (String(target) === filePath && flags === "r+") {
    const realWrite = handle.write.bind(handle);
    let failed = false;
    handle.write = async (buffer, offset, length, position) => {
      if (!failed && position < Buffer.byteLength(originalContent)) {
        failed = true;
        await realWrite(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return realWrite(buffer, offset, length, position);
    };
  }
  return handle;
};

const ops = resolvePatchFileOps({ cwd: dir, workspaceOnly: false });
let writeError;
try {
  await ops.writeFile(filePath, newContent);
} catch (error) {
  writeError = error;
}
console.log("write error:", writeError?.message, writeError?.code ?? "");

const after = await fs.readFile(filePath, "utf8");
console.log("file bytes after failed write:", Buffer.byteLength(after));
console.log("original bytes:", Buffer.byteLength(originalContent));

let failed = false;
if (!writeError) {
  console.log("FAIL: expected the injected disk-full error");
  failed = true;
}
if (after === originalContent) {
  console.log("PASS: original host file content fully preserved after failed write");
} else {
  console.log("FAIL: original host file was corrupted by the partial write");
  console.log("--- surviving content head ---");
  console.log(JSON.stringify(after.slice(0, 80)));
  failed = true;
}

const entries = await fs.readdir(dir);
if (entries.length !== 1 || entries[0] !== "important.txt") {
  console.log("FAIL: unexpected leftover files:", entries);
  failed = true;
}

await fs.rm(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
