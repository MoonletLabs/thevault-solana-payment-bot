import assert from "node:assert/strict";
import net from "node:net";
import { test, type TestContext } from "node:test";
import { notifyFailure, notifyRankAlert, notifySuccess } from "../notify";

const WEBHOOK = "https://discord.invalid/api/webhooks/offline-test";
const SIGNATURE = "offlineSignature0123456789abcdefghijklmnopqrstuvwxyz";
const sequential = { concurrency: false };

function fixture(t: TestContext) {
  const unexpected: string[] = [];
  t.mock.method(net.Socket.prototype, "connect", () => {
    unexpected.push("socket.connect");
    throw new Error("Network is disabled in notification tests");
  });
  t.after(() => assert.deepEqual(unexpected, []));
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  // Validate outside the fetch implementation: post() deliberately swallows
  // fetch errors, which would otherwise also swallow assertion failures.
  t.after(() => {
    for (const { arguments: [url, init] } of fetch.mock.calls) {
      assert.equal(url, WEBHOOK);
      assert.equal(init?.method, "POST");
      assert.deepEqual(init.headers, { "Content-Type": "application/json" });
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(typeof init.body, "string");
    }
  });
  const warn = t.mock.method(console, "warn", () => {});
  function embed(index = 0) {
    const call = fetch.mock.calls[index];
    assert.ok(call, `expected webhook request ${index + 1}`);
    const payload = JSON.parse(call.arguments[1]!.body as string);
    assert.deepEqual(Object.keys(payload), ["embeds"]);
    assert.equal(payload.embeds.length, 1);
    const result = payload.embeds[0];
    assert.ok(Number.isFinite(Date.parse(result.timestamp)), "embed has an ISO timestamp");
    return result;
  }
  function fields(index = 0): Record<string, string> {
    return Object.fromEntries(embed(index).fields.map(({ name, value }: { name: string; value: string }) => [name, value]));
  }
  return { fetch, warn, embed, fields };
}

test("success webhook keeps vSOL and VLP totals separate with exact bigint precision", sequential, async (t) => {
  const f = fixture(t);
  const epochs = [999, 980, 990];
  await notifySuccess(WEBHOOK, {
    invoiceCount: 3,
    amounts: [
      { symbol: "vSOL", lamports: 123456789012345678901234567n },
      { symbol: "VLP", lamports: 2000000001n },
    ],
    epochs,
    txHash: SIGNATURE,
  });
  assert.equal(f.fetch.mock.callCount(), 1);
  const embed = f.embed();
  assert.match(embed.title, /Invoices Paid Successfully/);
  assert.match(embed.description, /3 invoice\(s\)/);
  assert.equal(embed.color, 0x57f287);
  assert.deepEqual(f.fields(), {
    "Total Amount": "123456789012345678.901234567 vSOL\n2.000000001 VLP",
    Transaction: `[offlineS…uvwxyz](https://solscan.io/tx/${SIGNATURE})`,
    "Epochs Paid": "980, 990, 999",
  });
  assert.deepEqual(epochs, [999, 980, 990], "sorting the display does not mutate caller data");
  assert.equal(f.warn.mock.callCount(), 0);
});

test("success handles zero amounts, absent transaction hash, and empty epochs", sequential, async (t) => {
  const f = fixture(t);
  await notifySuccess(WEBHOOK, {
    invoiceCount: 0, amounts: [{ symbol: "vSOL", lamports: 0n }], epochs: [], txHash: undefined,
  });
  assert.deepEqual(f.fields(), {
    "Total Amount": "0.000000000 vSOL", Transaction: "unknown", "Epochs Paid": "—",
  });
});

test("pending payment is an orange uncertainty warning with a Solscan link", sequential, async (t) => {
  const f = fixture(t);
  await notifyFailure(WEBHOOK, { error: "confirmation timed out", pending: true, txHash: SIGNATURE });
  assert.equal(f.fetch.mock.callCount(), 1);
  const embed = f.embed();
  assert.match(embed.title, /Invoice Payment Unconfirmed/);
  assert.match(embed.description, /outcome is uncertain/);
  assert.match(embed.description, /verify the transaction before retrying/);
  assert.equal(embed.color, 0xfaa61a);
  assert.deepEqual(f.fields(), {
    Details: "```\nconfirmation timed out\n```",
    Transaction: `[offlineS…uvwxyz](https://solscan.io/tx/${SIGNATURE})`,
  });
});

test("definite failure is red, preserves the earlier-chunk message, and links the failed transaction", sequential, async (t) => {
  const f = fixture(t);
  await notifyFailure(WEBHOOK, { error: "custom program error", pending: false, txHash: "short-signature" });
  assert.equal(f.fetch.mock.callCount(), 1);
  const embed = f.embed();
  assert.match(embed.title, /Invoice Payment Failed/);
  assert.match(embed.description, /Any earlier confirmed chunks remain paid/);
  assert.equal(embed.color, 0xed4245);
  assert.deepEqual(f.fields(), {
    Error: "```\ncustom program error\n```",
    Transaction: "[short-signature](https://solscan.io/tx/short-signature)",
  });
});

test("failure truncates long errors and escapes embedded code fences without inventing a transaction", sequential, async (t) => {
  const f = fixture(t);
  await notifyFailure(WEBHOOK, { error: "```" + "x".repeat(1_100) });
  assert.deepEqual(f.fields(), { Error: "```\nʼʼʼ" + "x".repeat(997) + "…\n```" });
});

test("rank alerts distinguish a missing validator from a low-ranked validator", sequential, async (t) => {
  const f = fixture(t);
  await notifyRankAlert(WEBHOOK, { found: false, totalLeaders: 100, threshold: 80 });
  await notifyRankAlert(WEBHOOK, { found: true, rank: 81, totalLeaders: 100, threshold: 80, directedSol: 123.456 });
  assert.equal(f.fetch.mock.callCount(), 2);
  assert.match(f.embed(0).description, /was not found/);
  assert.equal(f.embed(0).color, 0xfaa61a);
  assert.equal(f.embed(0).url, "https://thevault.finance/validators");
  assert.deepEqual(f.fields(0), { Rank: "not found (of 100 leaders)", Threshold: "#80" });
  assert.match(f.embed(1).description, /dropped below rank #80/);
  assert.deepEqual(f.fields(1), { Rank: "#81 of 100", Threshold: "#80", "Directed Stake": "123.46 SOL" });
});

test("all notifications are no-ops without a webhook URL", sequential, async (t) => {
  const f = fixture(t);
  for (const url of [undefined, ""]) {
    await notifySuccess(url, { invoiceCount: 1, amounts: [{ symbol: "vSOL", lamports: 1n }], epochs: [999], txHash: SIGNATURE });
    await notifyFailure(url, { error: "offline failure", pending: true, txHash: SIGNATURE });
    await notifyRankAlert(url, { found: false, totalLeaders: 100, threshold: 80 });
  }
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.warn.mock.callCount(), 0);
});

test("HTTP errors and fetch rejections are warned about and swallowed by every notification helper", sequential, async (t) => {
  const f = fixture(t);
  const helpers = [
    () => notifySuccess(WEBHOOK, { invoiceCount: 1, amounts: [{ symbol: "VLP", lamports: 1n }], epochs: [999], txHash: SIGNATURE }),
    () => notifyFailure(WEBHOOK, { error: "offline failure" }),
    () => notifyRankAlert(WEBHOOK, { found: false, totalLeaders: 100, threshold: 80 }),
  ];
  for (const mode of ["http", "network"] as const) {
    f.fetch.mock.mockImplementation(async () => {
      if (mode === "network") throw new Error("offline webhook unavailable");
      return new Response(null, { status: 503, statusText: "Service Unavailable" });
    });
    for (const notify of helpers) await assert.doesNotReject(notify());
  }
  assert.equal(f.fetch.mock.callCount(), 6);
  assert.deepEqual(f.warn.mock.calls.map(({ arguments: args }) => args), [
    ...Array.from({ length: 3 }, () => ["Discord webhook responded with status 503 Service Unavailable"]),
    ...Array.from({ length: 3 }, () => ["Discord webhook failed:", "offline webhook unavailable"]),
  ]);
});
