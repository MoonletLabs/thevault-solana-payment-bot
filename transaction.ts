import { utils } from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  Signer,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const getCUsForTx = async (
  connection: Connection,
  latestBlockhash: Awaited<ReturnType<typeof connection.getLatestBlockhash>>,
  txs: TransactionInstruction[],
  payerKey: PublicKey,
  retryNum = 0,
) => {
  const messageV0 = new TransactionMessage({
    payerKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: txs,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.unitsConsumed === 0) {
    if (retryNum >= 10) {
      return 1.4e6;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return getCUsForTx(
      connection,
      latestBlockhash,
      txs,
      payerKey,
      retryNum + 1,
    );
  }
  const CUs = simulation.value.unitsConsumed ?? 1.4e6;
  return CUs;
};

export const createVersionedTransaction = async (
  connection: Connection,
  txs: TransactionInstruction[],
  payerKey: PublicKey,
  addCUs: boolean,
  atas: AddressLookupTableAccount[],
) => {
  // CU estimation gets its own throwaway blockhash (simulation ignores
  // expiry) and may poll for a while — the blockhash that SHIPS with the tx
  // is fetched only after it, right before compiling (see below), so a slow
  // estimation can no longer stale the blockhash the tx is sent with.
  const estimateBlockhash = await connection.getLatestBlockhash("finalized");
  const CUs = await getCUsForTx(connection, estimateBlockhash, txs, payerKey);
  console.log("CUs:", CUs);

  if (addCUs) {
    txs.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: CUs + 100000, // +1000 for safety and the CU limit ix itself
      }),
    );

    const priorityFee = 0.0001 * LAMPORTS_PER_SOL * 1e6;
    txs.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.ceil(priorityFee / CUs),
      }),
    );
  }

  // Fresh blockhash per build (= per send attempt): the instructions may be
  // pre-built, but the VersionedTransaction is always re-created.
  const latestBlockhash = await connection.getLatestBlockhash("finalized");
  const messageV0 = new TransactionMessage({
    payerKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: txs,
  }).compileToV0Message(atas);
  const transaction = new VersionedTransaction(messageV0);
  return { transaction, latestBlockhash };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Result of bounded confirmation polling. 'landed' is the only outcome after
 * which reading on-chain state at 'confirmed' is guaranteed to reflect the tx.
 */
export type ConfirmationOutcome =
  | { kind: "landed" }
  | { kind: "failed"; err: unknown }
  /** block height passed lastValidBlockHeight with no status — can no longer land */
  | { kind: "expired" }
  /** wall-clock timeout, status still null/processed */
  | { kind: "pending" };

/**
 * Poll getSignatureStatuses until the signature is confirmed/finalized, dies
 * (expired blockhash), errors on-chain, or wall-clock runs out. Deliberately
 * NOT Connection.confirmTransaction: at commitment 'processed' it resolves the
 * moment the RPC has seen the tx processed, and the then-immediate balance
 * re-reads (RPC default commitment 'finalized') still showed the PRE-tx state
 * — the field bug where a landed funding tx was read as "Still short".
 */
export const waitForConfirmation = async (
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  timeoutMs: number,
): Promise<ConfirmationOutcome> => {
  const deadline = Date.now() + timeoutMs;
  do {
    const status = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) return { kind: "failed", err: status.err };
    if (
      status &&
      (status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized")
    ) {
      return { kind: "landed" };
    }
    if (
      !status &&
      (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight
    ) {
      return { kind: "expired" };
    }
    await sleep(Math.min(2000, deadline - Date.now()));
  } while (Date.now() < deadline);
  return { kind: "pending" };
};

/** A broadcast may have landed, but its outcome has not been established. */
export class TransactionPendingError extends Error {
  constructor(
    public signature: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "TransactionPendingError";
  }
}

export interface SendOptions {
  /**
   * Called before rebuilding an EXPIRED tx: return false to skip the
   * re-send — e.g. for a funding tx whose effect is already covered by the
   * (re-read, confirmed) balance, where re-sending would buy the tokens twice.
   */
  preRebroadcast?: (signature: string) => Promise<boolean>;
}

// Only definite preflight blockhash rejections are safe to retry this way.
const MAX_RETRIES = 5;

// Only an expired broadcast gets fresh rebuilds; a live pending tx may still land.
const MAX_REBROADCASTS = 2;

export const sendTransactionWithRetry = async (
  connection: Connection,
  txs: TransactionInstruction[],
  allSigners: Signer[],
  payerKey: Signer,
  atas: AddressLookupTableAccount[],
  retryNum = 0,
  options: SendOptions = {},
): Promise<string | undefined> => {
  // Every attempt builds from scratch: fresh blockhash + new
  // VersionedTransaction around the pre-built instructions.
  const vt = await createVersionedTransaction(
    connection,
    txs,
    payerKey.publicKey,
    retryNum === 0,
    atas,
  );

  // Filter only the required signers. The fee payer ALWAYS signs the tx and
  // is not necessarily listed in allSigners (the funding call only passes
  // instruction signers, e.g. transient stake accounts) — an unsigned payer
  // kept web3.js's zero-filled placeholder signature, which serializes fine,
  // gets accepted by RPC, and whose base58 ("111111111111111111111111111111
  // 11", i.e. all-zero bytes) is then polled as the 'signature' until the
  // blockhash expires — the "Signature 1111…1 has expired" retry spiral.
  const signerPubkeys = vt.transaction.message.staticAccountKeys
    .slice(0, vt.transaction.message.header.numRequiredSignatures)
    .map((p) => p.toString());

  const signers = [payerKey, ...allSigners].filter(
    (s, i, self) =>
      signerPubkeys.includes(s.publicKey.toString()) &&
      self.findIndex((o) => o.publicKey.equals(s.publicKey)) === i,
  );
  vt.transaction.sign(signers);

  // Never send (and never confirmTransaction on) a placeholder signature.
  const missing = vt.transaction.message.staticAccountKeys
    .slice(0, vt.transaction.message.header.numRequiredSignatures)
    .filter((_, i) => !(vt.transaction.signatures[i] as Uint8Array).some((b) => b !== 0))
    .map((p) => p.toBase58());
  if (missing.length) {
    throw Error(`Refusing to send: no signer for required signer(s) ${missing.join(", ")}`);
  }

  if (process.env.VERBOSE === "1") {
    console.log(Buffer.from(vt.transaction.serialize()).toString("base64"));
  }

  const localSignature = utils.bytes.bs58.encode(vt.transaction.signatures[0]);
  let hash: string;
  try {
    hash = await connection.sendTransaction(vt.transaction);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(message);
    const preflightRejected =
      e instanceof SendTransactionError ||
      message.includes("Transaction simulation failed:");
    const preflightMessage =
      e instanceof SendTransactionError ? e.transactionError.message : message;
    if (
      preflightRejected &&
      preflightMessage.includes("Blockhash not found") &&
      retryNum < MAX_RETRIES
    ) {
      console.log("Retrying...", retryNum, "-", message);
      await sleep(1000);
      return sendTransactionWithRetry(
        connection,
        txs,
        allSigners,
        payerKey,
        atas,
        retryNum + 1,
        options,
      );
    }
    if (preflightRejected) {
      console.log("TX failed");
      console.log(Buffer.from(vt.transaction.serialize()).toString("base64"));
      throw e;
    }
    // A lost RPC response does not prove rejection. Keep the original signature
    // so callers can verify it without risking a duplicate fresh-blockhash send.
    throw new TransactionPendingError(
      localSignature,
      `Transaction ${localSignature} send failed (${message}); outcome uncertain — verify the transaction before treating it as successful or retrying`,
    );
  }

  let outcome: ConfirmationOutcome;
  try {
    console.log(`sent ${hash}${retryNum ? ` (broadcast ${retryNum + 1})` : ""}`);
    const timeoutMs =
      Number(process.env.CONFIRM_TIMEOUT_MS ?? 90_000) || 90_000;
    outcome = await waitForConfirmation(
      connection,
      hash,
      vt.latestBlockhash.lastValidBlockHeight,
      timeoutMs,
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    throw new TransactionPendingError(
      hash,
      `Transaction ${hash} confirmation polling failed (${message}); outcome uncertain — verify the transaction before treating it as successful or retrying`,
    );
  }

  if (outcome.kind === "landed") return hash;

  if (outcome.kind === "failed") {
    console.log("TX failed", JSON.stringify(outcome.err));
    console.log(Buffer.from(vt.transaction.serialize()).toString("base64"));
    throw Error(
      `Transaction ${hash} failed on-chain: ${JSON.stringify(outcome.err)}`,
    );
  }

  if (outcome.kind === "pending") {
    throw new TransactionPendingError(
      hash,
      `Transaction ${hash} unsettled (pending); outcome uncertain — it may still land, so no rebroadcast was attempted; verify the transaction before retrying`,
    );
  }

  // Only null status past lastValidBlockHeight permits a fresh-blockhash rebuild.
  if (retryNum < MAX_REBROADCASTS) {
    let mayResend: boolean;
    try {
      mayResend =
        options.preRebroadcast === undefined
          ? true
          : await options.preRebroadcast(hash);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      throw new TransactionPendingError(
        hash,
        `Transaction ${hash} rebroadcast check failed (${message}); outcome uncertain — verify the transaction before retrying`,
      );
    }
    if (mayResend) {
      console.log(
        `tx ${hash} unsettled (${outcome.kind}) — rebuilding with a fresh blockhash and re-sending (${retryNum + 1}/${MAX_REBROADCASTS})`,
      );
      return sendTransactionWithRetry(
        connection,
        txs,
        allSigners,
        payerKey,
        atas,
        retryNum + 1,
        options,
      );
    }
    throw new TransactionPendingError(
      hash,
      `Transaction ${hash} unsettled (${outcome.kind}): rebroadcast was suppressed because on-chain state changed; outcome uncertain — verify the transaction before treating it as successful`,
    );
  }
  throw new TransactionPendingError(
    hash,
    `Transaction ${hash} still unsettled (${outcome.kind}) after ${MAX_REBROADCASTS + 1} broadcast(s)`,
  );
};
