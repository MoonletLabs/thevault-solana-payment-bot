import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { utils } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  type Connection,
  type SignatureStatus,
  type VersionedTransaction,
} from "@solana/web3.js";
import {
  createVersionedTransaction,
  sendTransactionWithRetry,
  TransactionPendingError,
  waitForConfirmation,
} from "../transaction";

// No Connection is constructed: these plain objects implement every RPC used
// by transaction.ts, so all signing and serialization stay entirely offline.
function fixture(
  t: TestContext,
  options: { status?: SignatureStatus | null; blockHeight?: number } = {},
) {
  const payer = Keypair.generate();
  const sender = Keypair.generate();
  const recipient = Keypair.generate();
  const instructions = () => [
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 1,
    }),
  ];
  const events: string[] = [];
  const blockhashes: { blockhash: string; lastValidBlockHeight: number }[] = [];
  const sent: VersionedTransaction[] = [];
  const status = options.status === undefined
    ? { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" as const }
    : options.status;
  const rpc = {
    getLatestBlockhash: t.mock.fn(async (commitment?: string) => {
      assert.equal(commitment, "finalized");
      events.push("blockhash");
      const latest = {
        blockhash: new PublicKey(new Uint8Array(32).fill(blockhashes.length + 1)).toBase58(),
        lastValidBlockHeight: 100,
      };
      blockhashes.push(latest);
      return latest;
    }),
    simulateTransaction: t.mock.fn(async (_transaction: VersionedTransaction) => {
      events.push("simulate");
      return { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1_000 } };
    }),
    sendTransaction: t.mock.fn(async (transaction: VersionedTransaction) => {
      events.push("send");
      sent.push(transaction);
      return `offline-signature-${sent.length}`;
    }),
    getSignatureStatuses: t.mock.fn(async (
      _signatures: string[],
      _config?: { searchTransactionHistory: boolean },
    ) => ({ context: { slot: 1 }, value: [status] })),
    getBlockHeight: t.mock.fn(async (commitment?: string) => {
      assert.equal(commitment, "confirmed");
      return options.blockHeight ?? 50;
    }),
  };
  return {
    payer, sender, instructions, events, blockhashes, sent, rpc,
    connection: rpc as unknown as Connection,
  };
}

function assertValidSignatures(transaction: VersionedTransaction) {
  const message = transaction.message.serialize();
  const required = transaction.message.header.numRequiredSignatures;
  assert.equal(transaction.signatures.length, required);
  transaction.signatures.forEach((signature, index) => {
    assert.ok(signature.some((byte) => byte !== 0), `signer ${index} is not a placeholder`);
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"), // Ed25519 SPKI prefix
        transaction.message.staticAccountKeys[index].toBuffer(),
      ]),
      format: "der",
      type: "spki",
    });
    assert.ok(verify(null, message, publicKey, signature), `signer ${index} signs this message`);
  });
}

function mockClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const previous = process.env.CONFIRM_TIMEOUT_MS;
  process.env.CONFIRM_TIMEOUT_MS = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.CONFIRM_TIMEOUT_MS;
    else process.env.CONFIRM_TIMEOUT_MS = previous;
    t.mock.timers.reset();
  });
}

// Yield through real setImmediate to drain async RPC continuations, then move
// only the mocked clock. No dependency on the implementation's sleep lengths.
async function advanceUntilSettled<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  let settled = false;
  const completion = promise.finally(() => { settled = true; });
  void completion.catch(() => {});
  for (let turn = 0; turn < 100 && !settled; turn++) {
    await setImmediate();
    if (!settled) t.mock.timers.tick(60_000);
  }
  assert.ok(settled, "operation settles within the bounded virtual-time budget");
  return completion;
}

test("build fetches a fresh blockhash after simulation on every build", async (t) => {
  const f = fixture(t);
  for (let build = 0; build < 2; build++) {
    const result = await createVersionedTransaction(
      f.connection, f.instructions(), f.payer.publicKey, false, [],
    );
    const simulated = f.rpc.simulateTransaction.mock.calls[build].arguments[0];
    assert.equal(simulated.message.recentBlockhash, f.blockhashes[build * 2].blockhash);
    assert.deepEqual(result.latestBlockhash, f.blockhashes[build * 2 + 1]);
    assert.equal(result.transaction.message.recentBlockhash, result.latestBlockhash.blockhash);
    assert.notEqual(result.transaction.message.recentBlockhash, simulated.message.recentBlockhash);
  }
  assert.deepEqual(f.events, ["blockhash", "simulate", "blockhash", "blockhash", "simulate", "blockhash"]);
  assert.equal(f.rpc.sendTransaction.mock.callCount(), 0);
});

test("confirmed send returns the RPC hash and automatically signs the omitted fee payer", async (t) => {
  const f = fixture(t);
  const hash = await sendTransactionWithRetry(
    f.connection, f.instructions(), [f.sender], f.payer, [],
  );
  assert.equal(hash, "offline-signature-1");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.staticAccountKeys[0].toBase58(), f.payer.publicKey.toBase58());
  assert.equal(f.sent[0].message.header.numRequiredSignatures, 2);
  assertValidSignatures(f.sent[0]);
  assert.deepEqual(f.rpc.getSignatureStatuses.mock.calls[0].arguments, [
    [hash], { searchTransactionHistory: true },
  ]);
});

test("duplicate and unrelated signers do not prevent required signatures", async (t) => {
  const f = fixture(t);
  await sendTransactionWithRetry(
    f.connection, f.instructions(), [f.payer, f.sender, f.sender, Keypair.generate()], f.payer, [],
  );
  assert.equal(f.sent.length, 1);
  assertValidSignatures(f.sent[0]);
});

test("missing required instruction signer is refused before broadcasting or polling", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    sendTransactionWithRetry(f.connection, f.instructions(), [], f.payer, []),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Refusing to send: no signer for required signer/);
      assert.ok(error.message.includes(f.sender.publicKey.toBase58()));
      return true;
    },
  );
  assert.equal(f.rpc.sendTransaction.mock.callCount(), 0);
  assert.equal(f.rpc.getSignatureStatuses.mock.callCount(), 0);
});

test("on-chain failure rejects with the signature and error without retrying", async (t) => {
  const err = { InstructionError: [0, { Custom: 42 }] };
  const f = fixture(t, {
    status: { slot: 1, confirmations: 1, confirmationStatus: "confirmed", err },
  });
  const preRebroadcast = t.mock.fn(async () => true);
  await assert.rejects(
    sendTransactionWithRetry(
      f.connection, f.instructions(), [f.sender], f.payer, [], 0, { preRebroadcast },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TransactionPendingError));
      assert.ok(error.message.includes("Transaction offline-signature-1 failed on-chain"));
      assert.ok(error.message.includes(JSON.stringify(err)));
      return true;
    },
  );
  assert.equal(f.sent.length, 1);
  assert.equal(preRebroadcast.mock.callCount(), 0);
});

for (const outcome of ["pending", "expired"] as const) {
  test(`preRebroadcast=false on ${outcome} throws TransactionPendingError without resending`, async (t) => {
    if (outcome === "pending") mockClock(t);
    const f = fixture(t, { status: null, blockHeight: outcome === "expired" ? 101 : 50 });
    const preRebroadcast = t.mock.fn(async (_signature: string) => false);
    const sending = sendTransactionWithRetry(
      f.connection, f.instructions(), [f.sender], f.payer, [], 0, { preRebroadcast },
    );
    const rejection = assert.rejects(sending, (error: unknown) => {
      assert.ok(error instanceof TransactionPendingError);
      assert.equal(error.name, "TransactionPendingError");
      assert.equal(error.signature, "offline-signature-1");
      assert.ok(error.message.includes(`unsettled (${outcome})`));
      assert.match(error.message, /outcome uncertain/);
      if (outcome === "expired") assert.match(error.message, /rebroadcast was suppressed/);
      return true;
    });
    if (outcome === "pending") await advanceUntilSettled(t, rejection);
    else await rejection;
    assert.deepEqual(
      preRebroadcast.mock.calls.map((call) => call.arguments),
      outcome === "expired" ? [["offline-signature-1"]] : [],
    );
    assert.equal(f.sent.length, 1);
    assert.equal(f.rpc.getLatestBlockhash.mock.callCount(), 2);
    assertValidSignatures(f.sent[0]);
  });
}

for (const status of [null, {
  slot: 1, confirmations: 0, err: null, confirmationStatus: "processed" as const,
}]) {
  test(`pending ${status?.confirmationStatus ?? "null"} status never rebuilds even with preRebroadcast=true`, async (t) => {
    mockClock(t);
    // A processed status remains pending even past the blockhash expiry height.
    const f = fixture(t, { status, blockHeight: status ? 101 : 50 });
    const preRebroadcast = t.mock.fn(async () => true);
    const rejection = assert.rejects(
      sendTransactionWithRetry(
        f.connection, f.instructions(), [f.sender], f.payer, [], 0, { preRebroadcast },
      ),
      (error: unknown) => {
        assert.ok(error instanceof TransactionPendingError);
        assert.equal(error.signature, "offline-signature-1");
        assert.match(error.message, /unsettled \(pending\).*outcome uncertain/);
        return true;
      },
    );
    await advanceUntilSettled(t, rejection);
    assert.equal(preRebroadcast.mock.callCount(), 0);
    assert.equal(f.sent.length, 1);
    assert.equal(f.rpc.getLatestBlockhash.mock.callCount(), 2);
  });
}

test("processed status times out as pending rather than being treated as confirmed", async (t) => {
  mockClock(t);
  const f = fixture(t, {
    status: { slot: 1, confirmations: 0, err: null, confirmationStatus: "processed" },
  });
  assert.deepEqual(
    await advanceUntilSettled(t, waitForConfirmation(f.connection, "offline-signature", 100, 1)),
    { kind: "pending" },
  );
});

test("finalized status is a landed confirmation", async (t) => {
  const f = fixture(t, {
    status: { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" },
  });
  assert.deepEqual(await waitForConfirmation(f.connection, "offline-signature", 100, 1), { kind: "landed" });
});

test("expired broadcasts stop after three attempts and preserve the last signature", async (t) => {
  const f = fixture(t, { status: null, blockHeight: 101 });
  const preRebroadcast = t.mock.fn(async (_signature: string) => true);
  await assert.rejects(
    sendTransactionWithRetry(
      f.connection, f.instructions(), [f.sender], f.payer, [], 0, { preRebroadcast },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TransactionPendingError);
      assert.equal(error.signature, "offline-signature-3");
      assert.match(error.message, /after 3 broadcast\(s\)/);
      return true;
    },
  );
  assert.equal(f.sent.length, 3);
  assert.deepEqual(preRebroadcast.mock.calls.map((call) => call.arguments), [
    ["offline-signature-1"], ["offline-signature-2"],
  ]);
  assert.equal(new Set(f.sent.map((tx) => tx.message.recentBlockhash)).size, 3);
  f.sent.forEach((tx, index) => {
    assert.equal(tx.message.recentBlockhash, f.blockhashes[index * 2 + 1].blockhash);
    assertValidSignatures(tx);
  });
});

for (const method of ["getSignatureStatuses", "getBlockHeight"] as const) {
  test(`${method} Timeout after successful send is uncertain and never retries`, async (t) => {
    const f = fixture(t, { status: null });
    f.rpc[method].mock.mockImplementation(async () => { throw new Error("Timeout: offline polling failure"); });
    const preRebroadcast = t.mock.fn(async () => true);
    await assert.rejects(
      sendTransactionWithRetry(
        f.connection, f.instructions(), [f.sender], f.payer, [], 0, { preRebroadcast },
      ),
      (error: unknown) => {
        assert.ok(error instanceof TransactionPendingError);
        assert.equal(error.signature, "offline-signature-1");
        assert.match(error.message, /confirmation polling failed.*Timeout.*outcome uncertain/);
        return true;
      },
    );
    assert.equal(f.sent.length, 1);
    assert.equal(f.rpc.getLatestBlockhash.mock.callCount(), 2);
    assert.equal(preRebroadcast.mock.callCount(), 0);
  });
}

for (const message of ["Timeout: offline send failure", "fetch failed", "block height exceeded"]) {
  test(`ambiguous send error (${message}) preserves the local signature without resending`, async (t) => {
    const f = fixture(t);
    f.rpc.sendTransaction.mock.mockImplementation(async (transaction) => {
      f.sent.push(transaction);
      throw new Error(message);
    });
    const preRebroadcast = t.mock.fn(async () => true);
    await assert.rejects(
      sendTransactionWithRetry(
        f.connection, f.instructions(), [f.sender], f.payer, [], 0, { preRebroadcast },
      ),
      (error: unknown) => {
        assert.ok(error instanceof TransactionPendingError);
        assert.equal(error.signature, utils.bytes.bs58.encode(f.sent[0].signatures[0]));
        assert.ok(error.message.includes(message));
        assert.match(error.message, /outcome uncertain/);
        return true;
      },
    );
    assert.equal(f.rpc.sendTransaction.mock.callCount(), 1);
    assert.equal(f.rpc.getLatestBlockhash.mock.callCount(), 2);
    assert.equal(f.rpc.getSignatureStatuses.mock.callCount(), 0);
    assert.equal(preRebroadcast.mock.callCount(), 0);
    assertValidSignatures(f.sent[0]);
  });
}

for (const failure of [
  new Error("failed to send transaction: Transaction simulation failed: insufficient funds"),
  new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "insufficient funds" }),
]) {
  test(`definite preflight rejection is preserved (${failure.constructor.name})`, async (t) => {
    const f = fixture(t);
    f.rpc.sendTransaction.mock.mockImplementation(async () => { throw failure; });
    await assert.rejects(
      sendTransactionWithRetry(f.connection, f.instructions(), [f.sender], f.payer, []),
      (error: unknown) => {
        assert.equal(error, failure);
        return true;
      },
    );
    assert.equal(f.rpc.sendTransaction.mock.callCount(), 1);
    assert.equal(f.rpc.getLatestBlockhash.mock.callCount(), 2);
    assert.equal(f.rpc.getSignatureStatuses.mock.callCount(), 0);
  });
}

test("expired rebroadcast guard errors preserve the hash without resending", async (t) => {
  const f = fixture(t, { status: null, blockHeight: 101 });
  const preRebroadcast = t.mock.fn(async () => { throw new Error("Timeout: balance read failed"); });
  await assert.rejects(
    sendTransactionWithRetry(
      f.connection, f.instructions(), [f.sender], f.payer, [], 0, { preRebroadcast },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TransactionPendingError);
      assert.equal(error.signature, "offline-signature-1");
      assert.match(error.message, /rebroadcast check failed.*outcome uncertain/);
      return true;
    },
  );
  assert.equal(f.sent.length, 1);
  assert.equal(f.rpc.getLatestBlockhash.mock.callCount(), 2);
  assert.equal(preRebroadcast.mock.callCount(), 1);
});

for (const failure of [
  new Error("failed to send transaction: Transaction simulation failed: Blockhash not found"),
  new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "Blockhash not found" }),
]) {
  test(`definite preflight blockhash rejection stops after five retries (${failure.constructor.name})`, async (t) => {
    mockClock(t);
    const f = fixture(t);
    f.rpc.sendTransaction.mock.mockImplementation(async (transaction) => {
      f.sent.push(transaction);
      throw failure;
    });
    const rejection = assert.rejects(
      sendTransactionWithRetry(f.connection, f.instructions(), [f.sender], f.payer, []),
      (error: unknown) => {
        assert.equal(error, failure);
        return true;
      },
    );
    await advanceUntilSettled(t, rejection);
    assert.equal(f.rpc.sendTransaction.mock.callCount(), 6);
    assert.equal(f.rpc.getSignatureStatuses.mock.callCount(), 0);
    assert.equal(new Set(f.sent.map((tx) => tx.message.recentBlockhash)).size, 6);
    f.sent.forEach(assertValidSignatures);
  });
}
