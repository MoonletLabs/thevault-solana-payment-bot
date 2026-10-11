import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
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
    if (retryNum >= 900) {
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

// 100 retries of a tx that keeps expiring (each round: CU estimation, 120s
// send window, blockhash lifetime) meant hours of stale-signature polling.
// With a fresh blockhash per attempt, a handful of retries covers
// propagation races; anything beyond that is a real error.
const MAX_RETRIES = 10;

export const sendTransactionWithRetry = async (
  connection: Connection,
  txs: TransactionInstruction[],
  allSigners: Signer[],
  payerKey: Signer,
  atas: AddressLookupTableAccount[],
  retryNum = 0,
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

  console.log(Buffer.from(vt.transaction.serialize()).toString("base64"));

  try {
    const hash = await Promise.race([
      (async () => {
        const hash = await connection.sendTransaction(vt.transaction);
        await connection.confirmTransaction(
          {
            signature: hash,
            ...vt.latestBlockhash,
          },
          "processed",
        );
        return hash;
      })(),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 120000));
        throw Error("Timeout");
      })(),
    ]);
    return hash;
  } catch (e: any) {
    console.log(e.message);
    const conditions = [
      "Timeout",
      "failed to send transaction: Transaction simulation failed: Blockhash not found",
      "block height exceeded",
    ];
    if (
      conditions.some(
        (condition) => e.message.includes(condition) && retryNum < MAX_RETRIES,
      )
    ) {
      console.log("Retrying...", retryNum, "-", e.message);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return sendTransactionWithRetry(
        connection,
        txs,
        allSigners,
        payerKey,
        atas,
        retryNum + 1,
      );
    } else {
      console.log("TX failed");
      console.log(Buffer.from(vt.transaction.serialize()).toString("base64"));
      throw e;
    }
  }
};
