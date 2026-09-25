# Allowance — Sponsor Submission Checklist

A per-track checklist for judging. For **each** sponsor: the prize + amount, the
qualification requirements, the exact file(s)/feature that satisfy them, and the
**demo moment** that proves it.

> **Verify against the live prize page before submitting.** Requirements below
> are reproduced from each sponsor's public prize/product pages as understood at
> build time (ETHGlobal / ETHOnline-era tracks). Prize pages change — re-read
> them the morning of submission and reconcile any deltas. Where a requirement is
> our best reconstruction rather than a verbatim quote, it is marked *(confirm)*.

> **Three tracks REQUIRE a visible FAILURE / BLOCKED path**, not just a happy
> path: **World IDKit**, **World ID for Agents**, and **Intercepta**. These are
> flagged with ⚠️ below and are baked into the demo storyline (steps d/e/g/h).

---

## 1. ENS — $6,000  ·  *CENTRAL, not cosmetic*

**Requirement (confirm):** Build something that uses ENS in a meaningful,
load-bearing way — not a vanity name lookup. Strong submissions use ENSv2
concepts: hierarchical subnames, per-name sub-registries, resolver records, and
the hierarchy itself as application structure.

**How we qualify:** The ENSv2 name hierarchy **is** our delegation/authority
tree. Names like `scraper.researcher.alice.eth` encode who-is-boss-of-whom
(left-most label = the node), subname minting **is** the delegation act, and each
agent's **mandate** (budget, allowlists, expiry, revocation) is stored as
**resolver records** on its name. Remove ENS and the whole authority model
collapses — that is what makes it central.

**Files / features:**
- `packages/core/src/tree.ts` — name grammar (`labels`, `leftLabel`,
  `parentNameOf`, `childName`) and `DelegationTree` (fund/delegate/revoke).
- `docs/ARCHITECTURE.md` §2 — the hierarchy-as-delegation-tree insight.

**Demo moment:** Steps a–c build `alice.eth → researcher.alice.eth →
scraper.researcher.alice.eth`; the dashboard renders the ENS-named spend tree.
The revoke in step h cascades down the name subtree.

**Checklist:**
- [ ] Hierarchy is load-bearing (delegation = subname structure), not a lookup.
- [ ] Mandates framed as resolver records; note the ENSv2 permissioned-resolver mapping.
- [ ] Real-integration stub references ENS resolver read/write. (see credentials)

---

## 2. World ID for Agents (AgentKit) — $5,000  ·  ⚠️ FAILURE PATH REQUIRED

**Requirement (confirm):** Use World ID / AgentKit so that an **agent proves a
verified human is behind it** before it acts. Demonstrate the verification
gating real behavior — including what happens when verification is **absent or
expired**.

**How we qualify:** The `IdentityGate` port is stage 1 of **every** payment.
`pay()` checks the acting node **and every ancestor** is `verified`; an
`expired` or `none` status anywhere in the chain returns `DENIED_IDENTITY`
before any money moves.

**Files / features:**
- `packages/core/src/payment.ts` — `IdentityGate` port; identity is stage 1.
- `packages/adapters` — `MockIdentityGate` (offline) + `WorldAgentIdentityGate`
  (real stub, `TODO(cred)`).

**Demo moment (⚠️ includes the failure path):**
- Steps a–f: verified agents transact normally.
- **Step g:** `ghost.alice.eth` has `identityStatus: "expired"` → `PAYMENT` /
  **`DENIED_IDENTITY`**. This is the required denied/expired demonstration.

**Checklist:**
- [ ] Identity gates real behavior (runs before spend), not decorative.
- [ ] ⚠️ Denied/expired path shown live (step g).
- [ ] Real stub points at AgentKit / ToolRouter + API key flow.

---

## 3. World IDKit — $5,000  ·  ⚠️ FAILURE PATH REQUIRED

**Requirement (confirm):** Integrate the IDKit widget/SDK so a **human verifies
proof-of-human** to authorize an action. Show a successful verification **and**
handle a failed/invalid proof.

**How we qualify:** The `PrincipalVerifier` port gates **funding the root**. The
human `alice` must pass IDKit verification before `fundRoot` grants the root
budget. A failing proof refuses funding.

**Files / features:**
- `packages/core/src/payment.ts` — `PrincipalVerifier` port + `PrincipalProof`.
- `packages/adapters` — `MockPrincipalVerifier` (`verified:false` when
  `proof.signal === "fail"` / `proof.action === "fail"`) + `WorldIDKitVerifier`
  (real stub, `TODO(cred)`).
- `services/orchestrator/src/demo.ts` — success funds the root; a separate
  failing proof logs that funding was **refused** (does not call `fundRoot`).

**Demo moment (⚠️ includes the failure path):**
- **Success:** step a — alice verifies, root funded 100 USDC, principal
  `verified:true`.
- **⚠️ Failure:** orchestrator calls the verifier with a failing proof → funding
  refused, `fundRoot` never runs.

**Checklist:**
- [ ] Human verification gates root funding (success path — step a).
- [ ] ⚠️ Failed/invalid proof path shown (funding refused).
- [ ] Real stub references the IDKit `app_id`/`action` + cloud/on-chain verify.

---

## 4. Intercepta — $2,000  ·  ⚠️ BLOCKED PATH REQUIRED

**Requirement (confirm):** Use Intercepta's real-time screening / compliance
engine to run a **risk/compliance check on a transaction before it is
confirmed**. Demonstrate both an **approved** and a **blocked** transaction.

**How we qualify:** The `ScreeningService` port is stage 3 of the payment
pipeline — a **live screen on `(merchant, amount, purpose)` before settlement is
signed.** A flagged merchant returns `BLOCKED_SCREENING` and no funds move.

**Files / features:**
- `packages/core/src/payment.ts` — `ScreeningService` port; screening runs
  **before** settlement and **after** the mandate check (ordering matters, see
  ARCHITECTURE §5).
- `packages/adapters` — `MockScreeningService` (denylist incl.
  `sanctioned-vendor` / `sanctioned*` prefix; returns a `reference` on both
  paths) + `InterceptaScreeningService` (real stub, `TODO(cred)`).

**Demo moment (⚠️ includes the blocked path):**
- **Approved:** step f — `researcher` pays `openai`, screening approves →
  `SETTLED`.
- **⚠️ Blocked:** step e — `researcher` pays `sanctioned-vendor` → `PAYMENT` /
  **`BLOCKED_SCREENING`**. `sanctioned-vendor` is deliberately in researcher's
  *mandate allowlist* so the payment passes policy and reaches live screening —
  proving screening catches what policy alone cannot.

**Checklist:**
- [ ] Screening runs pre-settlement (point-of-decision), not after.
- [ ] ⚠️ Approved AND blocked both shown (steps f and e).
- [ ] Real stub references Intercepta compliance/screening API + risk response.

---

## 5. 1inch Aqua — $5,000

**Requirement (confirm):** Build a custom Aqua app using **SwapVM**; projects
that meaningfully use SwapVM (custom instructions/opcodes) score higher.
Cross-token settlement / pay-in-any-token is a strong fit.

**How we qualify:** The `SettlementService` port does **pay-in-any-token**
settlement: when `payerToken !== merchantToken`, it swaps payer token → merchant
token via Aqua/SwapVM, then moves funds. Returns `swapped`, `fromToken`,
`toToken`, `amountIn`, `amountOut`, and a `reference`.

**Files / features:**
- `packages/core/src/payment.ts` — `SettlementService` port + `SettlementRequest`
  / `SettlementResult`.
- `packages/adapters` — `MockSettlementService` (1:1 mock rate, `swapped =
  payerToken !== merchantToken`) + `AquaSettlementService` (real stub,
  `TODO(cred)`).
- `contracts/` — settlement contracts intended for Aqua/SwapVM integration.

**Demo moment:** Step f — `researcher` pays `openai` with payer USDC → merchant
token, `swapped:true`. Dashboard shows the swap on the settled payment.

**Checklist:**
- [ ] Cross-token swap path exercised (step f, `swapped:true`).
- [ ] Aqua/SwapVM contracts present; document custom SwapVM instructions if added.
- [ ] **Keep git history clean and incremental** — Aqua judging values commit
      history showing the contract work. Commit contracts progressively.
- [ ] Real stub references Aqua app deploy + SwapVM opcode config.

---

## 6. Uniswap — $6,000  ·  requires `docs/FEEDBACK.md` + feedback form

**Requirement (confirm):** Build on Uniswap v4 — a **hook** or contract that
does something real with the protocol. Uniswap requires teams to submit
**developer feedback**: ship a `FEEDBACK.md` in the repo **and** complete the
Uniswap feedback form linked on the prize page.

**How we qualify:** `contracts/` holds a **Uniswap v4 hook / settlement guard**
that enforces the attenuated spend cap **on-chain** — the last line guaranteeing
a settlement can never exceed the node's authorized cap even if off-chain logic
is bypassed. This is the on-chain half of the on-chain/off-chain split
(ARCHITECTURE §8).

**Files / features:**
- `contracts/` — v4 hook / settlement guard enforcing the cap.
- `docs/FEEDBACK.md` — honest developer feedback on the Uniswap stack (**this is
  a hard requirement — do not skip it**).

**Demo moment:** Steps d and h show attenuation caps enforced (over-budget and
post-revoke payments blocked); the hook is the on-chain analogue of those
checks. Show the hook rejecting an over-cap swap in a contract test.

**Checklist:**
- [ ] v4 hook/guard enforces the attenuated cap on-chain (feedback-worthy usage).
- [ ] `docs/FEEDBACK.md` present and genuinely filled in.
- [ ] **Uniswap feedback FORM submitted** (link on the prize page) — required.
- [ ] Real stub / deploy notes reference PoolManager + hook permissions.

---

## 7. Curvegrid (MultiBaas) — $1,000 × 3

**Requirement (confirm):** Use Curvegrid's **MultiBaas** platform — e.g. an AI
agent that reads on-chain state via MultiBaas and/or a dashboard built on it.
Three prizes of $1,000 (best uses).

**How we qualify:** An **AI agent reads chain state** (the settlement contracts /
snapshot) and a **MultiBaas-style dashboard visualizes the spend tree** — budgets,
reserved, available, and spend per node across the delegation hierarchy.

**Files / features:**
- `apps/web` — spend-tree visualization + event ledger (reads the snapshot; the
  MultiBaas-style dashboard view of the same data).
- Curvegrid agent that reads chain/snapshot state and narrates the spend tree.

**Demo moment:** After `npm run demo`, the dashboard shows the full tree with
per-node budgets and the 10-event ledger; the agent summarizes spend and flags
the revoked subtree.

**Checklist:**
- [ ] MultiBaas used to read contract/chain state (not just a static UI).
- [ ] Dashboard visualizes the spend tree from real state.
- [ ] Real stub references a MultiBaas deployment + API key.

---

## 8. Sui — $5,000  ·  *OPTIONAL / STRETCH (non-EVM)*

**Requirement (confirm):** Build on Sui using Move — e.g. programmable
escrow/settlement objects. Non-EVM; **optional** for us.

**How we qualify (stretch):** A Move-based programmable **escrow/settlement
rail** mirroring the attenuated-cap enforcement — an alternative settlement
backend behind the same `SettlementService` port.

**Files / features:** optional Sui/Move package + a `SuiSettlementService` stub.

**Demo moment (if built):** settle a payment through the Sui escrow object.

**Checklist:**
- [ ] *(optional)* Move escrow/settlement object deployed.
- [ ] *(optional)* Wired behind `SettlementService`.

---

## Submission summary

| Track | Amount | Failure path req? | Primary artifact |
| --- | --- | --- | --- |
| ENS | $6,000 | — | `packages/core/src/tree.ts` (central) |
| World ID for Agents | $5,000 | ⚠️ yes (step g) | `IdentityGate` + adapters |
| World IDKit | $5,000 | ⚠️ yes (funding refused) | `PrincipalVerifier` + orchestrator |
| Intercepta | $2,000 | ⚠️ yes (step e) | `ScreeningService` + adapters |
| 1inch Aqua | $5,000 | — | `SettlementService` + `contracts/` |
| Uniswap | $6,000 | — | `contracts/` + `docs/FEEDBACK.md` + FORM |
| Curvegrid | $1,000×3 | — | `apps/web` + MultiBaas agent |
| Sui | $5,000 | — (optional) | Move escrow (stretch) |

**Do-not-forget list:** ⚠️ three failure-path demos (IDKit, World ID for Agents,
Intercepta); ENS must read as central; Uniswap needs both `FEEDBACK.md` **and**
the feedback form; 1inch Aqua wants clean incremental git history on the
contracts; Sui is optional non-EVM.

---

## Credentials & real integrations (`TODO(cred)` register)

The demo runs **fully offline on deterministic mocks** — no credentials needed
for `npm run demo` or `npm run dev:web`. Each real-integration stub in
`packages/adapters` throws a clear "not configured" error until wired. This is
the list of what to provision **before the venue** to light up the real paths.
Every item corresponds to a `TODO(cred)` in the codebase.

| Sponsor | Stub to wire | Credential / config needed | Notes |
| --- | --- | --- | --- |
| **ENS** | ENS resolver read/write in `tree.ts` real path | RPC endpoint (mainnet/testnet), ENSv2 registry + resolver addresses, a name owner key to mint subnames & write records | Mandates → resolver records; subname mint = delegate |
| **World ID for Agents** | `WorldAgentIdentityGate` | AgentKit / ToolRouter API key per agent, World ID app config | Agent proves a verified human backs it before acting |
| **World IDKit** | `WorldIDKitVerifier` | IDKit `app_id` + `action`, cloud or on-chain verifier endpoint | Human verifies to fund the root; needs the fail path too |
| **Intercepta** | `InterceptaScreeningService` | Intercepta API key / compliance-engine endpoint | Live pre-settlement screening on (merchant, amount, purpose) |
| **1inch Aqua** | `AquaSettlementService` | 1inch API key, deployed Aqua app address, SwapVM instruction/opcode config, RPC | Cross-token settlement; commit contract work incrementally |
| **Uniswap** | `contracts/` hook deploy | RPC + deployer key, PoolManager address, CREATE2 salt for hook-permission address mining | Also: submit the feedback FORM |
| **Curvegrid** | MultiBaas agent/dashboard | MultiBaas deployment URL + API key, deployed contract linked in MultiBaas | Agent reads chain state via MultiBaas |
| **Sui** (stretch) | `SuiSettlementService` | Sui RPC + key, published Move package id | Optional non-EVM rail |

**Sequence for the team:** (1) provision RPC + keys per chain; (2) deploy
`contracts/` and record addresses; (3) fill each stub's `TODO(cred)` with the
values above; (4) flip the orchestrator/adapters from `createMockAdapters()` to
the real bundle for whichever tracks are being demoed live; (5) keep the mock
path as the offline fallback for the pitch.
