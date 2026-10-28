import assert from "node:assert/strict";
import net from "node:net";
import { test, type TestContext } from "node:test";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type AccountInfo,
  type TransactionInstruction,
} from "@solana/web3.js";
import { getATAAddressSync } from "@saberhq/token-utils";
import { BN, Program } from "@coral-xyz/anchor";
import type { DirectedRankResult } from "../directedRank";
import type { SuccessNotification } from "../notify";

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const VOTE = key(1);
// Retired legacy settlement mint — only used to prove the bot refuses it.
const VSOL = new PublicKey("vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7");
const VLP = new PublicKey("EUWoTx5vQQrxaDFdeK2PLUVbnmRWjw4x6sBbmcxBaHjF");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const INVOICER_PROGRAM = new PublicKey(require("../IDL/vaultInvoicer.json").address);
const WEBHOOK = "https://discord.invalid/api/webhooks/offline-test";
const UNSTAKER_IDL = require("../IDL/liquidUnstaker.json");
const UNSTAKER_PROGRAM = new PublicKey(UNSTAKER_IDL.address);
const UNSTAKER_POOL = new PublicKey("9nyw5jxhzuSs88HxKJyDCsWBZMhxj2uNXsFcyHF5KBAb");
const [INVENTORY_SUMMARY] = PublicKey.findProgramAddressSync(
  [Buffer.from("inventory_summary"), UNSTAKER_POOL.toBuffer()], UNSTAKER_PROGRAM);
const [UNSTAKER_LP_MINT] = PublicKey.findProgramAddressSync(
  [Buffer.from("lp_mint"), UNSTAKER_POOL.toBuffer()], UNSTAKER_PROGRAM);
// The VLP price inputs: the unstake pool and its inventory summary.
const ORACLES = new Set([UNSTAKER_POOL.toBase58(), INVENTORY_SUMMARY.toBase58()]);

// Price fixture: 40 SOL vault + 10 SOL deactivating + 50 SOL LST inventory
// over 100 VLP = exactly 1 SOL/VLP. Ignoring the inventory (the pre-e06a485
// bug) would price VLP at 0.5 and under-fund every top-up.
const PRICE = { solVaultLamports: 40e9, totalDeactivatingStake: 10e9, totalValueSnapshot: 50e9, totalLpTokens: 100e9 };

// Real Anchor-encoded liquid-unstaker accounts: every IDL field zeroed, then
// the price inputs above set, so the bot's own fetch + decode path runs.
function unstakerAccount(name: "pool" | "inventorySummary", values: Record<string, number>) {
  const program = new Program(UNSTAKER_IDL, { connection: {} } as any);
  const typeDef: any = program.idl.types!.find((type) => type.name === name);
  const zero = (type: any): unknown => {
    if (type === "pubkey") return PublicKey.default;
    if (type === "bool") return false;
    if (type === "u64" || type === "i64") return new BN(0);
    if (typeof type === "string") return 0;
    if (type.option) return null;
    if (type.array) return Array.from({ length: type.array[1] }, () => zero(type.array[0]));
    throw new Error(`unsupported IDL type ${JSON.stringify(type)}`);
  };
  const fields = Object.fromEntries(typeDef.type.fields.map((field: any) => [field.name, zero(field.type)]));
  for (const [field, value] of Object.entries(values)) {
    if (field in fields) fields[field] = new BN(value.toString());
  }
  // Same bytes as the (async) BorshAccountsCoder.encode, built synchronously
  // so the fixture can stay synchronous: discriminator + borsh layout.
  const { discriminator, layout } = (program.coder.accounts as any).accountLayouts.get(name);
  const body = Buffer.alloc(1000);
  const length = layout.encode(fields, body);
  return account(Buffer.concat([Buffer.from(discriminator), body.subarray(0, length)]), UNSTAKER_PROGRAM);
}

function account(data: Buffer, owner = INVOICER_PROGRAM): AccountInfo<Buffer> {
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
}

// tsx's CommonJS exports are non-configurable getters. Give the importer a
// cache-local facade with mockable properties; restore the original exports
// afterwards. The bot's own builders remain real, including Anchor encoding.
function mockableModule(t: TestContext, path: string): any {
  const original = require(path);
  const entry = require.cache[require.resolve(path)]!;
  const facade = { ...original };
  entry.exports = facade;
  t.after(() => { entry.exports = original; });
  return facade;
}

function fixture(t: TestContext, options: {
  count?: number;
  listOnly?: string;
  threshold?: string;
  dotenvEnv?: Record<string, string>;
  tokenBalances?: { VLP?: bigint };
  solLamports?: number;
  // Make the VLP price available (pool + inventory summary accounts).
  price?: boolean;
  // Settlement mint of the first trusted invoicer (default VLP).
  firstInvoicerMint?: PublicKey;
} = {}) {
  const payer = Keypair.generate();
  const env: Record<string, string | undefined> = {
    DOTENV_CONFIG_PATH: "/dev/null",
    DOTENV_CONFIG_OVERRIDE: "false",
    RPC_URL: "http://127.0.0.1:1",
    VOTE_KEY: VOTE.toBase58(),
    PRIVATE_KEY: options.listOnly ? "deliberately not JSON or a secret key" : JSON.stringify([...payer.secretKey]),
    DISCORD_WEBHOOK_URL: WEBHOOK,
    RANK_ALERT_THRESHOLD: options.threshold ?? "80",
    LIST_ONLY: options.listOnly ?? "0",
    MAX_INVOICES_PER_RUN: "10",
    LOOKBACK_EPOCHS: "20",
    INVOICERS: [key(2), key(3)].join(","),
    ALLOW_UNTRUSTED_INVOICERS: undefined,
    FORCE_PDA_FALLBACK: undefined,
    VERBOSE: undefined,
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  const applyEnv = (values: typeof env) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  applyEnv(env);
  t.after(() => applyEnv(previous));

  // Never call real dotenv.config(), even if an inherited dotenv override is
  // present. This also lets a test emulate values supplied by dotenv itself.
  const dotenv = require("dotenv");
  const config = t.mock.method(dotenv, "config", () => {
    assert.equal(process.env.DOTENV_CONFIG_PATH, "/dev/null");
    Object.assign(process.env, options.dotenvEnv ?? {});
    return { parsed: options.dotenvEnv ?? {} };
  });

  const unexpected: string[] = [];
  const blocked = (name: string): never => {
    unexpected.push(name);
    throw new Error(`Unexpected offline-test I/O: ${name}`);
  };
  const fetch = t.mock.method(globalThis, "fetch", async () => blocked("fetch"));
  t.mock.method(net.Socket.prototype, "connect", () => blocked("socket.connect"));
  for (const name of ["sendTransaction", "sendRawTransaction", "simulateTransaction", "getLatestBlockhash", "getMultipleAccountsInfo"] as const) {
    t.mock.method(Connection.prototype, name, async () => blocked(name));
  }
  const solBalance = t.mock.method(Connection.prototype, "getBalance", async () =>
    options.solLamports ?? blocked("getBalance"));
  t.after(() => assert.deepEqual(unexpected, [], "no unexpected I/O, including swallowed errors"));
  const log = t.mock.method(console, "log", () => {});
  const warn = t.mock.method(console, "warn", () => {});

  const accounts = new Map<string, AccountInfo<Buffer>>();
  const invoicers = [
    { address: key(2), mint: options.firstInvoicerMint ?? VLP, reserves: key(4) },
    { address: key(3), mint: VLP, reserves: key(5) },
  ];
  if (options.price) {
    accounts.set(UNSTAKER_POOL.toBase58(), unstakerAccount("pool", PRICE));
    accounts.set(INVENTORY_SUMMARY.toBase58(), unstakerAccount("inventorySummary", PRICE));
  }
  for (const invoicer of invoicers) {
    const bytes = Buffer.alloc(304);
    invoicer.reserves.toBuffer().copy(bytes, 48);
    invoicer.mint.toBuffer().copy(bytes, 272);
    accounts.set(invoicer.address.toBase58(), account(bytes));
    const reserves = Buffer.alloc(165);
    invoicer.mint.toBuffer().copy(reserves);
    reserves.writeBigUInt64LE(100_000_000_000n, 64);
    accounts.set(invoicer.reserves.toBase58(), account(reserves, TOKEN_PROGRAM));
  }
  const invoices = Array.from({ length: options.count ?? 0 }, (_, index) => {
    const invoicer = invoicers[index % 2];
    const pubkey = key(20 + index);
    const data = Buffer.alloc(96);
    invoicer.address.toBuffer().copy(data, 8);
    VOTE.toBuffer().copy(data, 40);
    const epoch = 990 + index;
    const amount = BigInt(index + 1) * 1_000_000_000n + BigInt(index + 1);
    data.writeBigUInt64LE(BigInt(epoch), 72);
    data.writeBigUInt64LE(amount, 80);
    data.writeBigUInt64LE(amount, 88);
    const info = account(data);
    accounts.set(pubkey.toBase58(), info);
    return { pubkey, account: info, invoicer, epoch, amount };
  });
  const epoch = t.mock.method(Connection.prototype, "getEpochInfo", async () => ({
    epoch: 1_000, absoluteSlot: 1, blockHeight: 1, slotIndex: 1, slotsInEpoch: 432_000, transactionCount: 1,
  }));
  const scan = t.mock.method(Connection.prototype, "getProgramAccounts", async (program, config) => {
    assert.ok(program.equals(INVOICER_PROGRAM));
    assert.deepEqual(config, { filters: [
      { dataSize: 96 }, { memcmp: { offset: 40, bytes: VOTE.toBase58() } },
    ] });
    return invoices.map(({ pubkey, account }) => ({ pubkey, account }));
  });
  const lookup = (address: PublicKey) => {
    const found = accounts.get(address.toBase58());
    if (found) return found;
    // Unless `price` is set, the VLP price is unavailable: existing token
    // balances suffice.
    if (ORACLES.has(address.toBase58())) return null;
    return blocked(`getAccountInfo(${address.toBase58()})`);
  };
  const getAccount = t.mock.method(Connection.prototype, "getAccountInfo", async (address) => lookup(address));
  // Anchor's account fetch (the VLP price read) goes through the
  // context-returning variant.
  const getAccountCtx = t.mock.method(Connection.prototype, "getAccountInfoAndContext", async (address: PublicKey) =>
    ({ context: { slot: 1 }, value: lookup(address) }));
  const tokenBalances = new Map([
    [VLP.toBase58(), options.tokenBalances?.VLP ?? 100_000_000_000n],
  ]);
  const balances = t.mock.method(Connection.prototype, "getTokenAccountsByOwner", async (owner, filter, commitment) => {
    assert.ok(owner.equals(options.listOnly ? PublicKey.default : payer.publicKey));
    assert.equal(commitment, "confirmed");
    assert.ok("mint" in filter && filter.mint.equals(VLP));
    const data = Buffer.alloc(165);
    filter.mint.toBuffer().copy(data);
    owner.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(tokenBalances.get(filter.mint.toBase58())!, 64);
    return { context: { slot: 1 }, value: [{ pubkey: key(6), account: account(data, TOKEN_PROGRAM) }] };
  });

  const events: string[] = [];
  const transaction = mockableModule(t, "../transaction");
  const send = t.mock.method(transaction, "sendTransactionWithRetry", async () => {
    const signature = `offline-signature-${send.mock.callCount() + 1}`;
    events.push(`send:${signature}`);
    return signature;
  });
  const notifications = mockableModule(t, "../notify");
  const success = t.mock.method(notifications, "notifySuccess", async (_url: string, data: SuccessNotification) => {
    events.push(`success:${data.txHash}`);
  });
  const failure = t.mock.method(notifications, "notifyFailure", async () => { events.push("failure"); });
  const alert = t.mock.method(notifications, "notifyRankAlert", async () => { events.push("alert"); });
  const directedRank = mockableModule(t, "../directedRank");
  const rank = t.mock.method(directedRank, "getDirectedStakeRank", async (): Promise<DirectedRankResult> => {
    events.push("rank");
    return { found: true, rank: 1, totalLeaders: 100, directedSol: 100, sourceFile: "offline.json" };
  });

  const botPath = require.resolve("../bot");
  const previousBot = require.cache[botPath];
  delete require.cache[botPath];
  t.after(() => {
    delete require.cache[botPath];
    if (previousBot) require.cache[botPath] = previousBot;
  });
  const load = (): typeof import("../bot") => {
    delete require.cache[botPath];
    return require("../bot");
  };
  return {
    load, payer, config, fetch, log, warn, accounts, invoices, invoicers,
    epoch, scan, getAccount, getAccountCtx, balances, tokenBalances, solBalance, send, success, failure, alert, rank, events,
    TransactionPendingError: transaction.TransactionPendingError as typeof import("../transaction").TransactionPendingError,
  };
}

// Explicitly sequential: each fixture replaces process env and CommonJS cache
// entries, and node:test restores all t.mock methods after each test.
const sequential = { concurrency: false };

test("import is inert; a no-invoice run checks rank exactly once and alerts for a missing validator", sequential, async (t) => {
  const f = fixture(t);
  f.rank.mock.mockImplementation(async (vote: string) => {
    assert.equal(vote, VOTE.toBase58());
    return { found: false, totalLeaders: 123, sourceFile: "offline.json" };
  });
  const bot = f.load();
  assert.equal(f.config.mock.callCount(), 1);
  assert.equal(f.epoch.mock.callCount(), 0);
  assert.equal(f.rank.mock.callCount(), 0);
  assert.equal(f.send.mock.callCount(), 0);
  await bot.run();
  assert.equal(f.epoch.mock.callCount(), 1);
  assert.equal(f.rank.mock.callCount(), 1);
  assert.deepEqual(f.alert.mock.calls[0].arguments, [WEBHOOK, {
    found: false, totalLeaders: 123, sourceFile: "offline.json", threshold: 80,
  }]);
  assert.equal(f.alert.mock.callCount(), 1);
  assert.equal(f.success.mock.callCount(), 0);
  assert.equal(f.failure.mock.callCount(), 0);
  assert.equal(f.send.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
});

test("rank lookup failure is nonfatal after a no-invoice run", sequential, async (t) => {
  const f = fixture(t);
  f.rank.mock.mockImplementation(async () => { throw new Error("offline rank unavailable"); });
  await assert.doesNotReject(f.load().run());
  assert.equal(f.rank.mock.callCount(), 1);
  assert.equal(f.alert.mock.callCount(), 0);
  assert.equal(f.failure.mock.callCount(), 0);
  assert.ok(f.warn.mock.calls.some(({ arguments: args }) =>
    args[0] === "Directed rank check failed:" && args[1] === "offline rank unavailable"));
});

test("rank threshold is read after dotenv.config and alerts only strictly beyond it", sequential, async (t) => {
  const f = fixture(t, { threshold: "80", dotenvEnv: { RANK_ALERT_THRESHOLD: "2" } });
  let currentRank = 2;
  f.rank.mock.mockImplementation(async () => ({
    found: true, rank: currentRank, totalLeaders: 100, directedSol: 12.5, sourceFile: "offline.json",
  }));
  const bot = f.load();
  await bot.run();
  assert.equal(f.alert.mock.callCount(), 0, "rank equal to threshold is healthy");
  currentRank = 3;
  await bot.run();
  assert.equal(f.config.mock.callCount(), 1);
  assert.equal(f.rank.mock.callCount(), 2);
  assert.equal(f.alert.mock.callCount(), 1);
  assert.deepEqual(f.alert.mock.calls[0].arguments, [WEBHOOK, {
    found: true, rank: 3, totalLeaders: 100, directedSol: 12.5, sourceFile: "offline.json", threshold: 2,
  }]);
});

test("invalid rank thresholds reject on import before any RPC or rank request", sequential, async (t) => {
  for (const threshold of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", ""]) {
    await t.test(JSON.stringify(threshold), sequential, (t) => {
      const f = fixture(t, { threshold });
      assert.throws(f.load, /RANK_ALERT_THRESHOLD must be a positive integer/);
      assert.equal(f.config.mock.callCount(), 1);
      assert.equal(f.epoch.mock.callCount(), 0);
      assert.equal(f.rank.mock.callCount(), 0);
      assert.equal(f.fetch.mock.callCount(), 0);
    });
  }
});

for (const listOnly of ["1", "true"]) {
  test(`LIST_ONLY=${listOnly} ignores malformed private key and builds without signing, sending, or notifying`, sequential, async (t) => {
    const f = fixture(t, { count: 2, listOnly });
    const parseKey = t.mock.method(Keypair, "fromSecretKey", () => { throw new Error("must not parse private key"); });
    const sign = t.mock.method(VersionedTransaction.prototype, "sign", () => { throw new Error("must not sign"); });
    const legacySign = t.mock.method(Transaction.prototype, "sign", () => { throw new Error("must not sign"); });
    const partialSign = t.mock.method(Transaction.prototype, "partialSign", () => { throw new Error("must not sign"); });
    await f.load().run();
    assert.equal(f.scan.mock.callCount(), 1);
    assert.equal(f.balances.mock.callCount(), 1);
    assert.ok(f.log.mock.calls.some(({ arguments: args }) =>
      args[0] === "LIST_ONLY — instruction building verified, nothing sent."));
    for (const mock of [parseKey, sign, legacySign, partialSign, f.send, f.success, f.failure, f.alert, f.rank, f.fetch]) {
      assert.equal(mock.mock.callCount(), 0);
    }
  });
}

test("untrusted discovered invoice is skipped before fetching missing invoicer metadata", sequential, async (t) => {
  const f = fixture(t, { count: 1 });
  const untrusted = key(99);
  untrusted.toBuffer().copy(f.invoices[0].account.data, 8);
  await assert.doesNotReject(f.load().run());
  assert.ok(f.log.mock.calls.some(({ arguments: args }) =>
    typeof args[0] === "string" && args[0].includes("SECURITY: refusing to pay") && args[0].includes(untrusted.toBase58())));
  assert.ok(f.getAccount.mock.calls.every(({ arguments: args }) => ORACLES.has(args[0].toBase58())));
  assert.equal(f.send.mock.callCount(), 0);
  assert.equal(f.success.mock.callCount(), 0);
  assert.equal(f.failure.mock.callCount(), 0);
  assert.equal(f.rank.mock.callCount(), 1);
});

test("payment discovery failure notifies, rethrows the original error, and still checks rank once", sequential, async (t) => {
  const f = fixture(t);
  const error = new Error("offline epoch RPC failed");
  f.epoch.mock.mockImplementation(async () => { throw error; });
  // A second error in the finally block must not replace the payment error.
  f.rank.mock.mockImplementation(async () => { f.events.push("rank"); throw new Error("rank failed too"); });
  await assert.rejects(f.load().run(), (actual) => actual === error);
  assert.deepEqual(f.failure.mock.calls.map(({ arguments: args }) => args), [[WEBHOOK, {
    error: error.message, pending: false, txHash: undefined,
  }]]);
  assert.deepEqual(f.events, ["failure", "rank"]);
  assert.equal(f.rank.mock.callCount(), 1);
  assert.equal(f.send.mock.callCount(), 0);
});

function assertChunk(
  f: ReturnType<typeof fixture>,
  index: number,
  expected = f.invoices.slice(index * 8, index * 8 + 8),
) {
  const args = f.send.mock.calls[index].arguments;
  assert.equal(args[0].rpcEndpoint, "http://127.0.0.1:1");
  assert.deepEqual(args[2].map((signer: Keypair) => signer.publicKey.toBase58()), [f.payer.publicKey.toBase58()]);
  assert.ok(args[3].publicKey.equals(f.payer.publicKey));
  assert.deepEqual(args[4], []);
  assert.equal(args[5], 0);
  assert.equal(typeof args[6].preRebroadcast, "function");
  assert.equal(args[1].length, expected.length);
  (args[1] as TransactionInstruction[]).forEach((instruction, i) => {
    const invoice = expected[i];
    assert.ok(instruction.programId.equals(INVOICER_PROGRAM));
    assert.deepEqual([...instruction.data.subarray(0, 8)], [104, 6, 62, 239, 197, 206, 208, 220]);
    assert.equal(instruction.data.readBigUInt64LE(8), invoice.amount);
    assert.deepEqual(instruction.keys.map(({ pubkey }) => pubkey.toBase58()), [
      invoice.invoicer.address, invoice.pubkey,
      getATAAddressSync({ mint: invoice.invoicer.mint, owner: f.payer.publicKey }),
      f.payer.publicKey, invoice.invoicer.reserves, TOKEN_PROGRAM,
    ].map((pubkey) => pubkey.toBase58()));
    assert.equal(instruction.keys[3].isSigner, true);
    assert.equal(instruction.keys[1].isWritable, true);
  });
}

function expectedSuccess(f: ReturnType<typeof fixture>, index: number): SuccessNotification {
  const invoices = f.invoices.slice(index * 8, index * 8 + 8);
  const amounts = new Map<string, bigint>();
  for (const invoice of invoices) {
    const symbol = "VLP";
    amounts.set(symbol, (amounts.get(symbol) ?? 0n) + invoice.amount);
  }
  return {
    invoiceCount: invoices.length,
    amounts: [...amounts].map(([symbol, lamports]) => ({ symbol, lamports })),
    epochs: invoices.map(({ epoch }) => epoch),
    txHash: `offline-signature-${index + 1}`,
  };
}

test("nine invoices across both VLP invoicers build real pay instructions and notify each confirmed chunk in order", sequential, async (t) => {
  const f = fixture(t, { count: 9 });
  await f.load().run();
  assert.equal(f.send.mock.callCount(), 2);
  assertChunk(f, 0);
  assertChunk(f, 1);
  assert.deepEqual(f.success.mock.calls.map(({ arguments: args }) => args), [
    [WEBHOOK, expectedSuccess(f, 0)], [WEBHOOK, expectedSuccess(f, 1)],
  ]);
  assert.deepEqual(f.events, [
    "send:offline-signature-1", "success:offline-signature-1",
    "send:offline-signature-2", "success:offline-signature-2", "rank",
  ]);
  assert.equal(f.failure.mock.callCount(), 0);
  assert.equal(f.rank.mock.callCount(), 1);
  assert.equal(f.balances.mock.callCount(), 1, "existing balances avoid funding");
  for (const invoicer of f.invoicers) {
    assert.equal(f.getAccount.mock.calls.filter(({ arguments: args }) => args[0].equals(invoicer.address)).length, 1);
  }

  // Exercise the actual retry gate captured by the transaction mock.
  const gate = f.send.mock.calls[0].arguments[6].preRebroadcast;
  assert.equal(await gate("unsettled-signature"), true);
  const last = f.invoices[7];
  last.account.data.writeBigUInt64LE(0n, 88);
  assert.equal(await gate("unsettled-signature"), false, "any settled invoice suppresses the entire rebroadcast");
  last.account.data.writeBigUInt64LE(last.amount, 88);
  f.accounts.set(last.pubkey.toBase58(), account(Buffer.alloc(95)));
  assert.equal(await gate("unsettled-signature"), false, "truncated invoice suppresses rebroadcast");
  f.getAccount.mock.mockImplementation(async () => null);
  assert.equal(await gate("unsettled-signature"), false, "missing invoice suppresses rebroadcast");
  const invoiceReads = f.getAccount.mock.calls.filter(({ arguments: args }) =>
    f.invoices.some((invoice) => invoice.pubkey.equals(args[0])));
  assert.ok(invoiceReads.length > 0);
  assert.ok(invoiceReads.every(({ arguments: args }) => args[1] === "confirmed"));
});

for (const pending of [false, true]) {
  test(`later chunk ${pending ? "pending outcome" : "definite failure"} preserves the earlier success notification and rethrows`, sequential, async (t) => {
    const f = fixture(t, { count: 9 });
    const error = pending
      ? new f.TransactionPendingError("unsettled-signature", "second chunk still pending")
      : new Error("second chunk failed on-chain");
    f.send.mock.mockImplementation(async () => {
      const index = f.send.mock.callCount() + 1;
      f.events.push(`send:offline-signature-${index}`);
      if (index === 2) throw error;
      return "offline-signature-1";
    });
    await assert.rejects(f.load().run(), (actual) => actual === error);
    assert.equal(f.send.mock.callCount(), 2);
    assertChunk(f, 0);
    assertChunk(f, 1);
    assert.deepEqual(f.success.mock.calls.map(({ arguments: args }) => args), [[WEBHOOK, expectedSuccess(f, 0)]]);
    assert.deepEqual(f.failure.mock.calls.map(({ arguments: args }) => args), [[WEBHOOK, {
      error: error.message, pending, txHash: pending ? "unsettled-signature" : undefined,
    }]]);
    assert.deepEqual(f.events, [
      "send:offline-signature-1", "success:offline-signature-1", "send:offline-signature-2", "failure", "rank",
    ]);
    assert.equal(f.rank.mock.callCount(), 1);
  });
}

function fundingFixture(t: TestContext, options: { count?: number; solLamports?: number } = {}) {
  const f = fixture(t, {
    count: options.count ?? 1,
    tokenBalances: { VLP: 0n },
    solLamports: options.solLamports ?? 10_000_000_000,
    price: true,
  });
  // Only the ATA lookup is synthetic. The VLP price read (pool + inventory
  // summary), the deposit_sol instruction, funding decisions, confirmed
  // balance reads, and pay encoding stay real.
  const tokenUtils = mockableModule(t, "@saberhq/token-utils");
  const ata = key(71);
  const createATA = t.mock.method(tokenUtils, "getOrCreateATA", async () => ({ address: ata }));
  return { ...f, createATA, ata };
}

// SOL the bot must spend: deficit (whole due amount; the wallet holds no VLP)
// x 1 SOL/VLP (pool + deactivating + inventory) x 1.3 margin.
const expectedFundingLamports = (f: ReturnType<typeof fundingFixture>) =>
  Math.ceil(
    (Number(f.invoices.reduce((sum, invoice) => sum + invoice.amount, 0n)) / 10 ** 9) * 1 * 1.3 * 10 ** 9,
  );

function assertFundingConstruction(f: ReturnType<typeof fundingFixture>) {
  for (const oracle of [UNSTAKER_POOL, INVENTORY_SUMMARY]) {
    assert.ok(f.getAccountCtx.mock.calls.some(({ arguments: args }) => args[0].equals(oracle)),
      `price read ${oracle.toBase58()}`);
  }
  assert.equal(f.createATA.mock.callCount(), 1);
  const ataOptions = f.createATA.mock.calls[0].arguments[0];
  assert.ok(ataOptions.mint.equals(UNSTAKER_LP_MINT));
  assert.ok(ataOptions.owner.equals(f.payer.publicKey));
}

function assertFundingSend(f: ReturnType<typeof fundingFixture>) {
  const args = f.send.mock.calls[0].arguments;
  assert.equal(args[0].rpcEndpoint, "http://127.0.0.1:1");
  const instructions = args[1] as TransactionInstruction[];
  assert.equal(instructions.length, 1);
  const [deposit] = instructions;
  assert.ok(deposit.programId.equals(UNSTAKER_PROGRAM));
  assert.equal(deposit.data.readBigUInt64LE(8), BigInt(expectedFundingLamports(f)),
    "funding is priced with the LST inventory included");
  assert.ok(deposit.keys[0].pubkey.equals(UNSTAKER_POOL));
  assert.ok(deposit.keys[3].pubkey.equals(f.payer.publicKey));
  assert.ok(deposit.keys[4].pubkey.equals(f.ata));
  assert.ok(deposit.keys[5].pubkey.equals(INVENTORY_SUMMARY));
  assert.deepEqual(args[2], []);
  assert.ok(args[3].publicKey.equals(f.payer.publicKey));
  assert.deepEqual(args[4], []);
  assert.equal(args[5], 0);
  assert.equal(typeof args[6].preRebroadcast, "function");
}

const isFunding = (instructions: TransactionInstruction[]) =>
  instructions.some((instruction) => instruction.programId.equals(UNSTAKER_PROGRAM));

function assertDeferredFailure(
  f: ReturnType<typeof fixture>,
  error: unknown,
  pending: boolean,
  txHash?: string,
) {
  assert.ok(error instanceof Error);
  assert.equal(error instanceof f.TransactionPendingError, pending);
  assert.deepEqual(f.failure.mock.calls.map(({ arguments: args }) => args), [[WEBHOOK, {
    error: error.message, pending, txHash,
  }]]);
  assert.equal(f.rank.mock.callCount(), 1);
  assert.equal(f.alert.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
}

test("VLP price includes the LST inventory snapshot", sequential, async (t) => {
  const f = fixture(t, { price: true });
  assert.equal(await f.load().getVLPPriceSol(), 1);
});

test("a trusted invoicer settling in a non-VLP mint (legacy vSOL) is refused loudly", sequential, async (t) => {
  const f = fixture(t, { count: 2, firstInvoicerMint: VSOL });
  await assert.rejects(f.load().run(), /settles in vSoLxydx.*not the VLP mint.*refusing to pay/);
  assert.equal(f.send.mock.callCount(), 0);
  assert.equal(f.success.mock.callCount(), 0);
  assert.equal(f.failure.mock.callCount(), 1);
  assert.equal(f.rank.mock.callCount(), 1);
});

test("an unfunded wallet with no SOL sends nothing and rejects with a non-pending failure", sequential, async (t) => {
  const f = fundingFixture(t, { solLamports: 0 });
  let rejected: unknown;
  await assert.rejects(f.load().run(), (error: unknown) => {
    rejected = error;
    assert.ok(error instanceof Error);
    assert.equal(error.message, "1 invoice(s) remain unpaid. VLP: Insufficient SOL for token funding and fees");
    return true;
  });
  assertFundingConstruction(f);
  assert.equal(f.solBalance.mock.callCount(), 1);
  assert.ok(f.solBalance.mock.calls[0].arguments[0].equals(f.payer.publicKey));
  assert.equal(f.balances.mock.callCount(), 1);
  assert.equal(f.send.mock.callCount(), 0, "neither a purchase nor a payment is sent");
  assert.equal(f.success.mock.callCount(), 0);
  assertDeferredFailure(f, rejected, false);
  assert.deepEqual(f.events, ["failure", "rank"]);
});

for (const pending of [false, true]) {
  test(`${pending ? "pending" : "definitely failed"} funding with insufficient confirmed tokens rejects and reports the correct outcome`, sequential, async (t) => {
    const f = fundingFixture(t);
    const fundingError = pending
      ? new f.TransactionPendingError("pending-funding-signature", "funding confirmation timed out")
      : new Error("funding transaction failed on-chain: custom error 42");
    f.send.mock.mockImplementation(async () => {
      f.events.push("funding-send");
      // The reread sees a small balance change, but it still cannot cover the
      // invoice. A pending purchase must not be mistaken for a paid invoice.
      f.tokenBalances.set(VLP.toBase58(), 1n);
      throw fundingError;
    });
    let rejected: unknown;
    await assert.rejects(f.load().run(), (error: unknown) => {
      rejected = error;
      assert.ok(error instanceof Error);
      assert.notEqual(error, fundingError, "the rejection describes deferred invoices");
      assert.equal(error.message, pending
        ? `1 invoice(s) deferred; funding outcome is uncertain. VLP: ${fundingError.message}`
        : `1 invoice(s) remain unpaid. VLP: ${fundingError.message}`);
      if (pending) {
        assert.ok(error instanceof f.TransactionPendingError);
        assert.equal(error.signature, "pending-funding-signature");
      }
      return true;
    });
    assertFundingConstruction(f);
    assertFundingSend(f);
    assert.equal(f.solBalance.mock.callCount(), 1);
    assert.equal(f.balances.mock.callCount(), 2, "token balance is reread after the funding error");
    assert.equal(f.send.mock.callCount(), 1, "only the funding transaction is attempted");
    assert.equal(f.success.mock.callCount(), 0);
    assertDeferredFailure(f, rejected, pending, pending ? "pending-funding-signature" : undefined);
    assert.deepEqual(f.events, ["funding-send", "failure", "rank"]);
  });
}

for (const stage of ["construction", "send"] as const) {
  test(`a VLP funding ${stage} failure pays nothing and reports the deferred invoices`, sequential, async (t) => {
    const f = fundingFixture(t, { count: 2 });
    const fundingError = new Error(`offline VLP funding ${stage} failed`);
    if (stage === "construction") {
      f.createATA.mock.mockImplementation(async () => { throw fundingError; });
    }
    f.send.mock.mockImplementation(async (_connection, instructions: TransactionInstruction[]) => {
      assert.ok(isFunding(instructions), "no pay transaction may be sent");
      f.events.push("funding-send");
      throw fundingError;
    });
    let rejected: unknown;
    await assert.rejects(f.load().run(), (error: unknown) => {
      rejected = error;
      assert.ok(error instanceof Error);
      assert.equal(error.message, `2 invoice(s) remain unpaid. VLP: ${fundingError.message}`);
      return true;
    });
    assertFundingConstruction(f);
    const fundingSent = stage === "send";
    if (fundingSent) assertFundingSend(f);
    assert.equal(f.solBalance.mock.callCount(), fundingSent ? 1 : 0);
    assert.equal(f.balances.mock.callCount(), fundingSent ? 2 : 1);
    assert.equal(f.send.mock.callCount(), fundingSent ? 1 : 0);
    assert.equal(f.success.mock.callCount(), 0);
    assertDeferredFailure(f, rejected, false);
    assert.deepEqual(f.events, [...(fundingSent ? ["funding-send"] : []), "failure", "rank"]);
  });
}

test("funding that covers the due amount pays every invoice in the same run", sequential, async (t) => {
  const f = fundingFixture(t, { count: 2 });
  f.send.mock.mockImplementation(async (_connection, instructions: TransactionInstruction[]) => {
    if (isFunding(instructions)) {
      f.events.push("funding-send");
      // deposit_sol at 1 SOL/VLP with a 1.3x margin covers the deficit.
      f.tokenBalances.set(VLP.toBase58(), BigInt(expectedFundingLamports(f)));
      return "funding-signature";
    }
    f.events.push("pay-after-funding");
    return "paid-vlp-signature";
  });
  await assert.doesNotReject(f.load().run());
  assertFundingConstruction(f);
  assertFundingSend(f);
  assert.equal(f.balances.mock.callCount(), 2);
  assert.equal(f.send.mock.callCount(), 2);
  assertChunk(f, 1, f.invoices);
  assert.deepEqual(f.success.mock.calls.map(({ arguments: args }) => args), [[WEBHOOK, {
    invoiceCount: 2,
    amounts: [{ symbol: "VLP", lamports: f.invoices[0].amount + f.invoices[1].amount }],
    epochs: f.invoices.map(({ epoch }) => epoch),
    txHash: "paid-vlp-signature",
  }]]);
  assert.equal(f.failure.mock.callCount(), 0);
  assert.deepEqual(f.events, ["funding-send", "pay-after-funding", "success:paid-vlp-signature", "rank"]);
});

test("a pending funding outcome does not reject when the confirmed balance now covers every invoice", sequential, async (t) => {
  const f = fundingFixture(t);
  f.send.mock.mockImplementation(async (_connection, instructions: TransactionInstruction[]) => {
    if (isFunding(instructions)) {
      f.events.push("funding-send");
      f.tokenBalances.set(VLP.toBase58(), f.invoices[0].amount);
      throw new f.TransactionPendingError("late-funding-signature", "confirmation timed out");
    }
    f.events.push("pay-after-funding");
    return "paid-vlp-signature";
  });
  await assert.doesNotReject(f.load().run());
  assertFundingConstruction(f);
  assertFundingSend(f);
  assert.equal(f.balances.mock.callCount(), 2);
  assert.equal(f.send.mock.callCount(), 2);
  assertChunk(f, 1, [f.invoices[0]]);
  assert.deepEqual(f.success.mock.calls.map(({ arguments: args }) => args), [[WEBHOOK, {
    invoiceCount: 1,
    amounts: [{ symbol: "VLP", lamports: f.invoices[0].amount }],
    epochs: [f.invoices[0].epoch],
    txHash: "paid-vlp-signature",
  }]]);
  assert.equal(f.failure.mock.callCount(), 0);
  assert.equal(f.rank.mock.callCount(), 1);
  assert.deepEqual(f.events, ["funding-send", "pay-after-funding", "success:paid-vlp-signature", "rank"]);
});
