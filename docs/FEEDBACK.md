# Uniswap v4 — Developer Feedback

> Submitted for the Uniswap prize track. This is honest, first-hand feedback on
> building on the Uniswap v4 stack for **Allowance** — an attenuating-delegation
> protocol where a v4 **hook / settlement guard** enforces each agent's
> attenuated spend cap on-chain (`contracts/`). Please also see the completed
> Uniswap feedback **form** linked on the prize page.

## What we built on v4

A v4 hook that acts as a **settlement guard**: before value moves for an agent's
payment, the hook reads the effective (attenuated) spend cap for the paying node
and reverts any swap that would exceed it. This makes the attenuation invariant —
"a child can never spend more than its slice of the parent's remaining budget" —
enforceable on-chain, independent of our off-chain delegation logic.

## What worked well

- **Hooks are the right abstraction for policy-at-settlement.** Being able to
  intercept at `beforeSwap` let us treat the spend cap as a protocol-level
  invariant rather than an app-level convention. This is exactly the seam we
  needed for an authority-enforcement use case.
- **The singleton PoolManager / flash-accounting model** made reasoning about a
  single settlement path straightforward — one place to enforce, one place to
  read balances.
- **Hook permission flags** (address-encoded permissions) made it clear at
  deploy time which callbacks we opted into, which reduced surprise.

Our concrete implementation is `contracts/SpendCapHook.sol` (hook) enforcing
against `contracts/MandateRegistry.sol` (the on-chain delegation tree), with the
minimal v4 surface we needed declared in `contracts/interfaces/IHooks.sol` and
exercised by `contracts/test/SpendCapHook.test.ts`.

- **Pulling in the full v4 periphery is heavy for a hackathon.** `BaseHook`
  transitively drags in the PoolManager, `Currency`/`CurrencyLibrary`, permit2,
  and the `Hooks` permission library. To keep the build offline and installable
  in one pass we ended up declaring a **minimal ABI-compatible `IHooks`** subset
  (`beforeSwap` + `PoolKey`/`SwapParams`) rather than importing the real base.
  A lighter, dependency-slim "hook-only" package would have saved us that call.
- **Reading external per-account state inside a hook.** Our spend cap lives in
  `MandateRegistry`, so `beforeSwap` decodes `(node, merchant, amount)` from
  `hookData` and calls `registry.canSpend(...)`. This worked cleanly, but the
  canonical examples are fee/liquidity oriented — we found no first-class recipe
  for "read a caller's external limit and revert." Documenting the `hookData`
  round-trip pattern would help authorization use cases a lot.
- **State-changing vs. read-only hooks.** We deliberately kept the hook
  **read-only** (it checks `canSpend` and reverts; it does not call `spend`) to
  avoid granting the PoolManager write access to every agent's mandate. Guidance
  on this trust boundary — when a hook should mutate external contracts vs. just
  gate — would be valuable; it wasn't obvious from the docs.
- **Error surfacing.** Reverting with a typed custom error
  (`SpendCapExceeded(node, merchant, amount, reason)`) that carries the
  registry's machine reason code made debugging blocked swaps painless. More v4
  examples using typed custom errors (vs. string reverts) would be a good nudge.
- **Hook address mining.** Encoding permissions into the hook address (CREATE2
  salt mining) is a real deploy-time tax; a documented, fast test helper that
  produces a permission-correct address for local runs would smooth onboarding.

## Suggestions

- Ship a **canonical "authorization / settlement-guard" hook example** that
  reverts based on an external per-account limit — the missing archetype
  alongside the fee/liquidity ones.
- Offer a **slim hooks-only import path** so a hook can be built and unit-tested
  without the full PoolManager/periphery dependency graph.
- Document the **`hookData` pattern** (encode/decode caller intent) and the
  read-only-vs-mutating trust boundary for hooks that touch external state.
- Better ergonomics/tooling for **hook-address mining in tests**.

## Would we build on v4 again?

Yes. For an authorization/settlement-guard use case the `beforeSwap` seam was
exactly the right place to make our attenuation invariant an on-chain protocol
rule; the only real cost was the weight of the periphery dependency graph, not
the core hook model.

---

### How to complete this before submission

1. Replace every *(fill in)* / *(replace)* prompt above with your team's actual
   experience — judges can tell templated feedback from real feedback.
2. Reference specific files in `contracts/` (the hook, its tests).
3. **Submit the Uniswap feedback FORM** linked on the prize page — the file
   alone does not satisfy the requirement.
