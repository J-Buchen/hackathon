# Allowance

> **Give your AI agents an allowance, not your wallet.**
> An attenuating-delegation protocol for autonomous AI-agent payments.

Allowance lets a human fund a **root agent** with a capped budget, and lets that
agent safely hand slices of that budget down to the sub-agents it spawns. Every
hop can only **narrow** what it received — never broaden it — and every payment
is identity-gated, compliance-screened, settled in any token, and fully audited.

---

## The ELI5 story (allowance & the piggybank)

You give your kid a **$20 allowance**. She can spend it, but she can't reach
into your bank account. If she asks her little brother to buy comics, she hands
him **$5 of her $20** — he can't spend $6, he can't buy fireworks if she said
"comics only," and the moment she takes the $5 back, he's broke.

That's Allowance. The parent is you (the human). The kid is your **root agent**.
The little brother is a **sub-agent**. Each pocket of money is a **mandate**:
a budget, an allowlist of who you can pay and why, and an expiry date. Money
only ever flows *down and narrower*. Pull an allowance and everything below it
stops instantly.

---

## The unsolved niche

Autonomous agents now spawn **sub-agents that spend money**. An orchestrator
hires a researcher, the researcher hires a scraper, the scraper pays an API.
Today the only options are terrible:

- **Give every agent your key/wallet** → one compromised or hallucinating agent
  drains everything.
- **Approve every payment by hand** → defeats the point of autonomy.

Nobody has a clean primitive for **authority that attenuates down a chain**:
each hop narrows its parent's remaining budget/scope, is revocable, and is
auditable end-to-end. **Allowance is that primitive.**

### The wow: ENSv2's name hierarchy *is* the delegation tree

A name like `scraper.researcher.alice.eth` already encodes who-is-boss-of-whom
(**left-most label is the node itself**). ENSv2 makes each name its own
sub-registry with per-record resolver permissions — so we store each agent's
**mandate** (budget/scope/expiry) as resolver records on its name. The naming
tree and the authority tree are the **same tree**. Attenuation just means: a
child's budget is always a slice of its parent's *remaining* budget.

---

## Quickstart

```bash
npm install          # root install (installs all workspaces once)
npm run demo         # runs the full storyline offline, writes the snapshot
npm run dev:web      # opens the dashboard that renders the snapshot
```

- `npm run demo` executes the eight-step storyline below **entirely on
  deterministic mocks** (no network, no credentials) and writes
  `apps/web/public/demo-snapshot.json`.
- `npm run dev:web` serves the React dashboard that visualizes the spend tree
  and the event ledger from that snapshot.
- `npm run typecheck` runs `tsc -b` across every package.
- `npm test` runs the core domain unit tests.

---

## Architecture (at a glance)

```
                         ┌─────────────────────────────┐
   human principal  ───► │  World IDKit (PrincipalVerifier) │  verify to fund
   (alice)               └──────────────┬──────────────┘
                                        │ fundRoot(100 USDC)
                                        ▼
   ENSv2 name hierarchy  =  DELEGATION TREE (packages/core · tree.ts)
   ┌──────────────────────────────────────────────────────────────┐
   │  alice.eth                     budget 100 · avail 65          │
   │   └─ researcher.alice.eth      budget 30  · avail 12  (REVOKED)│
   │        └─ scraper.researcher.alice.eth   budget 10            │
   │   └─ ghost.alice.eth           identity: expired              │
   └──────────────────────────────────────────────────────────────┘
        each edge = delegate(): child mandate ⊆ parent remaining (ATTENUATION)

   pay(node, merchant, amount, purpose)   [packages/core · payment.ts]
        │
        ├─(1) identity  ── IdentityGate      ─► World ID for Agents   (DENIED_IDENTITY)
        ├─(2) mandate   ── tree checks       ─► revoked/expired/cap   (BLOCKED_MANDATE / REVOKED)
        ├─(3) screening ── ScreeningService  ─► Intercepta live check (BLOCKED_SCREENING)
        └─(4) settle    ── SettlementService ─► 1inch Aqua swap       (SETTLED)
                                        │
                                        ▼
        contracts/  ── Uniswap v4 hook / settlement guard enforces the cap on-chain
                                        │
                                        ▼
   snapshot JSON  ──►  apps/web (React dashboard)  +  Curvegrid MultiBaas dashboard
```

**Data flow:** agent action → `@allowance/core` (attenuation + payment pipeline)
→ `@allowance/adapters` (sponsor ports, mock or real) → snapshot JSON →
`apps/web` dashboard. On-chain enforcement lives in `contracts/`.

---

## Sponsor prize → feature map

Each track is **real, not cosmetic** — it satisfies a load-bearing part of the
protocol. Full submission checklist in [`docs/SPONSORS.md`](docs/SPONSORS.md).

| Prize (amount) | What satisfies it | Where |
| --- | --- | --- |
| **ENS** ($6k) | Subname hierarchy **is** the delegation/authority tree; mandates stored as resolver records | `packages/core/src/tree.ts` (name helpers, `DelegationTree`) |
| **World ID for Agents** ($5k) | `IdentityGate` port — every `pay()` verifies the node + ancestors first; supports denied/expired path | `packages/core/src/payment.ts`, `packages/adapters` (`MockIdentityGate`, `WorldAgentIdentityGate`) |
| **World IDKit** ($5k) | `PrincipalVerifier` port — human verifies to fund the root; success **and** failure path | `packages/adapters` (`MockPrincipalVerifier`, `WorldIDKitVerifier`), `services/orchestrator/src/demo.ts` |
| **Intercepta** ($2k) | `ScreeningService` port — live screen runs **before** settlement; approved **and** blocked | `packages/adapters` (`MockScreeningService`, `InterceptaScreeningService`) |
| **1inch Aqua** ($5k) | `SettlementService` port — swap payer token → merchant token via Aqua/SwapVM | `packages/adapters` (`MockSettlementService`, `AquaSettlementService`) |
| **Uniswap** ($6k) | v4 hook / settlement guard enforcing the attenuated cap on-chain; ships `docs/FEEDBACK.md` | `contracts/`, [`docs/FEEDBACK.md`](docs/FEEDBACK.md) |
| **Curvegrid** ($1k×3) | AI agent reads chain state + MultiBaas-style dashboard of the spend tree | `apps/web` (spend-tree view), reads snapshot/chain |
| **Sui** ($5k, stretch) | Programmable escrow/settlement rail (non-EVM) | optional |

---

## Demo storyline

`npm run demo` runs these eight steps, then writes the snapshot the dashboard
renders. (Budgets in USDC, 6 decimals.)

| # | Action | Result |
| --- | --- | --- |
| a | Human **alice** verifies via IDKit; funds root **alice.eth** with **100 USDC** (merchants = any). | `FUND` / `OK` |
| b | `alice.eth` delegates **30 USDC** → `researcher.alice.eth` (merchants `{arxiv, openai, sanctioned-vendor}`). | `DELEGATE` / `OK` |
| c | `researcher` delegates **10 USDC** → `scraper.researcher.alice.eth` (merchants `{arxiv}`). | `DELEGATE` / `OK` |
| d | `scraper` tries to pay **15 USDC** (arxiv) — exceeds its 10 available. | `PAYMENT` / `BLOCKED_MANDATE` |
| e | `researcher` pays **5 USDC** to `sanctioned-vendor` — **Intercepta blocks**. | `PAYMENT` / `BLOCKED_SCREENING` |
| f | `researcher` pays **8 USDC** to `openai` (USDC → merchant token via **Aqua**). | `PAYMENT` / `SETTLED` (`swapped:true`) |
| g | `ghost.alice.eth` (identity **expired**) tries to pay. | `PAYMENT` / `DENIED_IDENTITY` |
| h | `alice` **revokes** `researcher.alice.eth`; `scraper` then pays. | `REVOKE` / `REVOKED`, then `PAYMENT` / `REVOKED` |

**Verify the math:** post-run, `alice.eth` available = **65 USDC** (100 − 30 − 5),
`researcher.alice.eth` available = **12 USDC** (30 − 10 reserved − 8 spent),
**10 events** total. Steps d/e/g/h are the required **failure/blocked** demos.

---

## Repo layout

```
packages/core         @allowance/core         pure domain: types, attenuation, tree, payment engine (zero runtime deps)
packages/adapters     @allowance/adapters     sponsor ports: deterministic mock + real-integration stub
services/orchestrator @allowance/orchestrator x402 flow + demo runner (writes the snapshot)
apps/web              allowance-web           Vite + React dashboard of the spend tree + event ledger
contracts             solidity (Hardhat)      Uniswap v4 hook / settlement guard enforcing the cap on-chain
docs/                 ARCHITECTURE.md · SPONSORS.md · FEEDBACK.md
DESIGN.md             authoritative spec — locked types, signatures, and the storyline
```

## Docs

- [`DESIGN.md`](DESIGN.md) — the authoritative, locked spec.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — domain model, attenuation rule, payment pipeline, data flow, on-chain vs off-chain split.
- [`docs/SPONSORS.md`](docs/SPONSORS.md) — per-track submission checklist with the required failure-path demos flagged.
- [`docs/FEEDBACK.md`](docs/FEEDBACK.md) — the Uniswap-required developer feedback.
