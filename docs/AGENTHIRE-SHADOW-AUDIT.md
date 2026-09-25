# AgentHire: local boot and shadow audit

AgentHire ([shalpate/agenthire](https://github.com/shalpate/agenthire), pinned at
`ab317f2b831a9a832898b88759b496c28a435ed4`) is a Flask agent marketplace. Its agents hire
other agents (A2A), and those sub-agent fees are neither debited from nor capped by the
primary job: AgentHire books them on top of the primary's price, as paid from the primary
agent's wallet. The shadow audit replays AgentHire's own A2A hires through Allowance's `pay()`
and counts how many a mandate would have blocked. Every number it prints comes from
AgentHire's **simulated** marketplace (`sim_engine.py`). Nothing is settled and no funds move.

## Boot an unmodified AgentHire

```bash
npm run agenthire:up            # = bash scripts/agenthire-up.sh -> http://127.0.0.1:5301
PORT=5201 npm run agenthire:up  # any port; one instance per port
npm run agenthire:down          # PORT=... for other ports
```

5301 is also the default of the demo and of the audit CLI.

- **Source.** Uses `$AGENTHIRE_SRC` if set; otherwise it shallow-fetches the pinned commit into
  `.agenthire/src` and checks the hash. The script never writes into the source tree
  (`PYTHONDONTWRITEBYTECODE=1`, absolute DB path).
- **Venv.** Uses `$AGENTHIRE_VENV` if set; otherwise it creates `.agenthire/venv` from
  `requirements.txt` once.
- **Keyless.** The server starts under `env -i`. Every outbound key or URL variable
  (`FACILITATOR_*`, `GATEKEEPER_*`, `PRIVATE_KEY`, `LLM_*`) is pinned to `""`, so a stray `.env`
  in the source cannot re-inject one (`app.py` loads `.env` with `setdefault`). With no keys
  there are no chain writes and no LLM calls, and x402 answers in mock mode.
- **Admin routes closed.** `API_KEY` is AgentHire's only inbound auth: when it is empty, every
  `/admin/*` mutation route (payout release-all, moderation suspend, verification approve)
  is open (`auth.py:38-41`). The script sets it to a random per-boot value that is never printed
  or stored; nothing here calls those routes.
- **CORS.** `CORS_ORIGINS` is pinned to the instance's own origin (AgentHire's default is `*`),
  so pages from other origins open in a local browser cannot make JSON requests to `/api/*`.
  Simple requests (form or text/plain bodies) still reach it; routes that need a JSON body
  reject them, routes that need none (e.g. `/api/sim/start`) act on them.
- **Fresh-clone bug.** `app.py` calls `db.create_all()` before it imports the models, so a
  fresh database gets no tables. The script bootstraps with `python -c 'import models, app'`
  against `sqlite:///<abs>/.agenthire/agenthire-$PORT.db`. Set `AGENTHIRE_RESET=1` to start
  from a fresh seed.
- **Serving.** Gunicorn runs with **one** worker, because the simulation engine lives in a
  single process. It binds to **127.0.0.1 only**, because AgentHire's money routes are
  unauthenticated; that keeps other machines out, not local browser pages (see CORS). After
  boot the script waits for `/api/health`, asserts `GET /api/agents` `total >= 100` (116 are
  seeded), then starts the sim. Upstream only auto-starts the sim under the Werkzeug reloader.
  Set `AGENTHIRE_SIM=off` to skip this step.

## Shadow audit

```bash
npm run audit:agenthire                                          # poll 60s on 127.0.0.1:5301, print the headline
npm run audit:agenthire -- --base http://127.0.0.1:5201          # another instance
npx tsx scripts/agenthire-audit.ts --save capture.json           # also keep the raw capture
npx tsx scripts/agenthire-audit.ts --replay capture.json         # offline re-run
npx tsx scripts/agenthire-audit.ts --organic-only                # drop the demo-cascade jobs
```

The script polls `GET /api/sim/events` and speeds up the sim through AgentHire's own
`POST /api/sim/speed` (0.1 s ticks), restoring the original speed afterwards. It then fetches
`/api/pricing/quote/:id` for each hiring agent and `/api/sim/a2a-candidates`, and runs the pure
module `packages/adapters/src/agenthire-audit.ts`.

**Linking.** AgentHire logs a primary's `settle` and then one `a2a_hire` (plus its mirror
`a2a_settle`) per sub-agent it triggers. Each hire belongs to the latest `settle` of its
`meta.primaryId`. The audit leaves two kinds of hire out of the count and reports each
separately:

- Direct hires (`POST /api/sim/trigger-direct`, `meta.direct`). Their "price" is the hire
  itself, so there is no buyer-priced job to check them against.
- Hires whose primary `settle` fell outside the capture window.

**What the primary jobs are.** Almost all of them come from AgentHire's periodic demo cascade
(`_fire_demo_a2a_flow`, every 20 ticks, `force_all=True`, `sim_engine.py:207-208` and `:371`):
every sub-agent trigger fires (the 55% gate at `:800` is skipped), the buyer is a synthetic
`demo-buyer-<tick>` hash (`:421`), and the primary's "settle" is only a log line priced at
tokens × `min_price` (`:425-431`), with no settle transaction. Nobody paid it. The report counts
these (`demoPrimaries`), prints the count in the headline, and `--organic-only` drops them.

**Shadow tree, one per primary job.** The tree has a buyer root, a `main` leaf for the primary,
and one **alias node per (hirer, sub-agent) edge**, named `a<sub>-via-a<hirer>`. AgentHire's
hiring graph has a cycle (1 hires 7, and 7 hires 1) and a shared child (6 is hired by both 3
and 4). A shared node would merge two parents' budgets, so every edge gets its own alias. Each
sub-agent payment then goes through `pay()`, using `MockIdentityGate`, a screening port and a
recording settlement. Merchants are named `agenthire:<id>`, exactly as the AgentHire adapters
name them, so `AgentHireScreeningService` (reputation plus operator incidents) can be passed
as `screening` instead of the default `MockScreeningService`; a payment it blocks counts as
blocked. Budgets are sized first-come with nothing held back: a payment is blocked only when it
exceeds everything left under the buyer's cap.

**Budget assumption.** The output always prints the assumption next to the numbers:

| scenario | buyer cap | what the number is |
|---|---|---|
| `hardSpendCap` (**headline**) | 1.25 × upper estimate | The checkout's displayed "Hard Spend Cap": `(tokens × quote.maxPrice + Σ sub est_cost_high) × 1.25`, badged "Enforced", but the sim never checks sub-agent fees against it. The primary is paid its price first. **Decided by the replay**: some sub-agent payments fit, some do not. |
| `primaryFundsSubs` | the primary's price | Sub-agents are paid out of the price first and the primary keeps the rest. This takes AgentHire's own description ("eats sub-agent fees out of its own settle") at its word. Also decided by the replay. |
| `strict` | the primary's price | The primary is paid its full price first, so nothing is left: **every** sub-agent fee is outside what the buyer authorized, **by definition**. This is reported as a total ("M payments, X USDC outside the buyer's authorization"), not as a replay finding. |

The headline reads: "K of M sub-agent payments would have been blocked even under AgentHire's
own displayed Hard Spend Cap (X of Y USDC unbudgeted). All M (Y USDC) were outside what the
buyer authorized for the primary job, by definition … priced at P USDC for N simulated primary
jobs (D of them AgentHire's force-all demo cascade with no paying buyer)".

**Earlier captures (2026-09-25).** Unmodified AgentHire on 127.0.0.1:5201, three separate 60 s
captures, reported by an earlier version of the script whose headline was the `strict` count.
The counts are the same replay; the columns are relabelled. All data is simulated.

| capture | primary jobs with hires | `hardSpendCap` (replay) | `primaryFundsSubs` (replay) | outside the buyer's authorization (`strict`, by definition) | sub-agent fees / primary price |
|---|---|---|---|---|---|
| 1 | 68 | 11 of 114 blocked (247.83 USDC) | 47 of 114 (698.55 USDC) | all 114 (2824.55 USDC) | 0.62x overall; CodeReview Pro 4.89x |
| 2 | 57 | 12 of 93 blocked (235.37 USDC) | 41 of 93 (668.58 USDC) | all 93 (1905.93 USDC) | 0.58x overall; CodeReview Pro 6.06x |
| 3 | 31 | 6 of 51 blocked (93.90 USDC) | 19 of 51 (310.62 USDC) | all 51 (1647.92 USDC) | 0.56x overall; CodeReview Pro 6.06x |
| 4 (merge check: `npm run demo:agenthire`, 20 s at 0.1 s ticks, current headline) | 8 | 5 of 15 blocked (72.46 USDC) | 11 of 15 (113.70 USDC) | all 15 (233.53 USDC) | CodeReview Pro 6.23x |

Most of these jobs, for example 52 of the 57 in capture 2, come from AgentHire's demo cascade;
the remainder come from matched buyer bids (also simulated). The `hardSpendCap` count depends on
surge: right after a fresh seed, with quiet prices, it can be 0. AgentHire rounds `amountUSDC`
to 4 decimals. The quotes are read at audit time. The tests pin a trimmed recording at
`packages/adapters/src/fixtures/agenthire-sim-capture.json` (headline: 3 of 21 under
`hardSpendCap`; all 21 outside the buyer's authorization under `strict`).
