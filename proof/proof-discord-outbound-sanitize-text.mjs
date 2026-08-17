// Proof: Discord's outbound adapter ships no sanitizeText hook, so internal
// assistant tool-trace scaffolding (<tool_call> XML, <tool_result>, <think>)
// is delivered verbatim to Discord channels/DMs. The core delivery pipeline
// (src/infra/outbound/deliver-channel.ts) only strips this scaffolding when
// the channel adapter provides sanitizeText — discordOutbound provides none.
//
// The call boundary below mirrors deliver-channel.ts: outbound.sanitizeText
// is applied to the final text when present, otherwise the raw text ships.
//
// Run: node --import tsx scripts/proof-discord-outbound-sanitize-text.mjs
import { discordOutbound } from "../extensions/discord/src/outbound-adapter.ts";

const internalTrace = [
  '<invoke name="read">payload</invoke></minimax:tool_call>',
  '<tool_result>{"output":"hidden"}</tool_result>',
  "[Tool Call: read (ID: toolu_1)]",
  'Arguments: {"path":"/tmp/x"}',
  "<think>secret chain-of-thought</think>",
  "Visible answer for the Discord user.",
].join("\n");

// Same contract as src/infra/outbound/deliver-channel.ts: when the adapter
// has no sanitizeText, the payload text is delivered exactly as produced.
const delivered = discordOutbound.sanitizeText
  ? discordOutbound.sanitizeText({ text: internalTrace, payload: { text: internalTrace } })
  : internalTrace;

console.log("discordOutbound.sanitizeText present:", Boolean(discordOutbound.sanitizeText));
console.log("--- text delivered to Discord ---");
console.log(delivered);
console.log("---------------------------------");

if (
  delivered.includes("<invoke") ||
  delivered.includes("<tool_result>") ||
  delivered.includes("<think>") ||
  delivered.includes("[Tool Call:")
) {
  console.log("FAIL: internal tool-trace scaffolding reaches Discord users unsanitized");
  process.exitCode = 1;
} else if (!delivered.includes("Visible answer for the Discord user.")) {
  console.log("FAIL: visible answer was stripped along with the scaffolding");
  process.exitCode = 1;
} else {
  console.log("PASS: internal scaffolding stripped, visible answer preserved");
}
