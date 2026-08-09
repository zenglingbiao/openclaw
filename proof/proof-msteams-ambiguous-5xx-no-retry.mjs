// Proof: msteams retries a non-idempotent Bot Framework activity create on
// 408/5xx. A loopback connector accepts the FULL activities POST body (the
// activity is effectively delivered) and only then responds 500 — the exact
// ambiguous failure where a replay duplicates the user's message.
//
// The send path is fully real: sendMSTeamsMessages → sendWithRetry →
// classifyMSTeamsSendError → @microsoft/teams.api Client → axios → HTTP POST
// to a live server. The only seam rewired is host resolution: an axios request
// interceptor dials 127.0.0.1 instead of smba.trafficmanager.net (the
// serviceUrl SSRF allowlist would otherwise reject a loopback URL outright).
//
// Run: node --import tsx scripts/proof-msteams-ambiguous-5xx-no-retry.mjs
import { createServer } from "node:http";
import { Client as ApiClient } from "@microsoft/teams.api";
import { Client as HttpClient } from "@microsoft/teams.common";
import { sendMSTeamsMessages } from "../extensions/msteams/src/messenger.ts";
import { setMSTeamsRuntime } from "../extensions/msteams/src/runtime.ts";

// Minimal plugin-runtime host interface — the same shape the repo's own
// messenger tests register; none of it is the code under test.
const chunkMarkdownText = (text, limit) => {
  if (!text || limit <= 0 || text.length <= limit) {
    return text ? [text] : [];
  }
  const chunks = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks;
};
setMSTeamsRuntime({
  config: { loadConfig: () => ({}) },
  channel: {
    text: {
      chunkMarkdownText,
      chunkMarkdownTextWithMode: chunkMarkdownText,
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text) => text,
    },
  },
});

// Loopback Bot Framework connector: read the ENTIRE activity body (delivery
// happens), record it, and only then fail with 500.
const delivered = [];
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url.includes("/activities")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      delivered.push({ url: req.url, body });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "InternalError", message: "boom after accept" } }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const PROD_SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const http = new HttpClient({
  token: "proof-token",
  interceptors: [
    {
      request: (ctx) => {
        const config = ctx.config;
        for (const key of ["url", "baseURL"]) {
          if (typeof config[key] === "string") {
            config[key] = config[key].replace(
              "https://smba.trafficmanager.net",
              `http://127.0.0.1:${port}`,
            );
          }
        }
        return config;
      },
    },
  ],
});
const app = { api: new ApiClient(PROD_SERVICE_URL.replace(/\/+$/, ""), http) };

const needle = `duplicate-delivery-proof-${Date.now()}`;
let sendError = null;
try {
  await sendMSTeamsMessages({
    replyStyle: "top-level",
    app,
    appId: "app123",
    conversationRef: {
      activityId: "activity-proof",
      user: { id: "user-proof", name: "User" },
      agent: { id: "bot-proof", name: "Bot" },
      conversation: { id: "19:proof@thread.tacv2" },
      channelId: "msteams",
      serviceUrl: PROD_SERVICE_URL,
    },
    messages: [{ text: needle }],
    retry: {}, // production default (send.ts / reply-dispatcher.ts): maxAttempts 3
    onRetry: (event) =>
      console.log(
        `retry event: next attempt ${event.nextAttempt}/${event.maxAttempts} in ${event.delayMs}ms (kind=${event.classification.kind}, status=${event.classification.statusCode})`,
      ),
  });
} catch (err) {
  sendError = err;
}
server.close();

console.log(`connector received the activity ${delivered.length} time(s)`);
for (const [index, hit] of delivered.entries()) {
  console.log(`  delivery #${index + 1}: POST ${hit.url} bodyHasNeedle=${hit.body.includes(needle)}`);
}
if (sendError) {
  console.log(`send result: threw after retries exhausted (${sendError.message?.slice(0, 80)})`);
} else {
  console.log("send result: resolved");
}

if (delivered.length > 1) {
  console.log(
    `FAIL: one outbound message was delivered to Teams ${delivered.length} times — ambiguous 5xx replay duplicated a non-idempotent activity create`,
  );
  process.exitCode = 1;
} else if (delivered.length === 1 && sendError) {
  console.log(
    "PASS: ambiguous 5xx surfaced as an error after exactly one delivery — no duplicate message",
  );
} else {
  console.log(`UNEXPECTED: deliveries=${delivered.length} sendError=${String(sendError)}`);
  process.exitCode = 1;
}
