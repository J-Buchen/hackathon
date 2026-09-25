# Allowance — Architecture

This document explains *how* Allowance works. [`DESIGN.md`](../DESIGN.md) at the
repo root is the **authoritative, locked spec** (exact type names and function
signatures); this document is the narrative companion — the mental model, the
rules, and the data flow. Where the two ever disagree, `DESIGN.md` wins.

---

## 1. The core idea

Autonomous agents spawn sub-agents that spend money. Allowance gives them a
single primitive: **authority that attenuates down a chain.** Every hop can only
*narrow* the budget and scope it received from its parent, is revocable at any
time, and produces an auditable event trail.

The key insight is that we do not need to invent a new tree to hold that
authority — **ENSv2's hierarchical name registry already is one.**

---

## 2. The ENSv2-hierarchy-as-delegation-tree insight

In ENSv2, a full name like `scraper.researcher.alice.eth` is a *chain of
entries* across registries linked by sub-registry pointers, and each name owner
can run its own sub-registry with per-record resolver permissions. That is
exactly a hierarchical delegation model, DNS-style: authority passes down label
by label.

Allowance maps that 1:1:

- **A name = an agent node.** The **left-most label is the node itself**;
  everything to its right is its ancestry. `scraper.researcher.alice.eth` is the
  scraper agent, whose parent is `researcher.alice.eth`, whose parent is
  `alice.eth` (the root agent), owned by the human principal `alice`.
- **Owning a name = being the boss.** `researcher.alice.eth` mints
  `scraper.researcher.alice.eth` as a subname — that *is* the delegation act.
- **The mandate = resolver records.** Each name stores its budget, allowlists,
  expiry, and revocation flag as resolver records on that name. Reading an
  agent's authority is a resolver read; changing it is a permissioned record
  write.

So the naming tree, the ownership tree, and the authority tree are **one tree**.
This is why the ENS track is *central, not cosmetic*: remove ENS and you have to
reinvent the hierarchy, the ownership semantics, and the record store it depends
on. `packages/core/src/tree.ts` implements this tree in memory against the exact
same name grammar (`labels`, `leftLabel`, `parentNameOf`, `childName`).

---

## 3. Domain model

All amounts are **integers in the token's smallest unit** (USDC → 6 decimals),
held as `bigint` in memory and serialized as decimal **strings** of the
smallest-unit integer in JSON (100 USDC → `"100000000"`). Human ↔ smallest-unit
conversion is `parseAmount` / `formatAmount` in `@allowance/core`.

- **Principal** — the human root, verified via World IDKit. Grants the root
  budget. `{ name, verified }`.
- **AgentNode** — `{ name, parent, identityStatus, mandate }` where
  `identityStatus ∈ "verified" | "expired" | "none"`.
- **Mandate** — `{ budget, spentDirect, allowedMerchants?, allowedPurposes?,
  expiry, revoked }`. An **absent** allowlist (`undefined`, serialized as
  `null`) means **any**.

### Derived quantities

```
reserved(node)  = Σ over children of  child.mandate.budget
available(node) = node.mandate.budget − node.mandate.spentDirect − reserved(node)
```

`available` is the amount a node can still either spend directly or delegate.
`reserved` is budget already promised to children (whether spent yet or not) —
this is what makes the attenuation guarantee hold even before children spend.

---

## 4. The attenuation rule

Delegating from parent **P** to child **C** with proposed mandate **M** is valid
**iff all** of these hold — otherwise it is rejected with a typed reason
(`AttenuationRejectionReason`) and `delegate()` records
`DELEGATE / ATTENUATION_REJECTED` then throws `AttenuationError`:

1. `M.budget ≤ available(P)` — can't promise more than the parent still has.
   (`BUDGET_EXCEEDS_AVAILABLE`; a negative budget → `NEGATIVE_BUDGET`.)
2. `P.allowedMerchants === undefined` **or** `M.allowedMerchants ⊆
   P.allowedMerchants` — can't add merchants the parent couldn't use.
   (`MERCHANTS_NOT_SUBSET`.)
3. `P.allowedPurposes === undefined` **or** `M.allowedPurposes ⊆
   P.allowedPurposes`. (`PURPOSES_NOT_SUBSET`.)
4. `M.expiry ≤ P.mandate.expiry` — can't outlive the parent.
   (`EXPIRY_EXCEEDS_PARENT`.)
5. Guard: `P` is not revoked. (`PARENT_REVOKED`.)

**A child may only narrow.** Note the important corollary in rule 2/3: a
*restricted* parent (one with a defined allowlist) forces its child to declare a
defined allowlist too. A child that left its allowlist `undefined` (= "any")
would *broaden* authority, so it is rejected. `isAllowlistSubset` and
`checkAttenuation` in `attenuation.ts` implement this.

---

## 5. The payment pipeline

`pay(tree, req, adapters, opts)` runs four stages **in order** and
short-circuits on the first failure. It **never throws** for business outcomes —
it always returns a `PaymentRecord` and records exactly **one** `PAYMENT` event.

| # | Stage | Port | Failure outcome |
| --- | --- | --- | --- |
| 1 | **Identity** — `N.identityStatus === "verified"` **and** every ancestor verified | `IdentityGate` (World ID for Agents) | `DENIED_IDENTITY` |
| 2 | **Mandate** — self/ancestor not revoked; self/ancestor not expired; `A ≤ available(N)`; merchant allowed; purpose allowed | `DelegationTree` checks | `REVOKED` (revoked in chain) or `BLOCKED_MANDATE` |
| 3 | **Screening** — live risk/compliance screen on `(merchant, amount, purpose)` | `ScreeningService` (Intercepta) | `BLOCKED_SCREENING` |
| 4 | **Settlement** — if `payerToken !== merchantToken`, swap; move funds | `SettlementService` (1inch Aqua) | (settlement failure) |

On success the outcome is `SETTLED`, `N.spentDirect += A`, and the spend
propagates upward through `available` (because ancestors' `reserved`/`spent`
math now reflects it). `revoke(name)` sets `revoked = true`, after which every
descendant fails stage 2's ancestor-revoked check.

### Ordering matters (the Intercepta demo hinges on it)

The **mandate merchant-allowlist check (stage 2) runs before screening (stage
3).** For a payment to even reach Intercepta, the merchant must first be
*permitted by policy*. That's why the demo puts `sanctioned-vendor` in
researcher's allowlist: policy allows it, but **live screening** catches it —
which is the entire value proposition of the screening stage. If the merchant
were not in the allowlist, the payment would stop at `BLOCKED_MANDATE` and never
demonstrate Intercepta.

---

## 6. Package layout & module system

```
packages/core         @allowance/core         pure domain (zero runtime deps)
packages/adapters     @allowance/adapters     sponsor ports: mock + real stub
services/orchestrator @allowance/orchestrator x402 flow + demo runner
apps/web              allowance-web           Vite + React dashboard
contracts             solidity (Hardhat)      Uniswap v4 hook / settlement guard
```

- **ESM everywhere** (`"type": "module"`), **TypeScript strict**,
  `moduleResolution: "bundler"`, `module: "ESNext"`.
- Cross-package imports resolve to **source `.ts`** (each package's `exports`
  maps `"."` → `"./src/index.ts"`), so `tsx` and Vite run with no build step;
  `tsc -b` is typecheck-only.
- `@allowance/core` has **zero runtime dependencies** — it is pure domain logic
  and can be embedded anywhere.

### Adapter ports (the seam between domain and sponsors)

`payment.ts` defines four interfaces that `@allowance/adapters` implements:

```
IdentityGate       verify(ctx)   → IdentityResult             (World ID for Agents)
ScreeningService   screen(req)   → ScreeningResult            (Intercepta)
SettlementService  settle(req)   → SettlementResult           (1inch Aqua)
PrincipalVerifier  verify(proof) → PrincipalVerificationResult (World IDKit)
```

Every port ships **two** implementations: a **deterministic offline mock**
(the demo runs entirely on these — no network, no credentials) and a
**real-integration stub** marked with `TODO(cred)` and doc links, which throws a
clear "not configured" error until wired to real SDKs. This is what lets the
whole thing demo offline while keeping a credible path to production.

---

## 7. Data flow

```
agent action
   │
   ▼
@allowance/core         attenuation check (delegate) OR payment pipeline (pay)
   │                    mutates the DelegationTree, appends AllowanceEvents
   ▼
@allowance/adapters     identity / screening / settlement / principal ports
   │                    (mock in the demo; real stubs behind the same interfaces)
   ▼
serialize.ts            toSnapshot(tree) → Snapshot; writeSnapshotFile(...)
   │
   ▼
apps/web/public/demo-snapshot.json      the single artifact the dashboard reads
   │
   ├─► apps/web (React)         spend-tree visualization + event ledger
   └─► Curvegrid dashboard      MultiBaas-style view of the same spend tree
```

The orchestrator's `src/demo.ts` drives the eight-step storyline with
`createMockAdapters()` and writes the snapshot to
`apps/web/public/demo-snapshot.json`. A schema-correct **seed** snapshot already
lives at that path so the web app renders before the orchestrator runs;
`npm run demo` overwrites it with freshly computed state.

### Boundary safety (why the seam is trustworthy)

The snapshot is a **frozen contract** (see §3 and DESIGN.md §7 / `types.ts`) —
but a file on disk is still untrusted input at read time, so the web app hardens
the seam in two ways:

- **Validated fetch, not a blind cast.** Rather than casting the fetched JSON to
  `Snapshot` and hoping, the app runs it through `parseSnapshot` — a runtime
  guard that checks shape and field types at the fetch boundary. A truncated or
  malformed snapshot therefore surfaces as a clean error state in the UI instead
  of a crash deep in a component.
- **Exhaustive union handling.** The domain's closed unions (`PaymentOutcome`,
  `EventResult`, `EventType`) are handled without gaps: switch/lookup sites use
  the `assertNever` helper and a total `Record<EventResult, …>` failure
  classifier, so adding a new union member is a **compile error** until every
  consumer accounts for it — the contract can't silently drift.

---

## 8. On-chain vs off-chain split

Allowance is deliberately a **hybrid**: the delegation *logic* is cheap, fast,
and auditable off-chain, while the *hard spend ceiling* is enforced on-chain.

**Off-chain (`packages/core`, `packages/adapters`, `services/orchestrator`):**
- The delegation tree, attenuation math, and payment pipeline.
- Identity, screening, and settlement orchestration via the adapter ports.
- Snapshot generation and the event ledger.

Off-chain is where the protocol *decides* whether a delegation or payment is
allowed and produces the audit trail.

**On-chain (`contracts/`):**
- A **Uniswap v4 hook / settlement guard** that enforces the attenuated spend
  cap *at settlement time*. Even if the off-chain logic were bypassed, the hook
  rejects a swap/transfer that would exceed the node's authorized cap — the cap
  is the on-chain source of truth for funds movement.
- The mandate anchor: budgets/scope conceptually correspond to ENSv2 resolver
  records; the hook reads the effective cap for the paying node.

**The boundary:** off-chain computes *intent and eligibility* (who may pay whom,
for what, up to what remaining budget); on-chain enforces the *invariant that
matters for money* (you cannot move more than your cap). 1inch Aqua handles the
cross-token settlement itself when payer and merchant tokens differ, and the
Uniswap hook is the last line that guarantees attenuation was respected before
value actually leaves.
