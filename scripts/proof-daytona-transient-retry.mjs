// Proof: withDaytonaRetry must classify REAL transport faults through the
// shared network classifier. Every fault below is produced by a real loopback
// TCP/HTTP exchange, so the error object (and its undici cause chain) is
// emitted by Node/undici itself — nothing is handcrafted.
// Run: node --import tsx scripts/proof-daytona-transient-retry.mjs
import http from "node:http";
import { withDaytonaRetry } from "../extensions/daytona/src/client.ts";

let failures = 0;

function describeError(error) {
  const cause = error?.cause;
  return (
    `${error?.constructor?.name}: ${error?.message}` +
    (cause ? ` | cause: ${cause?.constructor?.name} code=${cause?.code ?? "(none)"}` : " | no cause")
  );
}

async function listen(server, port = 0) {
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

// --- Scenario A: real ECONNREFUSED (nothing listening), recovery once the
// control plane comes up between attempts. ---
async function scenarioConnRefused() {
  console.log("=== Scenario A: real ECONNREFUSED on loopback, then recovery ===");
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe); // port is now guaranteed free: connections get refused.

  const server = http.createServer((req, res) => {
    res.end("ok");
  });
  const t0 = Date.now();
  let attempts = 0;
  let outcome;
  try {
    outcome = await withDaytonaRetry("sandbox.get", async () => {
      attempts += 1;
      if (attempts === 2) {
        // The control plane finishes its restart before the retry budget ends.
        await listen(server, port);
        console.log(`attempt ${attempts} @ +${Date.now() - t0}ms: control plane back up`);
      }
      console.log(`attempt ${attempts} @ +${Date.now() - t0}ms: GET http://127.0.0.1:${port}/`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        return await res.text();
      } catch (error) {
        console.log(`attempt ${attempts} threw real fault -> ${describeError(error)}`);
        throw error;
      }
    });
  } catch (error) {
    console.log(`withDaytonaRetry gave up after ${attempts} attempt(s): ${describeError(error)}`);
  } finally {
    await close(server).catch(() => undefined);
  }
  console.log(`attempts=${attempts} outcome=${JSON.stringify(outcome)}`);
  if (attempts === 2 && outcome === "ok") {
    console.log("PASS: real ECONNREFUSED classified transient, retried, recovered");
  } else {
    console.log("FAIL: real ECONNREFUSED should have been retried and recovered");
    failures += 1;
  }
}

// --- Scenario B: real socket kill mid-request (peer destroys the connection),
// recovery on the next attempt. ---
async function scenarioSocketKill() {
  console.log("=== Scenario B: real socket destroy mid-request, then recovery ===");
  let killed = false;
  const server = http.createServer((req, res) => {
    if (!killed) {
      killed = true;
      req.socket.destroy(); // peer vanishes mid-exchange: real undici socket fault
      return;
    }
    res.end("ok");
  });
  const port = await listen(server);

  const t0 = Date.now();
  let attempts = 0;
  let outcome;
  try {
    outcome = await withDaytonaRetry("sandbox.delete", async () => {
      attempts += 1;
      console.log(`attempt ${attempts} @ +${Date.now() - t0}ms: GET http://127.0.0.1:${port}/`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        return await res.text();
      } catch (error) {
        console.log(`attempt ${attempts} threw real fault -> ${describeError(error)}`);
        throw error;
      }
    });
  } catch (error) {
    console.log(`withDaytonaRetry gave up after ${attempts} attempt(s): ${describeError(error)}`);
  } finally {
    await close(server).catch(() => undefined);
  }
  console.log(`attempts=${attempts} outcome=${JSON.stringify(outcome)}`);
  if (attempts === 2 && outcome === "ok") {
    console.log("PASS: real socket fault classified transient, retried, recovered");
  } else {
    console.log("FAIL: real socket fault should have been retried and recovered");
    failures += 1;
  }
}

// --- Scenario C: real HTTP 400 from the loopback server must still fail fast
// on the first attempt (permanent errors are not retried). ---
async function scenarioPermanent() {
  console.log("=== Scenario C: real HTTP 400 stays permanent (fail fast) ===");
  const server = http.createServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "invalid request" }));
  });
  const port = await listen(server);

  let attempts = 0;
  let outcome;
  try {
    outcome = await withDaytonaRetry("sandbox.get", async () => {
      attempts += 1;
      console.log(`attempt ${attempts}: GET http://127.0.0.1:${port}/`);
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (!res.ok) {
        // Mirror the Daytona SDK: HTTP error statuses reject with statusCode.
        throw Object.assign(new Error((await res.json()).message), { statusCode: res.status });
      }
      return await res.text();
    });
  } catch (error) {
    outcome = `${error?.constructor?.name}: ${error?.message} statusCode=${error?.statusCode}`;
  } finally {
    await close(server).catch(() => undefined);
  }
  console.log(`attempts=${attempts} outcome=${JSON.stringify(outcome)}`);
  if (attempts === 1 && String(outcome).includes("invalid request")) {
    console.log("PASS: permanent 400 failed fast on attempt 1");
  } else {
    console.log("FAIL: permanent 400 must fail on the first attempt");
    failures += 1;
  }
}

await scenarioConnRefused();
await scenarioSocketKill();
await scenarioPermanent();
process.exit(failures === 0 ? 0 : 1);
