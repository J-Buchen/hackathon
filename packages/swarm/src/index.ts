/**
 * @allowance/swarm — the center book.
 *
 *  - market.ts      deterministic synthetic market with a crowded trade
 *  - strategies.ts  the agents (Strategy interface + reference agents)
 *  - gate.ts        per-agent pre-trade gate, read from the mandate tree
 *  - allocator.ts   pure allocation math: scores, drawdown ladder, crowding
 *  - book.ts        runs a swarm under a policy; resize = reallocate, close = stop-out
 *  - swarm.ts       the default three-pod, eleven-agent swarm
 *  - trackrecord.ts per-agent attributable track records
 *  - evaluate.ts    center book vs. per-agent guardrails, single seed and sweeps
 *  - snapshot.ts    the JSON the dashboard reads
 */

export * from "./rng";
export * from "./stats";
export * from "./market";
export * from "./strategies";
export * from "./gate";
export * from "./allocator";
export * from "./book";
export * from "./swarm";
export * from "./trackrecord";
export * from "./evaluate";
export * from "./snapshot";
export * from "./tigercub";
