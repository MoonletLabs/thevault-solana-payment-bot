# SaaS payment bot

A bot for validators that pays invoices from The Vault's SaaS and
community-pool invoicers in vSOL and VLP, with optional Discord payment and
directed-stake rank alerts. Payments use a funded wallet and your validator's
vote account public key.

This fork deliberately deletes the upstream GitHub Actions workflow and does
**not** include an Actions workflow or a daily cron. Run it locally as described
below; any scheduling must be configured separately.

## Setup

1. Install **Node.js >=18** and **Yarn 1.x**, then install dependencies from the
   repository root:

   ```bash
   yarn install --frozen-lockfile
   ```

2. Create a local `.env` file:

   ```dotenv
   RPC_URL=https://your-solana-rpc.example
   PRIVATE_KEY='[your complete payer keypair JSON byte array]'
   VOTE_KEY=your-validator-vote-account-public-key
   # Optional:
   # DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
   # RANK_ALERT_THRESHOLD=80
   ```

   - `RPC_URL`: an RPC that supports `getProgramAccounts` (Helius, Triton, …).
     If yours does not, also set `INVOICERS` (see below).
   - `PRIVATE_KEY`: replace the placeholder with the complete JSON byte array
     from your payer keypair file (e.g. the output of `cat my-key.json`). This
     wallet needs SOL for fees and token funding, and holds vSOL/VLP
     automatically. Keep the key and `.env` private.
   - `VOTE_KEY`: your validator vote account's public key, not its private key.
   - The webhook and rank threshold are optional; see the sections below.

3. Run diagnostics first (no private key required; see Diagnostics), then run
   the payment bot when ready:

   ```bash
   yarn run run
   ```

   **`yarn run run` executes REAL payments** on the cluster selected by
   `RPC_URL`, including spending SOL to obtain settlement tokens when needed.

## What it pays

Invoices are discovered on-chain by scanning the `epoch-invoicer` program for
invoice accounts owned by your vote account — this covers **every invoicer
that bills you**, currently four:

| invoicer | settlement token |
| --- | --- |
| `Fn5FbRbJ…` (SaaS) | vSOL |
| `AzEQWHYL…` (community pool) | vSOL |
| `9HE9R14d…` (community pool) | VLP |
| `DzWNQFv5…` (SaaS) | VLP |

The bot reads each invoicer's settlement `mint` from the invoicer account
itself and pays with that token.

### Security: only trusted invoicers are ever paid

`create_invoicer` on this program is **permissionless** — anyone can deploy an
invoicer (settlement token included, even vSOL or VLP) and issue invoices
against any vote account for any amount. Discovery above is therefore broad,
but payment is gated: **invoices from invoicers outside the trusted list below
are skipped, not paid**, and a `SECURITY:` line names them.

Trusted invoicers: `Fn5FbRbJ…`, `AzEQWHYL…`, `9HE9R14d…`, `DzWNQFv5…`
(override the set with `INVOICERS`).

When The Vault adds a new invoicer, add its address to `INVOICERS` — and
verify the address through official channels first (an invoicer's `owner`
field must have signed its creation, so the vault-owned SaaS invoicers carry
the vault multisig there); do not paste an address out of a DM.
`ALLOW_UNTRUSTED_INVOICERS=1` overrides the gate (logs a WARNING) for e.g.
an invoicer rotation you already verified.

## Funding

If your wallet lacks the token an invoice settles in, the bot buys it with
SOL inside the run:

- vSOL: deposited into the Vault stake pool (`@solana/spl-stake-pool`).
- VLP: minted by The Vault's liquid unstaker (`deposit_sol`), the same route
  the dapp's “Pay” button uses. Estimated from the pool's SOL/VLP rate with a
  30% margin — the surplus just stays in your VLP balance for later runs.

A token whose top-up fails (price oracle down, pool deposit caps, no SOL) is
skipped for that run; invoices already covered by your balances still get
paid. If invoices remain unpaid because funding failed or balances are short,
the run reports a failure (or an uncertainty warning for pending funding) and
exits nonzero, after paying any covered invoices. Funding transactions are
confirmed (polled to `confirmed`/`finalized`)
**before** balances are re-read and before anything is paid — balances are
read at `confirmed`, never off a pre-funding read. A transaction that is still
pending, or whose send/confirmation RPC outcome is ambiguous, is not rebuilt:
it may still land. Only after confirmed blockhash expiry with no transaction
status may it be rebuilt and re-broadcast up to twice, subject to a balance
guard: if **any funded mint** is already covered by its confirmed balance,
the guard stops re-broadcasting the **whole transaction**, including funding
for other mints in it. Ambiguous funding outcomes are deferred rather than
assumed to have failed; invoices without confirmed funding wait for a later
run. If a funding transaction lands after the run, the next run sees the
bought balance and can pay without re-funding.
Invoices are paid oldest-first (max `MAX_INVOICES_PER_RUN`, default 10,
within `LOOKBACK_EPOCHS`, default 20) so old invoices never age out unpaid.

## Diagnostics

```bash
yarn install --frozen-lockfile
RPC_URL=https://your-solana-rpc.example VOTE_KEY=your-vote-account LIST_ONLY=1 yarn run run
```

`LIST_ONLY=1` prints the unpaid invoices, resolved settlement mints, balances
and planned top-ups, and builds the pay instructions without signing or
sending transactions. **No `PRIVATE_KEY` is required.** It also disables all
Discord webhooks and rank requests, even when a webhook is configured. With
`RPC_URL` and `VOTE_KEY` in `.env`, use `LIST_ONLY=1 yarn run run`.

## Discord notifications (optional)

Set `DISCORD_WEBHOOK_URL` in `.env` to receive rich embeds in that Discord
channel during non-list runs:

- **Confirmed payments:** a success notification for each confirmed payment
  chunk, with the number of invoices paid, totals reported separately for
  **vSOL and VLP**, a clickable Solscan transaction link, and the epochs paid.
  Confirmed chunks remain successful even if a later chunk fails; those
  earlier payments and success notifications are preserved.
- **Definitive failures:** a failure notification with the error details.
- **Pending payments:** a warning that confirmation is unresolved, not a
  definitive failure notification. A pending transaction may still land.

When no invoices are paid, there is no invoice-payment success notification.
The rank check below may still send an alert, including on a run with no
payments.

To create a webhook:

1. In Discord, go to the target channel → **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook**.
2. Copy the webhook URL.
3. Add it to your local `.env` as `DISCORD_WEBHOOK_URL`.

If the variable is not set, Discord notifications are skipped. Webhook errors
are logged without crashing the bot.

### Directed-stake rank alerts

The bot checks your validator's rank on The Vault's **Directed Stake Leaders**
board once after each non-list run, including runs with no payments. With a
webhook configured, it sends an alert if the validator is missing from the
board or its numerical rank is **greater than `RANK_ALERT_THRESHOLD`** (for
example, rank 81 with the default threshold of 80). Rank 80 does not trigger
that threshold alert.

`RANK_ALERT_THRESHOLD` defaults to **80**, must be a **positive integer**, and
is read after `dotenv` loads `.env`, so a value configured there is honored.
Rank-check errors are logged without changing payment outcomes. `LIST_ONLY=1`
skips rank requests and all webhook notifications.

## Config (optional env)

| var | default | meaning |
| --- | --- | --- |
| `LIST_ONLY` | unset | `1`: keyless diagnostics only; never signs or sends transactions, sends webhooks, or requests rank data. |
| `DISCORD_WEBHOOK_URL` | unset | Discord webhook for confirmed payment chunks, failure/pending notifications, and rank alerts; disabled in list-only mode. |
| `RANK_ALERT_THRESHOLD` | `80` | Positive integer, read after `.env` is loaded; alert when rank is greater than this threshold or the validator is missing. |
| `MAX_INVOICES_PER_RUN` | `10` | cap per run (oldest first). |
| `LOOKBACK_EPOCHS` | `20` | ignore unpaid invoices older than this. |
| `INVOICERS` | built-in list of the four known invoicers | comma-separated **trusted** invoicer addresses: invoices from any other invoicer are never paid, and this set is also the PDA fallback source for scan-less RPCs. Update it when The Vault adds an invoicer — see Security above. |
| `ALLOW_UNTRUSTED_INVOICERS` | unset | `1`: pay invoices from untrusted invoicers (logs WARNING). Only after verifying a new/rotated invoicer out-of-band. |
| `CONFIRM_TIMEOUT_MS` | `90000` | Wall-clock bound per confirmation poll. A timeout defers the transaction without rebuilding. Fresh broadcasts (max 2) require blockhash expiry with no transaction status and passing retry guards. |
| `VERBOSE` | unset | `1`: also print the raw base64 of every built transaction (default output is quiet: `sent <sig>` + outcome only). |
| `FORCE_PDA_FALLBACK` | unset | `1`: skip the program scan and use the PDA/`INVOICERS` path (to test it against your RPC). |

## Offline regression tests

After installing dependencies, run the offline regression suite:

```bash
npx tsx --test tests/*.test.ts
```

The upstream run script also uses `npx tsx`; `tsx` is not installed by the
dependency manifest, so `npx` may download the runner. If it is already cached,
use `npm exec --offline -- tsx --test tests/*.test.ts` to avoid downloads.
The tests mock RPCs and webhooks and never use your `.env` or wallet credentials.

## Testing against a mainnet fork (Surfpool)

`./surfpool-e2e.sh` proves the whole flow — invoice discovery, SOL→vSOL and SOL→VLP (liquid unstaker) funding, payment, idempotency —
against a **local mainnet fork** served by [Surfpool](https://github.com/surfpool/surfpool)
(tested with surfpool 1.5.0). It never talks to real mainnet with your wallet:
every transaction goes to the fork; accounts are materialized on demand from
the public RPC. No secrets, no funds — the payer is a throwaway keypair funded
by the fork's `requestAirdrop`.

```bash
yarn install --frozen-lockfile          # once
./surfpool-e2e.sh                       # starts a fork on :8899, runs the suite, stops it
FORK_PORT=9099 ./surfpool-e2e.sh        # if 8899 is taken (e.g. by a local validator)
```

Steps (each maps to one exit code — `0` all green, `2` setup, `3`–`9` per step):

| step | proves |
| --- | --- |
| A | throwaway payer funded via `requestAirdrop` on the fork |
| B | the validator's real unpaid invoices (incl. the VLP one) are visible & unpaid |
| E1 | `LIST_ONLY=1` (keyless) serializes/sends nothing (fork tx count unchanged) |
| E2 | an **unfunded** wallet reports unpaid invoices with a nonzero exit: nothing sent, no retry loop |
| C | full run: the funding the due tokens require lands confirmed and every due invoice is paid |
| D | invoices flip to `outstanding=0`, wallet deltas sane, immediate re-run pays nothing |
| F | keyless `selftest.ts` against the public RPC (skip with `SKIP_SELFTEST=1`) |

Env overrides: `VOTE_KEY`, `FORK_RPC` (attach to an already-running fork; then
nothing is started or killed — but its state is mutated), `DATASOURCE_RPC`,
`SURFPOOL_BIN`, `PAYER` (reuse a keypair), `AIRDROP_LAMPORTS`, plus the bot's
own `INVOICERS` / `LOOKBACK_EPOCHS` / `MAX_INVOICES_PER_RUN`. Logs land in the
printed `/tmp/saas-e2e.*` work dir; the fork is killed at exit. Step B fails
loudly if the vote has no unpaid invoices on the fork (i.e. real state changed)
— that's a stale expectation, not a bot bug.

**Why no delegation setup is needed:** the bot pays with `pay_invoice`, whose
`source_authority` is the owner of your own vSOL/VLP token accounts — the bot
signs and pays from the wallet in `PRIVATE_KEY` directly. (`pay_invoice` also
accepts a delegate authority — that's the validator-side auto-debit crank —
but the bot never needs it.) A fresh throwaway wallet is therefore enough to
reach the full-success path on the fork.

What the fork proves vs. the real run: on-chain mechanics (layouts, PDAs,
both fundings, payment, idempotency, degradation paths) are fully exercised
against real mainnet state. What only the real validator run proves: the fork
copies mainnet balances/rates at materialization time but slot/sysvar drift is
simulated — final confirmation, priority-fee behavior under congestion, and
actual value leaving your wallet are mainnet-only facts.
