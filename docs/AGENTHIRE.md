# Allowance x AgentHire

[AgentHire](https://github.com/shalpate/agenthire) (pinned at
`ab317f2b831a9a832898b88759b496c28a435ed4`) is a Flask marketplace. Buyers hire
AI agents over x402 (HTTP 402 plus an EIP-3009 `transferWithAuthorization` on
Mock USDC, Avalanche Fuji 43113), and agents hire other agents ("A2A").
Allowance puts a mandate in front of every one of those payments:

- a budget that can only shrink as it is passed down;
- a settlement step that checks what AgentHire's x402 server does not, starting
  with the amount: it must be AgentHire's own quote;
- a record of agents that keep trying to spend past their mandate;
- one `close()` that takes a mandate back, together with everything delegated
  under it.

Nothing in AgentHire is modified. Everything below was run against an unmodified
AgentHire on `127.0.0.1`, keyless, in its mock mode. See [What is real and what is
simulated](#what-is-real-and-what-is-simulated) before quoting any number.

```bash
bash scripts/agenthire-up.sh        # boot AgentHire (keyless, 127.0.0.1:5301; PORT=... for another port)
npm run demo:agenthire              # the story, self-asserting (AGENTHIRE_URL=http://127.0.0.1:<port> for another port)
bash scripts/agenthire-down.sh      # stop it (same PORT)
```

5301 is the default port of the up and down scripts, the demo and the audit
CLI. The demo's last line prints the exact stop command for the port it used.

## The demo

`services/orchestrator/src/agenthire-demo.ts` builds one tree:

```
fund.eth                                 the fund (root; the principal passed the World IDKit mock)
└── luckin-pm.fund.eth                   capital mandate: trade LKNCY, hedge KWEB, buy data
    ├── scraper.luckin-pm.fund.eth       data sub-mandate: hire WebCrawler X (AgentHire agent 5)
    │   ├── a6-via-a5.scraper…           WebCrawler X's own sub-hire of ResearchBot Pro
    │   └── a3-via-a5.scraper…           WebCrawler X's own sub-hire of DataSift Analytics
    └── spot-check.luckin-pm.fund.eth    a 10-minute mandate that shows the settlement guard
```

The scraper's job is to pull Baidu Maps store counts, the data the Luckin pitch
rests on (see `packages/lab/src/thesis.ts`). The demo checks its own outcome at
every step, like `npm run demo`, and exits 1 if any check fails:

| Step | What happens | Checked outcome |
| --- | --- | --- |
| 1 | The fund gives the PM a 250,000 USDC capital mandate | attenuation holds |
| 2 | The PM's `QuoteBook` reads `/api/pricing/quote` for agents 5, 6 and 3 and the PM sizes the job. WebCrawler X gets exactly its quote. The two sub-agent aliases split `cap − main` pro rata to their own quotes. All three nodes are checked first, then written together (`delegateAll`) | the sub-budgets sum to `cap − main`, and the scraper has exactly the quote left |
| 3 | The scraper hires WebCrawler X over x402 | `SETTLED` in mock mode and confirmed by AgentHire (not UNCONFIRMED). AgentHire's 402 `amountMicro` equals the quote AgentHire served, and the signed permit's value equals that 402 amount. Chain 43113, token = MockUSDC and recipient = EscrowPayment, all from `/api/onchain/info`. `validBefore` is no later than the mandate expiry. The signature recovers to the payer |
| 3b | From the 10-minute mandate: a 1-micro-USDC "typed" amount, then the real quote | both refused before anything is signed: "amount 1 != AgentHire quote", then "validBefore … outlives the mandate" |
| 4 | Acting for WebCrawler X (**scripted** by the demo), its alias hires ResearchBot Pro (A2A, `/api/sim/trigger-direct`) | `SETTLED`, tagged `allowance:<node>#<seq>`. The tag appears in AgentHire's own event log |
| 4b | Acting for WebCrawler X (**scripted**), its other alias fires one more DataSift hire than it holds, all at the same instant | exactly the hires that fit settle, one is `BLOCKED_MANDATE`, and the alias never goes below zero. Every payment and `close()` goes through a `SerializedPayer`, whose queues are shared per root by every payer in the process |
| 5 | Acting for WebCrawler X (**scripted, simulated behaviour**), the demo asks for 10 more calls at once, twice | `BLOCKED_MANDATE` twice. The second attempt records incident `ALW-INC-1` against agent 5 and its operator in Allowance's incident file, noting that the attempts were scripted. It is also sent to AgentHire's dispute route, which answers `pending_review` and only prints it to its server log. AgentHire's own incident count and stake are unchanged (the check allows for any slash its simulator makes during the window) |
| 6 | A second buyer, in a different tree with its own operator registry, screening, settlement and quote book, hires WebCrawler X at the quote. Its incident ledger is a new object that loads the incident file from disk, as another process or a restart would | `BLOCKED_SCREENING`: the operator has an Allowance incident. Nothing is signed or sent |
| 7 | Agents are bound to operators | AlphaTrader AI and FinanceGPT (both QuantEdge Labs) have one (mock) nullifier, so they are one counterparty |
| 8 | The PM re-quotes and funds the scraper's **next** scrape (`planHire` again). The allocator then runs swarm's `nextLadderState` on the PM's virtual return path: the Tiger overlay on arena world #3, synthetic. It cuts at 10% drawdown and stops out at 20%. The stop-out is one `tree.close(luckin-pm)` | before the close, the scraper and both aliases each hold at least one hire at their quote. The root's available budget rises by exactly the freed amount, which is the PM budget minus everything its subtree spent. The data subtree's unspent budget goes from positive to 0, and the same quote-priced hires from all three nodes are then `REVOKED` |
| 9 | Shadow audit of AgentHire's own A2A hires (below) | the headline prints with its budget assumption; the by-definition `strict` total matches an independent count of the linked hires |

On success it writes `apps/web/public/agenthire-snapshot.json`, the core
`Snapshot` schema written by `writeSnapshotFile`, which the dashboard renders.
It also writes `apps/web/public/agenthire-receipts.json` with every settlement
attempt (the signed permit, the challenge, AgentHire's answer, and whether it
was unconfirmed), the quotes, both hire plans, the incidents, the operator
bindings, the ladder transitions, the audit report and honesty notes that are
built from what the run actually did (mode, host, how many permits were answered
`mock`, reported a real tx, or stayed unconfirmed). A run with a failed check
writes `*.failed.json` next to them instead (git-ignored), so the committed
dashboard data is never replaced by a failing run. The permits are signed by a
throwaway in-memory wallet that holds no funds unless `AGENTHIRE_PAYER_KEY` is
set, and no key is written anywhere.

Environment variables: `AGENTHIRE_URL` (default `http://127.0.0.1:5301`; a
non-loopback URL is refused unless `AGENTHIRE_ALLOW_REMOTE=1`),
`AGENTHIRE_SETTLE` (`mock` or `fuji`), `AGENTHIRE_PAYER_KEY` (optional, for the
Fuji path; read from the environment only, never logged or written),
`AGENTHIRE_AUDIT_SECONDS` (default 20), `ALLOWANCE_INCIDENTS_FILE` (default
`.agenthire/allowance-demo-incidents.json`, emptied at the start of each run so
the story repeats), and `ARENA_SEED` (default 3; it must be below 10000, because
arena seeds from 10000 up are sealed for judging).

## What is integrated

| Piece | File | What it does |
| --- | --- | --- |
| `DelegationTree.close(name)` | `packages/core/src/tree.ts` | Shrinks every descendant, deepest first, to what its subtree spent, then shrinks and revokes the node. Returns the freed authority, which is exactly how much the parent's `available()` rises. A child that overspent (only possible with unserialized concurrent payments) keeps its budget, and its parent still counts the real spend, so no ancestor is shrunk below what its subtree spent. It is idempotent, and it also reclaims budget stranded under descendants that were revoked individually |
| `AgentHireClient` | `packages/adapters/src/agenthire.ts` | Typed client: agents, quotes, `/api/onchain/info`, reputation, stake, the x402 challenge / pay / X-Payment retry, `trigger-direct`, sim events / status / speed / `a2a-candidates`, disputes. Every non-JSON body (Flask-Limiter answers 429 with HTML), wrong shape or timeout is an `AgentHireError`. Reads time out after 15 s; the three requests that move money after 150 s, longer than AgentHire's own 30 s facilitator call and 120 s receipt wait |
| `AgentHireSettlementService` | same | Core `SettlementService` (details below). Never throws. Refusals are `settled:false` with a reason that starts `settlement:`; failures after the payment was sent are charged as UNCONFIRMED |
| `QuoteBook`, `planHire`, `delegateAll`, `aliasNodeLabel` | same | Hires are sized from quotes. `QuoteBook.fetch` reads `/api/pricing/quote` itself and is the only way to file a quote; entries are frozen and stamped with the book's clock and the AgentHire they came from. Sub-agent budgets are split pro rata into `cap − main` with largest-remainder rounding, so they sum to the micro-USDC. All the child nodes are written, or none are |
| `AgentHireScreeningService` | same | Core `ScreeningService`. Blocks when the agent is banned, below the minimum tier, over AgentHire's incident limit, or when its operator has an Allowance incident. It re-reads the incident store on every check. Fails closed when AgentHire or the incident store cannot be read |
| `OperatorRegistry` | same | Binds agent id to `{deployer_wallet, World ID nullifier}` (the nullifier comes from the World IDKit mock) |
| `IncidentLedger`, `JsonFileIncidentStore`, `OverspendWatch`, `pushIncidentReport` | same | Repeated `exceeds available` blocks become an incident keyed by agent and operator (with a provenance note, e.g. "scripted by the demo"). Without a store the ledger is in memory and local to its process; with `JsonFileIncidentStore` it is a local JSON file that any process, or the same one after a restart, reads back. The incident is also sent to AgentHire's dispute route, which keyless only logs it |
| `SerializedPayer` | same | Runs `pay()`, `close()` and other tree writes one at a time per root mandate. The queues are module-level (keyed by tree and root), so every payer in the process shares them |
| `payerSignerFromEnv` | same | The payer's signer: `AGENTHIRE_PAYER_KEY` if set (never echoed), else a throwaway |
| Shadow audit | `packages/adapters/src/agenthire-audit.ts`, `scripts/agenthire-audit.ts` | Replays AgentHire's A2A hires through `pay()`, naming merchants exactly as the adapters do (`agenthire:<id>`), so `AgentHireScreeningService` can be plugged in. See [`AGENTHIRE-SHADOW-AUDIT.md`](AGENTHIRE-SHADOW-AUDIT.md) |
| Boot scripts | `scripts/agenthire-up.sh`, `scripts/agenthire-down.sh` | Boot an unmodified, keyless AgentHire on 127.0.0.1 with one gunicorn worker, a random per-boot `API_KEY` and `CORS_ORIGINS` pinned to its own origin, and stop it. When the given port is not running, the down script names the ports that are |
| Dashboard section | `apps/web/src/App.tsx` (`#agenthire`), `apps/web/src/agenthire.ts` | Renders `agenthire-snapshot.json` with the existing `Dashboard`. The audit headline, the incident and the honesty notes come from the receipts sidecar. The lede says the PM's return path is synthetic and the nullifiers come from a World ID mock. Settled payments are tagged "AgentHire · simulated"; screening blocks are tagged "screening · operator incidents / AgentHire reputation" |

### Settlement, step by step

For every payment to `agenthire:<id>`:

1. The amount must equal AgentHire's own quote for agent `<id>`, to the
   micro-USDC. With a `QuoteBook`, that is the quote on file for the paying node
   and agent, read from this same AgentHire and at most 15 minutes old. Without
   one, settlement reads `GET /api/pricing/quote/<id>` itself, just before it
   signs. AgentHire's x402 route prices whatever `?amountUSDC=` it is asked for
   and echoes it back, so this, not the challenge, is what binds the amount.
2. Read `/api/onchain/info` (cached) for `MockUSDC` and `EscrowPayment`. The
   deployment must be on chain 43113.
3. `GET /api/x402/demo-execute/:id?amountUSDC=<amount>` must answer 402 with a
   challenge. The challenge is refused unless all of these hold:
   - `chain.chainId` and the EIP-712 domain `chainId` are both 43113, and the
     domain is `"Mock USDC"` v1;
   - `token.address` and the domain's `verifyingContract` are both MockUSDC;
   - `recipient` and `permit.template.to` are both EscrowPayment;
   - `price.amountMicro` and `permit.template.value` both equal the checked
     amount (an echo: it proves AgentHire decoded the amount exactly);
   - `validBefore` is in the future and no later than the paying node's mandate
     expiry.
4. Sign `TransferWithAuthorization` with the injected signer, using its own
   random nonce, not the server's template nonce.
5. `mock`: `POST /api/x402/pay`. `fuji`: resend the same permit as `X-Payment`
   on the x402 route.

A node whose label is an alias (`a<sub>-via-a<hirer>`) pays as its hirer. Its
payment goes through `POST /api/sim/trigger-direct` with reason
`allowance:<node>#<seq>`, where `seq` is the PAYMENT event's sequence number,
and the echoed parties and amount are checked.

**Refused or unconfirmed.** Everything up to step 4 is a refusal
(`settled:false`): nothing was sent, nothing is charged. Once the signed permit
(step 5) or the trigger-direct request has left the process, a timeout, a 5xx, a
refusal of the permit, or an answer that does not match is **UNCONFIRMED**, not
refused. AgentHire may already have booked it: its `/api/x402/pay` records the
order, and on the real path `x402_execute` broadcasts `transferWithAuthorization`
before it waits for the receipt (`onchain.py:442-445`). The permit is also a
bearer authorization until `validBefore`. So an unconfirmed payment returns
`settled:true`, core `pay()` charges the mandate, and the node cannot sign a
second permit for the same authority. The receipt says `unconfirmed: true`, the
reference starts `agenthire-unconfirmed:`, and
`AgentHireSettlementService.unconfirmedReceipts` lists them for reconciliation.
The one refusal after sending is a 4xx from `trigger-direct`, which AgentHire
answers before it books anything (`app.py:3230-3264`, `sim_engine.py:231-241`).

## The AgentHire gaps Allowance closes

All file:line references are in `shalpate/agenthire @ ab317f2`.

| # | Gap in AgentHire | Where | What Allowance does |
| --- | --- | --- | --- |
| 1 | The x402 server never compares `permit.value` with the price, and never checks `validBefore` or the nonce. An expired 1-micro-USDC permit unlocked a 5 USDC resource | `x402.py:215-246` (`require_x402`), `x402.py:131-160` (`execute_payment` forwards the permit as is) | The settlement checks the challenge against the mandate before signing. It signs only `value` = the checked amount, with `validBefore` no later than the mandate expiry and a fresh nonce |
| 2 | The x402 route lets the caller name the price with `?amountUSDC=`, and the challenge echoes it. The default is `current_price × 100` | `app.py:3900-3908` | Every payment must equal AgentHire's own `/api/pricing/quote` (`app.py:2541-2567`): the `QuoteBook` entry the hire was sized from, or a live read. A quote can only be filed by `QuoteBook.fetch`, from the AgentHire being paid |
| 3 | The chain, token and recipient in the challenge are whatever the server sends | `x402.py:58-103` (`build_challenge`) | Compared with `/api/onchain/info`: chain 43113, MockUSDC, EscrowPayment, domain "Mock USDC" v1 |
| 4 | USDC floats become micro-USDC through `int(x * 1_000_000)`, which truncates about 1.2% of 6-decimal amounts one micro low (0.000249 → 248) | `x402.py:62`, `sim_engine.py:239` | `encodeUsdcParam` picks a decimal string that decodes to exactly the intended micro amount, and settlement re-checks the echo |
| 5 | Sub-agent (A2A) fees are neither debited from nor capped by the primary job. The docstring says the primary eats them "out of its own settle", but the code books them on top, as paid from the primary agent's wallet. Checkout shows a "Hard Spend Cap … Enforced" badge that sub-agent fees are never checked against | `sim_engine.py:766-842` (`_fire_a2a_subagent_calls`), `templates/checkout.html:238-245` | Every sub-agent hire needs its own alias node under a capped job, and budgets are split pro rata into `cap − main`. The shadow audit counts how many of AgentHire's own A2A payments would have been blocked even under its displayed Hard Spend Cap |
| 6 | The A2A graph has cycles (1 hires 7 and 7 hires 1) and shared children (6 is hired by 3 and by 4) | `app.py:61-` (`A2A_WORKFLOWS`) | One alias node per (hirer, sub-agent) edge, never a node shared between parents |
| 7 | There is no keyless route that records an incident without slashing. Every incident counter moves only inside a slash. There is a `ModerationReport` table, but nothing public creates one: it is only seeded, and its admin routes (`@require_api_key`) are **open to anyone when `API_KEY` is unset**, as it is in keyless mode (`auth.py:38-41`). `/api/dispute/submit` without keys only prints the dispute to the server log and answers `pending_review` | `sim_engine.py:713-737` (`_do_slash`), `simulation.py:162-185` (`apply_slash`), `app.py:3646` (`/api/sim/slash-agent`), `models.py:256` and `:484`, `app.py:2702-2884`, `app.py:2046-2079` | `IncidentLedger` keeps the incident on the Allowance side, keyed by agent and operator, in a local JSON file other processes read back, and `pushIncidentReport` sends it to the dispute route (log only). Allowance never calls `slash-agent`: an agent stopped by its mandate did not commit misconduct. `agenthire-up.sh` sets a random per-boot `API_KEY` (never printed or stored), which closes the admin routes |
| 8 | Agents carry a `deployer_wallet` (derived from the seller name), but nothing treats two agents of one operator as one counterparty | `agent_pack.py:333-335`, `app.py:4183` | `OperatorRegistry` binds each agent to its deployer wallet and a World ID (mock) nullifier. Screening reads incidents by operator |
| 9 | The escrow is off-chain in live flows. `complete` flips a DB status and answers "Escrow released. Seller has been paid." | `app.py:2899-2915` | Allowance claims no escrow protection. The permit's `to` is the EscrowPayment address, and that is all it is |
| 10 | The money routes are unauthenticated, and `/api/*` allows CORS from any origin by default | e.g. `app.py:1989-1990` (`/api/x402/pay`, rate-limited to 30/minute), `app.py:3224` (`trigger-direct`), `app.py:40` and `config.py:42-44` (CORS) | The scripts and the demo bind to 127.0.0.1 and refuse other hosts unless told otherwise; that keeps other machines out. It does not stop pages open in a local browser, so `agenthire-up.sh` also pins `CORS_ORIGINS` to the instance's own origin: other origins cannot make JSON requests. A browser can still send "simple" requests (form or text/plain bodies); routes that need a JSON body reject them, but routes that need none (e.g. `/api/sim/start`) act on them |
| 11 | On a fresh clone, `db.create_all()` runs before the models are imported, so a fresh database gets no tables | `app.py:4189-4193` | `agenthire-up.sh` bootstraps with `python -c 'import models, app'`. There is an upstream patch below |
| 12 | A payment can be booked, or broadcast on chain, and still come back as an error or a timeout: `/api/x402/pay` records the order before it answers, and `x402_execute` broadcasts and then waits up to 120 s for the receipt | `app.py:1985-2044`, `onchain.py:442-445`, `x402.py:157-158` | A payment that was sent but not confirmed is charged to the mandate as UNCONFIRMED, never treated as refused, so the node cannot pay the same authority twice |

One more gap belongs to Allowance itself. Core `pay()` checks the budget, then
awaits screening and settlement, then books the spend. Two concurrent payments
against the same leftover budget could both pass the check (a unit test shows
it). `SerializedPayer` closes the gap by queueing every payment and `close()`
per root mandate, in queues shared by every payer in the process. It cannot
serialize writes that bypass a payer, or another process's copy of the tree.

## What is real and what is simulated

| Thing | Status |
| --- | --- |
| HTTP calls to AgentHire, its quotes, 402 challenges, reputation, stake, event log | Real: the local, unmodified server answered them |
| The checks Allowance makes before signing | Real |
| EIP-3009 signatures | Real signatures from a throwaway wallet with no funds (or the `AGENTHIRE_PAYER_KEY` wallet, if set) |
| x402 settlement in `mock` mode | **Simulated.** AgentHire answers `{status:"mock", realTx:false}` and records an Order row. Nothing moves on chain. Receipts say `simulated: true` |
| A2A hires (`/api/sim/trigger-direct`) | **Simulated.** It is AgentHire's simulation route |
| WebCrawler X's sub-hires (steps 4, 4b) and overspend attempts (step 5) | **Scripted, simulated behaviour.** The demo makes them, acting for agent 5 through its alias nodes. AgentHire's WebCrawler X never contacts Allowance. The incident and the dispute say so |
| AgentHire's reputation and stake numbers | **Simulated.** They are its DB mirror (`simulated: true` in its own answers) |
| The incident record | Allowance-side: a local JSON file (`.agenthire/allowance-demo-incidents.json` in the demo, emptied at the start of each run). Other processes and restarts read it back; AgentHire never stores it |
| The marketplace activity the shadow audit replays | **Simulated.** It comes from AgentHire's `sim_engine.py`, almost all of it the force-all demo cascade with no paying buyer. The report carries `simulated: true` and states its budget assumption |
| Operator World ID nullifiers | **Mock.** `MockPrincipalVerifier`, seeded by the deployer wallet. They show the binding, not a real proof of personhood, and can only group agents that share a wallet |
| The Luckin PM's return path and the ladder stop-out | **Synthetic.** The Tiger overlay on arena world #3 (`packages/lab/src/arena.ts`), not market data |
| Escrow | Not claimed |
| `AGENTHIRE_SETTLE=fuji` | **Not run here** (see below) |

## `AGENTHIRE_SETTLE=fuji`

`AGENTHIRE_SETTLE=fuji` makes `AgentHireSettlementService` send the same signed
permit as an `X-Payment` header on AgentHire's real payment route,
`GET /api/x402/demo-execute/:id?amountUSDC=`. AgentHire's facilitator then calls
`MockUSDC.transferWithAuthorization` on Fuji, which moves the permit's `value`
out of `permit.from`, the payer (`onchain.py:431-441`). Settling therefore needs
three things:

- on the AgentHire side, `FACILITATOR_PRIVATE_KEY`, with AVAX for gas;
- on the AgentHire side, a reachable Fuji RPC;
- on the payer side, a wallet that holds Mock USDC on Fuji. Set its key in
  `AGENTHIRE_PAYER_KEY` (environment only; it is never logged or written).

This sandbox has none of the three: the Fuji RPC is blocked, and there are no
keys. **As shipped, `AGENTHIRE_SETTLE=fuji npm run demo:agenthire` cannot settle:
without `AGENTHIRE_PAYER_KEY` its payer is an unfunded throwaway, so even a fully
keyed AgentHire would revert the transfer.** The path is unit-tested with a fake
fetch only and **has not been run against Fuji.** Against the keyless instance,
the real route answers `402 payment failed: facilitator not configured`. Because
the permit has already been handed over, settlement charges that payment as
UNCONFIRMED; the demo's "confirmed by AgentHire" check then fails, the run exits
1, and its outputs go to `*.failed.json`.

The on-chain form of the cap is `contracts/contracts/SpendCapHook.sol`. It is a
Uniswap v4-style hook whose view-style `beforeSwap` asks
`MandateRegistry.canSpend(...)` and reverts when the agent would exceed its
remaining, unrevoked, unexpired, merchant-scoped budget. It enforces the cap for
swaps only. An on-chain x402 settlement would need the same check in front of
`transferWithAuthorization`. That is not built.

## No escrow claims. An incident is not a slash.

- **Escrow.** AgentHire's live flows never call `EscrowPayment.depositFunds`, and
  completion and refunds only change its database (`app.py:2899-2915`). The
  permit's `to` is the EscrowPayment address because the challenge names it.
  Nothing here says funds are held in escrow, because they are not.
- **Incident, not slash.** An agent that keeps trying to spend past its mandate
  is stopped by the mandate every time. That is a record worth keeping, and
  other buyers should see it, but it is not misconduct that justifies burning
  stake. `/api/sim/slash-agent` slashes 25%, then 75%, then 100% of the
  remaining stake (`simulation.py:46`) and bans a non-flagship agent on the
  third incident, so Allowance never calls it. The incident lives in
  `IncidentLedger`, keyed by agent and operator, in a local JSON file that
  screening re-reads on every check. It is also sent to AgentHire's
  `/api/dispute/submit`, which without keys only prints it to its server log
  and answers `pending_review`: no `ModerationReport` row, no incident counter
  change. The demo checks that AgentHire's own incident count and stake did not
  move, allowing only for slashes its own simulator made during the window.

## Upstream fix for the fresh-clone boot bug

On a fresh clone, `app.py` runs `db.create_all()` (`app.py:4189-4193`) before
anything has imported `models`, so SQLAlchemy has no tables registered and the
database stays empty. Most `from models import …` lines in `app.py` are inside
functions. A one-line patch that could be sent upstream:

```diff
diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -4187,6 +4187,8 @@ def _sync_agents_from_db():
         })
 
 
+import models  # noqa: E402,F401  — register every table on db.metadata before create_all()
+
 with app.app_context():
     try:
         # 1. Baseline schema (idempotent)
```

Until then, `scripts/agenthire-up.sh` works around the bug without touching the
source: it runs `python -c 'import models, app'` against an absolute
`DATABASE_URL` before starting gunicorn.

## Running it

```bash
# Boot (pinned clone into .agenthire/src unless AGENTHIRE_SRC is set; venv in .agenthire/venv unless AGENTHIRE_VENV is set)
bash scripts/agenthire-up.sh                           # 127.0.0.1:5301

# The demo (about 30 s including a 20 s audit capture)
npm run demo:agenthire

# The shadow audit on its own, with options (--seconds, --save, --replay, --json, --organic-only)
npx tsx scripts/agenthire-audit.ts

# Offline tests (fake AgentHire + a recorded capture)
npm -w @allowance/adapters test

# Stop
bash scripts/agenthire-down.sh
```

For another port, pass `PORT=<port>` to both scripts and
`AGENTHIRE_URL=http://127.0.0.1:<port>` to the demo (or `--base` to the audit).

`agenthire-up.sh` starts the server under `env -i` and pins every outbound key
and URL variable to an empty string, so AgentHire runs keyless even if the
source has a `.env`. `API_KEY`, AgentHire's only inbound auth, is instead set to
a random per-boot value that is never printed or stored, so its `/admin/*`
mutation routes are closed; nothing in these demos calls them. `CORS_ORIGINS` is
pinned to the instance's own origin. It uses one gunicorn worker, because the
simulator lives in a single process. It then starts AgentHire's simulator, which
upstream only auto-starts under the Werkzeug reloader (`app.py:4229`).

### One run (2026-09-26, simulated marketplace)

From `AGENTHIRE_AUDIT_SECONDS=60 npm run demo:agenthire` against a freshly
seeded AgentHire (`AGENTHIRE_RESET=1`) on 127.0.0.1, mock mode, on the code
after loop 5 (loop 4 changed the Tiger overlay, which changed the PM's
simulated path). All 55 checks passed. These are the committed
`agenthire-snapshot.json` and `agenthire-receipts.json` (6 nodes, 29 events).

- The hire settled at WebCrawler X's quote of 0.033990 USDC (surge ×1.133),
  confirmed by AgentHire as `mock` (no unconfirmed receipts).
- The scripted ResearchBot Pro sub-hire settled at 0.003408 USDC.
- Two scripted DataSift hires were fired at once against room for one: one
  settled and one was blocked.
- Two scripted over-mandate attempts produced `ALW-INC-1`, and the second
  buyer, whose own ledger loaded it from disk, was refused at screening.
- The PM funded the next scrape (0.138747 USDC). The ladder cut the PM on day 52
  (drawdown 10.6%), restored it on day 63 (4.7%), cut it again on day 71
  (10.5%) and stopped it out on day 84 (21.2%). At the stop-out the data
  subtree still held 0.184996 USDC unspent, at least one hire at its quote at
  every level.
- `close()` freed 124,999.907502 USDC. The subtree kept the 0.092498 USDC it had
  spent, the data subtree's unspent budget went to 0, and the three quote-priced
  next hires were `REVOKED`.
- The shadow audit (60 s capture) replayed 51 sub-agent payments from 29
  primary jobs, 28 of them AgentHire's force-all demo cascade. 4 of 51 would
  have been blocked even under AgentHire's own displayed Hard Spend Cap
  (35.69 USDC); 15 of 51 under `primaryFundsSubs` (157.24 USDC). All 51
  (1163.92 USDC) were outside the buyer's authorization by definition
  (`strict`). CodeReview Pro's sub-agent fees were 5.78× its simulated revenue.

All of these numbers come from AgentHire's simulation, and they change from run
to run.

## Limits

- The nullifier comes from the World ID mock, seeded by the deployer wallet.
  CrawlTech runs only one agent in AgentHire's seeded roster, so step 7 shows
  the operator binding on QuantEdge Labs' two agents. The rule that an incident
  follows the operator to a differently named agent is unit-tested on Prism
  Labs (`agenthire.test.ts`), not shown live.
- The incident file is a single-writer local JSON file, not a database: two
  processes recording at the same instant can lose one write. It is never
  shared with AgentHire.
- AgentHire's challenge always sets `validBefore = now + 3600`. A mandate that
  expires in less than an hour therefore cannot pay AgentHire at all. That is
  the intended strict reading, and step 3b shows it.
- `/api/x402/pay` is limited to 30 requests per minute. Over the limit it
  answers with an HTML 429. The signed permit has been sent by then, so that
  payment is charged as UNCONFIRMED; keep payments below the limit.
- An UNCONFIRMED payment stays charged until someone reconciles it against
  AgentHire (its orders, or on Fuji `MockUSDC.authorizationState(from, nonce)`
  after `validBefore`). Nothing here reconciles automatically.
- AgentHire rounds sim event amounts to 4 decimals, so audit amounts are only
  accurate to about 50 micro-USDC per event.
