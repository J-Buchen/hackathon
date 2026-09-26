/**
 * @allowance/core — public barrel.
 *
 * Pure, zero-dependency domain layer for Allowance:
 *  - types.ts       domain + snapshot + adapter-port request/result types
 *  - amount.ts      smallest-unit <-> human decimal helpers
 *  - attenuation.ts pure "child may only narrow parent" validator
 *  - tree.ts        DelegationTree (delegate/revoke/available/reserved/events)
 *  - payment.ts     the pay() pipeline + injected adapter PORT interfaces
 *  - serialize.ts   toSnapshot() -> the exact dashboard JSON; replaySnapshot()
 *                   / verifySnapshot() rebuild and check a tree from it
 *  - chain.ts       the event log's SHA-256 hash chain (sha256.ts: pure TS)
 *  - results.ts     exhaustiveness-checked EventResult failure classifier
 *  - assert.ts      assertNever() compile-time exhaustiveness helper
 */

export * from "./types";
export * from "./amount";
export * from "./attenuation";
export * from "./tree";
export * from "./payment";
export * from "./serialize";
export * from "./chain";
export * from "./sha256";
export * from "./results";
export * from "./assert";
