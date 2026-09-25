# Allowance — DESIGN.md (authoritative spec)

> **Give your AI agents an allowance, not your wallet.**
> An attenuating-delegation protocol for autonomous AI-agent payments.

This file is the **single source of truth** for every builder in this monorepo.
Import paths, type names, and function signatures below are **locked** — build to
them exactly. The `@allowance/core` package already implements everything in
sections 3–7; adapters, orchestrator, web, and contracts bind to it.

---

## 1. The problem & the insight

Agents spawn sub-agents that spend money. There is no clean primitive for
authority that **attenuates** down a chain: each hop can only *narrow* its
parent's budget/scope, must be revocable, and must be fully auditable.

**Insight:** ENSv2's hierarchical name registry *is* a delegation tree. A name
like `scraper.researcher.alice.eth` encodes who-is-boss-of-whom (the **left-most
label is the node itself**), and each node stores its mandate (budget/scope) as
resolver records. **Attenuation** = a child's budget is always a slice of its
parent's *remaining* budget.

---

## 2. Domain model (authoritative)

- **Amounts.** Integers in the token's smallest unit (USDC → 6 decimals). Held
  as `bigint` in memory. Serialized in JSON as decimal **strings of the
  smallest-unit integer** (100 USDC → `"100000000"`). Human ↔ smallest-unit
  conversion lives in `@allowance/core` (`parseAmount` / `formatAmount`).
- **Principal.** The human root, verified via World **IDKit**. Grants a root
  budget to the root agent node.
- **Node (agent).** `{ name, parent, identityStatus, mandate }`.
  `identityStatus ∈ "verified" | "expired" | "none"`.
- **Mandate.** `{ budget, spentDirect, allowedMerchants?, allowedPurposes?,
  expiry, revoked }`. An **absent** allowlist (`undefined`) means **any**.
- **Derived:** `reserved(node) = Σ children.mandate.budget`.
  `available(node) = budget − spentDirect − reserved`.

### Attenuation rule (delegate parent **P** → child **C** with mandate **M**)

Valid **iff all** hold (else typed rejection):

1. `M.budget ≤ available(P)`
2. `P.allowedMerchants === undefined` **or** `M.allowedMerchants ⊆ P.allowedMerchants`
3. `P.allowedPurposes === undefined` **or** `M.allowedPurposes ⊆ P.allowedPurposes`
4. `M.expiry ≤ P.mandate.expiry`
5. (guard) `P` is not revoked.

> A restricted parent (defined allowlist) forces the child to declare a defined
> allowlist too — a child leaving it `undefined` (= "any") would *broaden*
> authority and is rejected (`MERCHANTS_NOT_SUBSET` / `PURPOSES_NOT_SUBSET`).

### Payment pipeline (`pay(node N, merchant Mkt, amount A, purpose Pp)`)

Runs in order, short-circuits on first failure:

1. **identity** — `N.identityStatus === "verified"` **and** every ancestor
   verified (via `IdentityGate`). Else → `DENIED_IDENTITY`.
2. **mandate** —
   - self-or-ancestor revoked → `REVOKED`
   - self-or-ancestor expired, or `A > available(N)`, or `Mkt`/`Pp` not allowed
     → `BLOCKED_MANDATE`
3. **screening** — live Intercepta call on `(Mkt, A, Pp)`. Else → `BLOCKED_SCREENING`.
4. **settlement** — if `payerToken !== merchantToken`, 1inch Aqua swaps; move
   funds → `SETTLED`.

On `SETTLED`, `N.spentDirect += A`. Every attempt records **one** `PAYMENT`
event. `revoke(name)` sets `revoked = true`; all descendants' payments then
fail the ancestor-revoked check.

> **Ordering note (important for the demo):** the mandate merchant-allowlist
> check runs *before* screening. For a payment to reach the Intercepta stage the
> merchant must first be permitted by the mandate. See §8 step (e).

---

## 3. Workspace layout

```
package.json            root: npm workspaces packages/* services/* apps/* contracts
tsconfig.base.json      strict, ESM, composite (declaration + project refs)
tsconfig.json           root solution file → references core, adapters, orchestrator
DESIGN.md               this file
packages/core        →  @allowance/core        pure domain (DONE — build to it)
packages/adapters    →  @allowance/adapters    sponsor adapters (mock + real stub)
services/orchestrator→  @allowance/orchestrator x402 flow + demo runner
apps/web             →  allowance-web          Vite + React dashboard
contracts            →  solidity (Hardhat)     Uniswap v4 hook / settlement guard
docs/                →  ARCHITECTURE.md SPONSORS.md FEEDBACK.md
```

**Module system.** ESM everywhere (`"type": "module"`), TypeScript **strict**,
`moduleResolution: "bundler"`, `module: "ESNext"`. Cross-package imports resolve
to **source `.ts`** (each package's `exports` maps `"."` → `"./src/index.ts"`),
so `tsx` and Vite run without a build step; `tsc -b` is typecheck-only.

**Every workspace package MUST ship a composite `tsconfig.json`:**

```jsonc
// packages/adapters/tsconfig.json  (and services/orchestrator/tsconfig.json)
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "tsBuildInfoFile": "dist/.tsbuildinfo" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }]   // adapters → core; orchestrator → core + adapters
}
```

The root `tsconfig.json` already references `packages/core`,
`packages/adapters`, and `services/orchestrator`. `npm run typecheck`
(`tsc -b tsconfig.json`) will fail until those two tsconfigs exist — create them.

**Root scripts** (already defined):

| script | command |
| --- | --- |
| `demo` | `tsx services/orchestrator/src/demo.ts` |
| `snapshot` | alias of `demo` |
| `typecheck` | `tsc -b tsconfig.json` |
| `test` | `node --import tsx --test packages/core/src/*.test.ts` |
| `dev:web` | `npm -w allowance-web run dev` |
| `build:web` | `npm -w allowance-web run build` |

Do **not** run `npm install` (the Verify phase installs once at the root).
Root devDeps: `typescript`, `tsx`, `@types/node`.

---

## 4. `@allowance/core` public API (locked)

Import everything from the barrel: `import { … } from "@allowance/core";`

### 4.1 Domain types (`types.ts`)

```ts
type IdentityStatus = "verified" | "expired" | "none";

interface Mandate {
  budget: bigint;
  spentDirect: bigint;
  allowedMerchants?: string[];   // undefined = any
  allowedPurposes?: string[];    // undefined = any
  expiry: number;                // unix seconds
  revoked: boolean;
}

interface AgentNode {
  name: string;                  // ENS-style dotted, child label left-most
  parent: string | null;         // null = root agent
  identityStatus: IdentityStatus;
  mandate: Mandate;
}

interface Principal { name: string; verified: boolean; }

// Input to grant/delegate (spentDirect & revoked are managed by the tree):
interface MandateInput {
  budget: bigint;
  allowedMerchants?: string[];
  allowedPurposes?: string[];
  expiry: number;
}

interface PaymentRequest {
  node: string;
  merchant: string;
  amount: bigint;
  purpose?: string;
  payerToken?: string;           // defaults to settlement token (USDC)
  merchantToken?: string;        // defaults to USDC
}

type PaymentOutcome =
  | "SETTLED" | "DENIED_IDENTITY" | "REVOKED"
  | "BLOCKED_MANDATE" | "BLOCKED_SCREENING";

interface PaymentRecord {
  seq: number; node: string; merchant: string; amount: bigint;
  purpose?: string; outcome: PaymentOutcome; reason?: string;
  screening?: ScreeningResult; settlement?: SettlementResult; at: number;
}

type EventType = "FUND" | "DELEGATE" | "PAYMENT" | "REVOKE" | "RESIZE";
type EventResult =
  | "OK" | "SETTLED" | "BLOCKED_MANDATE" | "BLOCKED_SCREENING"
  | "DENIED_IDENTITY" | "REVOKED" | "ATTENUATION_REJECTED";

interface AllowanceEvent {
  seq: number; type: EventType; node: string; detail: string;
  result: EventResult; amount: bigint | null; merchant: string | null;
}
```

### 4.2 Amount helpers (`amount.ts`)

```ts
const USDC_DECIMALS = 6;
function parseAmount(value: string | number, decimals?: number): bigint; // "100.000000" -> 100000000n
function formatAmount(value: bigint, decimals?: number): string;         // 100000000n -> "100.000000"
```

### 4.3 Attenuation (`attenuation.ts`)

```ts
type AttenuationRejectionReason =
  | "PARENT_REVOKED" | "BUDGET_EXCEEDS_AVAILABLE" | "MERCHANTS_NOT_SUBSET"
  | "PURPOSES_NOT_SUBSET" | "EXPIRY_EXCEEDS_PARENT" | "NEGATIVE_BUDGET"
  | "BELOW_COMMITTED";   // resize only: new budget < spentDirect + reserved

type AttenuationDecision =
  | { ok: true }
  | { ok: false; reason: AttenuationRejectionReason; message: string };

class AttenuationError extends Error { readonly reason: AttenuationRejectionReason; }

function isAllowlistSubset(child: string[] | undefined, parent: string[] | undefined): boolean;
function checkAttenuation(parent: AgentNode, proposed: MandateInput, parentAvailable: bigint): AttenuationDecision;
```

### 4.4 Delegation tree (`tree.ts`)

```ts
// ENS-style name helpers
function labels(name: string): string[];
function leftLabel(name: string): string;                       // "scraper.researcher.alice.eth" -> "scraper"
function parentNameOf(name: string): string | null;             // -> "researcher.alice.eth"
function childName(parentName: string, childLabel: string): string; // ("alice.eth","researcher") -> "researcher.alice.eth"

class UnknownNodeError extends Error {}
class DuplicateNodeError extends Error {}

interface FundRootOptions {
  principal: string; rootName: string; mandate: MandateInput;
  principalVerified?: boolean;   // default true; pass the IDKit result
  identityStatus?: IdentityStatus; // default "verified"
}
interface DelegateOptions { identityStatus?: IdentityStatus; } // default "verified"

class DelegationTree {
  get principal(): Principal | null;
  get events(): readonly AllowanceEvent[];
  get nextSeq(): number;

  listNodes(): AgentNode[];
  getNode(name: string): AgentNode | undefined;
  requireNode(name: string): AgentNode;              // throws UnknownNodeError
  childrenOf(name: string): AgentNode[];
  ancestors(name: string): AgentNode[];              // immediate parent → root
  reserved(name: string): bigint;
  available(name: string): bigint;
  isRevokedInChain(name: string): boolean;
  isExpiredInChain(name: string, now: number): boolean;

  fundRoot(opts: FundRootOptions): AgentNode;        // records FUND / OK
  delegate(parentName: string, childLabel: string, mandate: MandateInput, opts?: DelegateOptions): AgentNode;
  // ^ success → DELEGATE / OK ; on attenuation failure records DELEGATE /
  //   ATTENUATION_REJECTED **then throws AttenuationError** (wrap in try/catch).
  revoke(name: string): AgentNode;                   // records REVOKE / REVOKED
  resize(name: string, newBudget: bigint): AgentNode;
  // ^ the allocator's lever (packages/swarm). Grow only from the parent's
  //   available budget (root cannot grow); shrink only down to spentDirect +
  //   reserved; revoked subtrees refused. Success → RESIZE / OK; failure records
  //   RESIZE / ATTENUATION_REJECTED then throws AttenuationError.
  close(name: string): bigint;
  // ^ close a mandate and return the authority it frees. Every descendant,
  //   deepest first, is shrunk to what its whole subtree spent (spentDirect +
  //   everything spent under its children; a child that overspent keeps its
  //   budget but its parent still counts the real spend, so no ancestor ends
  //   below what its subtree spent), then the node itself, then the node is
  //   revoked. Result = budgetBefore - budgetAfter = exactly
  //   how much the parent's available() rises (for the root: returned to the
  //   principal). Events: RESIZE / OK per node whose budget changed, then
  //   REVOKE / REVOKED with amount = freed. Only ever shrinks, so it also
  //   reclaims budget stranded under individually revoked descendants (which
  //   resize() refuses). Idempotent: an already-closed node frees 0n and
  //   records nothing; a revoked-but-unclosed node is shrunk without a second
  //   REVOKE. Unknown name → throws UnknownNodeError. Synchronous, so it cannot
  //   interleave with pay()'s checks — but a settlement already awaiting inside
  //   pay() can land after it; run close() through the same per-root queue as
  //   payments (SerializedPayer in @allowance/adapters) when payments are live.
  subtree(name: string): AgentNode[];                // node + descendants, parents first
  spentInSubtree(name: string): bigint;              // Σ spentDirect over the subtree
  isClosed(name: string): boolean;
  // ^ revoked AND no node in its subtree has available > 0 (what close()
  //   leaves; a bare revoke strands the unspent budget and is not closed).
  audit(): TreeViolation[];
  // ^ standing invariants, [] when sound: OVER_COMMITTED (spentDirect +
  //   Σ children's budgets > budget), NEGATIVE_BUDGET, NOT_ATTENUATED (a
  //   child's merchants/purposes/expiry broaden its parent's), BROKEN_LINK.
  //   The API preserves all of them; audit() catches an unserialized
  //   overspend or a direct write. delegate() also refuses (PARENT_REVOKED)
  //   under any revoked ANCESTOR, so nothing is minted inside a closed subtree.
  recordEvent(event: Omit<AllowanceEvent, "seq">): AllowanceEvent; // custom events
}
```

### 4.5 Payment pipeline & **adapter PORT interfaces** (`payment.ts`)

These four interfaces are the contract `@allowance/adapters` implements:

```ts
interface IdentityGate      { verify(ctx: IdentityCheckContext): Promise<IdentityResult>; }
interface ScreeningService  { screen(req: ScreeningRequest): Promise<ScreeningResult>; }
interface SettlementService { settle(req: SettlementRequest): Promise<SettlementResult>; }
interface PrincipalVerifier { verify(proof: PrincipalProof): Promise<PrincipalVerificationResult>; }

interface PaymentAdapters { identity: IdentityGate; screening: ScreeningService; settlement: SettlementService; }
interface PayOptions { now?: number; settlementToken?: string; } // now defaults to Date.now()/1000

async function pay(
  tree: DelegationTree,
  req: PaymentRequest,
  adapters: PaymentAdapters,
  opts?: PayOptions,
): Promise<PaymentRecord>;   // never throws for business outcomes; records one PAYMENT event
```

Port request/result types (from `types.ts`):

```ts
interface IdentityCheckContext { node: AgentNode; ancestors: AgentNode[]; }
interface IdentityResult { ok: boolean; reason?: string; }

interface ScreeningRequest { node: string; merchant: string; amount: bigint; purpose?: string; }
interface ScreeningResult  { approved: boolean; reason?: string; reference?: string; }

interface SettlementRequest {
  node: string; merchant: string; amount: bigint; purpose?: string;
  payerToken: string; merchantToken: string;
}
interface SettlementResult {
  settled: boolean; swapped: boolean; fromToken: string; toToken: string;
  amountIn: bigint; amountOut: bigint; reference?: string; reason?: string;
}

interface PrincipalProof { action?: string; signal?: string; [k: string]: unknown; }
interface PrincipalVerificationResult { verified: boolean; nullifierHash?: string; reason?: string; }
```

### 4.6 Serialization (`serialize.ts`)

```ts
interface ToSnapshotOptions { asOf?: number; events?: readonly AllowanceEvent[]; decimals?: number; }
function toSnapshot(tree: DelegationTree, opts?: ToSnapshotOptions): Snapshot;
function snapshotToJSON(snapshot: Snapshot): string;
async function writeSnapshotFile(tree: DelegationTree, filePath: string, opts?: ToSnapshotOptions): Promise<Snapshot>;
```

---

## 5. `@allowance/adapters` public API (builder MUST expose this)

Package `@allowance/adapters`, barrel `src/index.ts`. Implements the four core
ports. **Every adapter ships a deterministic offline MOCK plus a clearly-marked
real-integration stub** (`TODO(cred)` + doc links). The demo runs entirely on
mocks.

**Required named exports:**

```ts
// ---- Mocks (deterministic, offline, no throwing on business paths) ----
class MockIdentityGate      implements IdentityGate {}      // World ID for Agents
class MockScreeningService  implements ScreeningService {}  // Intercepta
class MockSettlementService implements SettlementService {} // 1inch Aqua
class MockPrincipalVerifier implements PrincipalVerifier {} // World IDKit

// One-call factory returning the PaymentAdapters bundle used by pay():
function createMockAdapters(config?: MockAdapterConfig): PaymentAdapters;

// ---- Real-integration stubs (throw a clear "not configured" error until wired) ----
class WorldAgentIdentityGate   implements IdentityGate {}
class InterceptaScreeningService implements ScreeningService {}
class AquaSettlementService    implements SettlementService {}
class WorldIDKitVerifier       implements PrincipalVerifier {}
```

**Recommended mock behavior (so the demo storyline in §8 works):**

- `MockIdentityGate.verify` → `ok` iff `ctx.node.identityStatus === "verified"`
  **and** every ancestor is `"verified"`; otherwise `{ ok:false, reason }`.
- `MockScreeningService.screen` → blocked when the merchant is on a configurable
  denylist (default includes `"sanctioned-vendor"`, or any `merchant` starting
  with `"sanctioned"`). Return a `reference` on both paths.
- `MockSettlementService.settle` → always `settled:true`; `swapped =
  payerToken !== merchantToken`; echo `amountIn/amountOut = req.amount`
  (a mock 1:1 rate is fine); include a `reference`.
- `MockPrincipalVerifier.verify` → `verified:true` for a normal proof;
  `verified:false` when `proof.signal === "fail"` (or `proof.action === "fail"`)
  to exercise the IDKit failure path.

`MockAdapterConfig` (suggested): `{ deniedMerchants?: string[]; swapRate?: number; verifiedNames?: string[]; }`.

### 5.1 AgentHire (`agenthire.ts`)

AgentHire (shalpate/agenthire @ ab317f2) is a Flask agent marketplace paid over
x402 / EIP-3009 on Mock USDC (Fuji 43113). Its x402 server does not bind the
permit value to the price or check `validBefore` or the nonce, so the payer side
does those checks. Merchants are `agenthire:<agentId>`; money is micro-USDC bigint.

```ts
class AgentHireClient {            // (baseUrl, fetchImpl?, { timeoutMs?, payTimeoutMs? = 150s }); non-JSON bodies (HTML 429) throw AgentHireError
  getAgent(id); listAgents(q?); quote(id); onchainInfo(); reputation(id); stake(id);
  x402Challenge(agentId, amountMicro);          // 402 from GET /api/x402/demo-execute/:id?amountUSDC=
  x402Pay(permit);                              // POST /api/x402/pay (keyless: status "mock", realTx false)
  x402Execute(agentId, amountMicro, permit);    // FUJI: same permit as X-Payment on the x402 route
  triggerDirect({ fromId, toId, amountMicro, reason? }); simEvents(sinceId, limit?);
  simStatus(); simStart(); setSimSpeed(tickRealSeconds); a2aCandidates();
  submitDispute({ agentId, severity, reason, affectedUser }); // keyless: printed to AgentHire's log, pending_review; nothing stored, no slash
}
class AgentHireSettlementService implements SettlementService {} // never throws; refusals -> settled:false, "settlement: ..."; post-send failures -> UNCONFIRMED (charged)
class AgentHireScreeningService  implements ScreeningService {}  // banned / tier / incidents / OPERATOR incidents (store re-read each check), fail-closed
class OperatorRegistry {}   // agentId -> { deployerWallet, worldIdNullifier (World ID mock) }: one counterparty per operator
class IncidentLedger {}     // Allowance-side incidents keyed by agent AND operator (AgentHire has no keyless non-slashing route); in memory or an IncidentStore
class JsonFileIncidentStore implements IncidentStore {} // local JSON file: other processes / restarts see the same incidents (single writer)
class OverspendWatch {}     // repeated "exceeds available" -> incident (+ sent to AgentHire's dispute route, which keyless only logs)
class SerializedPayer {}    // pay()/close() one at a time per root mandate; queues shared by every payer in the process
function agentHireTreeHooks(tree): { mandateExpiry, nextSeq };
function quoteMicro(quote): bigint; function encodeUsdcParam(micro): string; // survives Python int(float*1e6)
function settleModeFromEnv(env?): "mock" | "fuji";                            // AGENTHIRE_SETTLE
function payerSignerFromEnv(env?): { signer, source };                        // AGENTHIRE_PAYER_KEY (env only) or a throwaway
class QuoteBook {}          // (node, agentId) -> quote; fetch(client, node, agentId) reads /api/pricing/quote itself and is the ONLY way in
function planHire({ cap, main, subs: {key, weight}[] }): HirePlan;  // main = its quote; subs split cap - main pro rata, summing to the micro
function delegateAll(tree, parent, children): AgentNode[];            // all-or-nothing: a whole subtree (children may carry children) is checked, then written
function aliasNodeLabel(hirerId, subAgentId): string;                 // "a<sub>-via-a<hirer>": one node per A2A edge (cycles, shared children)
function aliasPayerAgentId(node): number | undefined;                 // payerAgentIdOf for alias nodes
function recoverPermitSigner(permit, usdc, chainId?): string; function createThrowawaySigner(): TypedDataSigner;
```

Settlement always refuses an amount that is not AgentHire's own quote for the
agent being paid, to the micro-USDC: the `QuoteBook` entry the hire was sized
from (read from this same AgentHire, at most `quoteMaxAgeSeconds` old, default
900), or, with no book, a live GET /api/pricing/quote read at settle time.
AgentHire's x402 route prices whatever `?amountUSDC=` it is asked for, so the
challenge's echo binds nothing; the quote does. Settlement then refuses unless
the 402 challenge matches: chainId 43113 (challenge, domain, deployment), token
and domain `verifyingContract` = MockUSDC, recipient and `permit.to` =
EscrowPayment (from /api/onchain/info), `amountMicro` = permit value = the
checked amount, domain "Mock USDC" v1, and `validBefore` later than now but no
later than the paying node's mandate expiry. It then signs its own EIP-3009
permit (fresh nonce). A node that is itself an AgentHire agent
(`payerAgentIdOf`) settles through /api/sim/trigger-direct with reason
`allowance:<node>#<seq>`. Once the permit or the trigger-direct request has
been sent, a timeout, 5xx, refusal of the permit or mismatched answer is
UNCONFIRMED, not refused: it returns `settled:true` so pay() charges the
mandate (AgentHire may have booked it, and a permit is redeemable until
`validBefore`), with an `agenthire-unconfirmed:` reference and
`receipt.unconfirmed` for reconciliation. The only post-send refusal is a 4xx
from trigger-direct, which AgentHire answers before booking. Both keyless routes
are simulated and receipts say so. AgentHire's escrow is off-chain in live
flows, so nothing here claims escrow protection. The `fuji` path is unit-tested
with a fake fetch only. It needs AgentHire facilitator keys, a Fuji RPC, and a
payer holding Fuji Mock USDC (`AGENTHIRE_PAYER_KEY`; a throwaway signer holds
none), so it has not been run. On chain, `contracts/contracts/SpendCapHook.sol`
enforces the cap at swap time (a view-style `beforeSwap` check against
`MandateRegistry.canSpend`); the same check in front of
`transferWithAuthorization` is not built.

---

## 6. `@allowance/orchestrator` responsibilities

- Depends on `@allowance/core` and `@allowance/adapters`.
- `src/demo.ts` runs the **full storyline in §8 offline**, using
  `createMockAdapters()`, and writes the snapshot to
  **`apps/web/public/demo-snapshot.json`** via
  `writeSnapshotFile(tree, "apps/web/public/demo-snapshot.json", { asOf })`.
  (A schema-correct **seed** snapshot already exists at that path so the web app
  renders before the orchestrator is built; `npm run demo` overwrites it.)
- IDKit failure path (§8 has success): call `MockPrincipalVerifier.verify` with a
  failing proof and log that funding was refused — do **not** call `fundRoot`.
- May also host the x402 payment flow; keep the demo runnable with `npm run demo`.
- `src/agenthire-demo.ts` (`npm run demo:agenthire`) runs the AgentHire story
  LIVE against a local keyless AgentHire (`scripts/agenthire-up.sh`; base URL from
  `AGENTHIRE_URL`). It also depends on `@allowance/swarm` (`nextLadderState`) and
  `@allowance/lab` (arena return path). Every payment and `close()` goes through
  a `SerializedPayer`. On success it writes `apps/web/public/agenthire-snapshot.json`
  (this schema, via `writeSnapshotFile`) and `apps/web/public/agenthire-receipts.json`;
  a run with a failed check writes `*.failed.json` instead. See `docs/AGENTHIRE.md`.

---

## 7. Snapshot JSON schema (the one artifact the dashboard reads)

Path: **`apps/web/public/demo-snapshot.json`**. Amounts are decimal **strings**
of smallest-unit integers. `allowedMerchants`/`allowedPurposes` are `null` when
unrestricted.

```jsonc
{
  "asOf": 1790337600,                 // unix seconds
  "currency": "USDC",
  "decimals": 6,
  "principal": { "name": "alice", "verified": true },
  "nodes": [
    {
      "name": "researcher.alice.eth",
      "parent": "alice.eth",
      "identityStatus": "verified",   // "verified" | "expired" | "none"
      "mandate": {
        "budget": "30000000",
        "spentDirect": "8000000",
        "reserved": "10000000",       // Σ children budgets (derived, provided for you)
        "available": "12000000",      // budget - spentDirect - reserved (derived)
        "allowedMerchants": ["arxiv","openai","sanctioned-vendor"], // or null = any
        "allowedPurposes": null,
        "expiry": 1792929600,
        "revoked": true
      }
    }
    // ...one entry per node
  ],
  "events": [
    {
      "seq": 0,
      "type": "PAYMENT",              // FUND | DELEGATE | PAYMENT | REVOKE
      "node": "researcher.alice.eth",
      "detail": "paid 8000000 to openai",
      "result": "SETTLED",            // OK|SETTLED|BLOCKED_MANDATE|BLOCKED_SCREENING|DENIED_IDENTITY|REVOKED|ATTENUATION_REJECTED
      "amount": "8000000",            // string or null
      "merchant": "openai"            // string or null
    }
  ]
}
```

---

## 8. Demo storyline (orchestrator + web align to this)

`FAR`/expiry values are unix seconds; the seed uses `asOf = 2026-09-25T12:00Z`
and `expiry = asOf + 30 days`.

| step | action | expected result |
| --- | --- | --- |
| (a) | Human `alice` verifies via IDKit; funds root `alice.eth` with **100 USDC** (merchants = any). | `FUND` / `OK`, principal `verified:true` |
| (b) | `alice.eth` delegates **30 USDC** to `researcher.alice.eth`, merchants `{arxiv, openai, sanctioned-vendor}`. | `DELEGATE` / `OK` |
| (c) | `researcher` delegates **10 USDC** to `scraper.researcher.alice.eth`, merchants `{arxiv}`. | `DELEGATE` / `OK` |
| (d) | `scraper` tries to pay **15 USDC** (arxiv) — exceeds its 10 available. | `PAYMENT` / `BLOCKED_MANDATE` |
| (e) | `researcher` pays **5 USDC** to `sanctioned-vendor` — Intercepta blocks. | `PAYMENT` / `BLOCKED_SCREENING` |
| (f) | `researcher` pays **8 USDC** to `openai` (payer USDC → merchant token via Aqua). | `PAYMENT` / `SETTLED` (`swapped:true`); spend propagates |
| (g) | `ghost.alice.eth` (identity `expired`) tries to pay. | `PAYMENT` / `DENIED_IDENTITY` |
| (h) | `alice` revokes `researcher.alice.eth`; `scraper` then pays. | `REVOKE` / `REVOKED`, then `PAYMENT` / `REVOKED` |

> **Why `sanctioned-vendor` is in researcher's allowlist (step b):** the mandate
> merchant check runs *before* screening (§2). If the merchant were not in the
> allowlist, step (e) would stop at `BLOCKED_MANDATE` and never reach Intercepta.
> Including it means the *policy* permits the merchant but *live screening*
> catches it — the exact value proposition of the screening stage.

**Post-run derived balances (verify against these):**
`alice.eth` available = **65 USDC** (100 − 30 − 5). `researcher.alice.eth`
available = **12 USDC** (30 − 10 reserved − 8 spent). 11 events total (FUND, three DELEGATEs, the
ATTENUATION_REJECTED delegation, five PAYMENTs and the REVOKE).

---

## 9. Sponsor → component map

| track | where it lives | contract |
| --- | --- | --- |
| **ENS** | `tree.ts` name hierarchy = the delegation/authority tree; mandates = resolver records | central |
| **World ID for Agents** | `IdentityGate` port; every `pay()` runs identity first; supports denied/expired | mock + stub |
| **World IDKit** | `PrincipalVerifier` port; human verifies to fund root; success + fail path | mock + stub |
| **Intercepta** | `ScreeningService` port; live screen before settlement; approved + BLOCKED | mock + stub |
| **1inch Aqua** | `SettlementService` port; swap payer→merchant token (SwapVM) | mock + stub |
| **Uniswap** | `contracts/` v4 hook / settlement guard enforcing the attenuated cap on-chain; ship `docs/FEEDBACK.md` | on-chain |
| **Curvegrid** | AI agent reads chain state + MultiBaas-style dashboard of the spend tree | reads snapshot/chain |
| **Sui** (stretch) | programmable escrow/settlement rail | optional |

---

## 10. Rules recap for all builders

- No `npm install` (Verify installs once at root). You may edit `package.json` deps.
- Minimal, mainstream deps. **Zero runtime deps in core.**
- Each adapter = working offline **mock** behind the core interface **plus** a
  real stub with `TODO(cred)`. The demo must run fully offline.
- Strict, commented, production-quality TypeScript. No `throw "todo"` on mock paths.
- Bind to the exact names/paths above. If you need a new shared type, add it to
  `@allowance/core` and update this file.

---

## 11. Web UX states & motion performance (`apps/web` invariants)

The dashboard is a marketing-grade single page that renders the snapshot from
§7. Its UX-state contract and motion-performance discipline have grown across
rounds (R1 perf, R5 a11y, R6 skeleton/empty/motion) and are **invariants** — do
not silently drop them when touching `apps/web`.

### 11.1 The four dashboard render states (a contract)

The `#dashboard` section is a small state machine over the async
`demo-snapshot.json` fetch. All four states must survive:

| state | trigger | UI |
| --- | --- | --- |
| **loading** | fetch in flight (`{status:"loading"}`) | **zero-CLS skeleton** that reserves the dashboard's final height, so the ready state swaps in without layout shift |
| **error** | fetch/`parseSnapshot` fails (`{status:"error"}`) | actionable `.notice-error` that shows the message **and** the `npm run demo` hint to regenerate the file, then reload |
| **empty** | snapshot parses but has **no nodes or no events** | a clear "run the demo" empty notice — never a blank panel or a crash |
| **ready** | valid, non-empty snapshot (`{status:"ready"}`) | the code-split `Dashboard` (summary tiles, spend tree, event ledger) |

The fetch validates untrusted JSON against the frozen §7 schema via
`parseSnapshot` **at the boundary** (App.tsx), so malformed/stale input lands in
`error` with a precise path-tagged message instead of crashing downstream.

### 11.2 Motion-performance rules (already in force)

- **`LazyMotion` + `m`, never full `motion.*`.** The tree is wrapped in
  `<LazyMotion features={domAnimation} strict>`; `strict` throws if a heavyweight
  `motion.*` component sneaks back onto the critical path. Keeps the entry bundle small.
- **Code-split `Dashboard`** via `React.lazy` — its subtree (NodeCard, EventLog,
  `buildTree`, format helpers) is pulled out of the entry chunk and loaded only
  after the fetch resolves, cutting time-to-interactive on the hero.
- **GPU-promoted animations only** — animate `transform`/`opacity` (with
  `will-change: transform` on the animated layers); never animate layout-affecting
  properties (width/height/top/left/margin).
- **`content-visibility: auto`** on offscreen marketing sections so the browser
  skips rendering/layout for content below the fold until it scrolls near.
- **Complete `prefers-reduced-motion` coverage** — the CSS query neutralizes all
  keyframe/transition animation and smooth-scroll, and every animated component
  reads `useReducedMotion()` to render a static equivalent (no parallax, no
  reveal, no inertia scroll).

### 11.3 Self-contained constraint

`apps/web` ships **no external fonts, CDNs, or network calls** beyond fetching
its own `demo-snapshot.json`. Typography uses system font stacks (`--sans` /
`--mono`); all assets are local. Keep it fully offline-renderable.
