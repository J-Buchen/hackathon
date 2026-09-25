# @allowance/contracts — on-chain enforcement

The **on-chain half of Allowance**: the same attenuating-delegation rules that
`@allowance/core` enforces in TypeScript (see `DESIGN.md` §2/§4) are enforced
here in Solidity, so an autonomous agent literally *cannot* spend beyond its
attenuated, un-revoked, un-expired, merchant-scoped mandate — even on a raw AMM.

> Give your AI agents an allowance, not your wallet — and prove it on-chain.

## Contracts

| contract | what it does | sponsor track |
| --- | --- | --- |
| `MandateRegistry.sol` | The delegation tree on-chain. Nodes keyed by namehash-like `bytes32` (ENS namehash of `scraper.researcher.alice.eth`, so the **ENS name hierarchy *is* the authority tree**). Stores parent pointer, budget/spentDirect/reserved/expiry/revoked + a per-node merchant allowlist. Enforces attenuation on `delegate`, cap+scope+chain checks on `spend`, cascading `revoke`. | **ENS** (hierarchy = authority) + core enforcement |
| `SpendCapHook.sol` | A Uniswap **v4-style hook**. `beforeSwap` decodes the paying node + merchant + amount from `hookData` and reverts unless `MandateRegistry.canSpend(...)` passes — enforcing the attenuated cap *inside the swap*. Implements a minimal `IHooks` surface (`contracts/interfaces/IHooks.sol`) that is ABI-compatible with v4; comments cite the real `BaseHook`. | **Uniswap** (v4 hook; see `docs/FEEDBACK.md`) |
| `Escrow.sol` | Settlement escrow with a **post-screening clawback window**. `deposit` locks funds for a merchant; the designated `screener` (Intercepta) may `clawback` before release; anyone may `release` to the merchant after the window. | **Intercepta** (screening) / settlement rail |
| `mocks/MockERC20.sol` | Dependency-free ERC-20 standing in for USDC in tests/deploy (no OpenZeppelin install needed). | — |

## How it mirrors `packages/core`

Every rule below is enforced identically off-chain (`attenuation.ts`, `tree.ts`,
`payment.ts`) and on-chain here:

- `available(node) = budget - spentDirect - reserved`, `reserved = Σ children.budget`.
- **Attenuation** (`delegate`): `child.budget ≤ available(parent)`,
  `child.expiry ≤ parent.expiry`, `child.merchants ⊆ parent.merchants`
  (a restricted parent forbids an "any-merchant" child), parent not revoked.
  Violations revert with typed errors (`BudgetExceedsAvailable`,
  `ExpiryExceedsParent`, `MerchantsNotSubset`, `ParentRevoked`).
- **Spend** re-checks the **entire ancestor chain** for revoked/expired, so a
  `revoke()` on any ancestor instantly disables all descendants — no descendant
  storage is touched (cascading revocation).

## Public functions

**MandateRegistry**
- `fund(node, controller, budget, expiry, merchants[])` — create root (owner only). Empty `merchants` = any.
- `delegate(parent, child, childController, budget, expiry, merchants[])` — attenuated sub-mandate.
- `spend(node, merchant, amount)` — enforce cap + allowlist + not-revoked + not-expired (self & ancestors).
- `revoke(node)` — mark revoked (node/parent controller or owner); cascades via ancestor checks.
- views: `getNode`, `available`, `reserved`, `isRevokedInChain`, `isExpiredInChain`, `isMerchantAllowed`, `canSpend`.

**SpendCapHook**
- `beforeSwap(sender, key, params, hookData)` — reverts `SpendCapExceeded` if the cap check fails; PoolManager-gated.
- `encodeHookData(node, merchant, amount)` — helper to build the `hookData` payload.

**Escrow**
- `deposit(token, merchant, screener, amount, windowSeconds)` → `id`.
- `release(id)` — pay merchant after the window (permissionless).
- `clawback(id)` — screener pulls funds back to depositor before release.
- views: `deposits(id)`, `statusOf(id)`.

## Build / test / deploy

```bash
# from repo root (deps installed once by the Verify phase — do NOT npm install here)
npm -w @allowance/contracts run build     # hardhat compile
npm -w @allowance/contracts run test      # hardhat test (all suites below)
npm -w @allowance/contracts run deploy    # scripts/deploy.ts on in-memory hardhat
```

## Tests (`test/*.ts`)

- **`MandateRegistry.test.ts`** — fund; attenuation **accept** (narrower budget/expiry/merchants) and **reject** (over-budget, expiry-exceeds-parent, merchant-not-subset, restricted→any); spend within cap; **over-budget spend revert**; merchant-not-allowed revert; **revoke-then-spend revert** (cascading to descendant + self); expiry revert; authorization gating.
- **`SpendCapHook.test.ts`** — swap allowed within cap; **swap reverted over cap**; swap reverted to non-allowlisted merchant; swap reverted after revoke; PoolManager-only gating.
- **`Escrow.test.ts`** — deposit holds funds; **release after window** (too-early revert); **screener clawback** returns funds; non-screener clawback rejected; no clawback/double-release after release.

## Notes

- Merchants are on-chain `address`es (payment recipients); off-chain string
  merchant handles map to the address they resolve to.
- The minimal `IHooks` interface exists because full v4 periphery is heavy for a
  hackathon; the layout matches v4 so `SpendCapHook` is drop-in against the real
  `BaseHook`. See `docs/FEEDBACK.md` for the Uniswap track write-up.
