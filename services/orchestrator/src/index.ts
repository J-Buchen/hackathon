/**
 * @allowance/orchestrator — public barrel.
 *
 * Exposes the x402 agent-payment flow so other services (or a real HTTP 402
 * handler) can compose it. The demo runner lives in `demo.ts` and is invoked via
 * `npm run demo` (tsx); it is intentionally not re-exported here since it has
 * top-level side effects (console output + writing the snapshot file).
 */

export * from "./flow";
