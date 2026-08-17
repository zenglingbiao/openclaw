// Proof: MS Teams' outbound adapter ships no sanitizeText hook, so internal
// assistant tool-trace scaffolding (<tool_call> XML, <tool_result>, <think>)
// is delivered verbatim into enterprise Teams conversations. The core
// delivery pipeline (src/infra/outbound/deliver-channel.ts) only strips this
// scaffolding when the channel adapter provides sanitizeText —
// msteamsChannelOutbound provides none (grep sanitizeText extensions/msteams
// returns zero hits).
//
// The call boundary below mirrors deliver-channel.ts: outbound.sanitizeText
// is applied to the final text when present, otherwise the raw text ships.
//
// Run: node --import tsx scripts/proof-msteams-outbound-sanitize-text.mjs
import { msteamsPlugin } from "../extensions/msteams/src/channel.ts";

const internalTrace = [
  '<invoke name="read">payload</invoke></minimax:tool_call>',
  '<tool_result>{"output":"hidden"}</tool_result>',
  "[Tool Call: read (ID: toolu_1)]",
  'Arguments: {"path":"/tmp/x"}',
  "<think>secret chain-of-thought</think>",
  "Visible answer for the Teams user.",
].join("\n");

// Same contract as src/infra/outbound/deliver-channel.ts: when the adapter
// has no sanitizeText, the payload text is delivered exactly as produced.
const sanitizeText = msteamsPlugin.outbound?.sanitizeText;
const delivered = sanitizeText
  ? sanitizeText({ text: internalTrace, payload: { text: internalTrace } })
  : internalTrace;

console.log("msteams outbound sanitizeText present:", Boolean(sanitizeText));
console.log("--- text delivered to MS Teams ---");
console.log(delivered);
console.log("----------------------------------");

if (
  delivered.includes("<invoke") ||
  delivered.includes("<tool_result>") ||
  delivered.includes("<think>") ||
  delivered.includes("[Tool Call:")
) {
  console.log("FAIL: internal tool-trace scaffolding reaches MS Teams users unsanitized");
  process.exitCode = 1;
} else if (!delivered.includes("Visible answer for the Teams user.")) {
  console.log("FAIL: visible answer was stripped along with the scaffolding");
  process.exitCode = 1;
} else {
  console.log("PASS: internal scaffolding stripped, visible answer preserved");
}
