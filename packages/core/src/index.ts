/**
 * @allowance/core — public barrel.
 *
 * Pure, zero-dependency domain layer for Allowance:
 *  - types.ts       domain + snapshot + adapter-port request/result types
 *  - amount.ts      smallest-unit <-> human decimal helpers
 *  - attenuation.ts pure "child may only narrow parent" validator
 *  - tree.ts        DelegationTree (delegate/revoke/available/reserved/events)
 *  - payment.ts     the pay() pipeline + injected adapter PORT interfaces
 *  - serialize.ts   toSnapshot() -> the exact dashboard JSON
 *  - results.ts     exhaustiveness-checked EventResult failure classifier
 *  - assert.ts      assertNever() compile-time exhaustiveness helper
 */

export * from "./types";
export * from "./amount";
export * from "./attenuation";
export * from "./tree";
export * from "./payment";
export * from "./serialize";
export * from "./results";
export * from "./assert";
