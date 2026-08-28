// Proof: readBooleanParam must honor snake_case keys like every other typed param reader.
// Run: node --import tsx scripts/proof-read-boolean-param-snake-case.mjs
import { readBooleanParam } from "../src/plugin-sdk/boolean-param.ts";
import { readToolStringParam } from "../src/agents/tools/common.ts";

let failures = 0;

// A model following the message tool schema sends snake_case keys (dry_run).
// String/number readers normalize snake_case -> camelCase; the boolean reader must too.
const boolViaSnake = readBooleanParam({ dry_run: true }, "dryRun");
const stringViaSnake = readToolStringParam({ account_id: "acct-1" }, "accountId");

console.log(`readToolStringParam({account_id:"acct-1"}, "accountId") => ${JSON.stringify(stringViaSnake)}`);
console.log(`readBooleanParam({dry_run:true}, "dryRun")           => ${JSON.stringify(boolViaSnake)}`);

if (stringViaSnake !== "acct-1") {
  console.log("UNEXPECTED: string reader lost snake_case normalization");
  failures += 1;
}

// This is the message-action-runner.ts dryRun gate:
//   const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
const dryRun = Boolean(undefined ?? boolViaSnake);
console.log(`Effective dryRun at message-action-runner gate => ${dryRun}`);

if (dryRun !== true) {
  console.log(
    "FAIL: model asked for dry_run:true but dryRun resolved false -> real message would be delivered",
  );
  failures += 1;
} else {
  console.log("PASS: dry_run:true honored, dry-run preview stays dry");
}

process.exit(failures === 0 ? 0 : 1);
