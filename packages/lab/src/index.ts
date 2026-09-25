/**
 * @allowance/lab — the Luckin Tiger research lab.
 *
 *  - series.ts     CSV/FRED/events parsing, calendar alignment
 *  - fetch.ts      Yahoo + Stooq cross-checked prices, FRED T-bill, SEC earnings dates, provenance
 *  - strategy.ts   point-in-time Tiger book: size, cut, time, hedge
 *  - metrics.ts    performance, PSR, deflated Sharpe, PBO (CSCV), paired bootstrap CI
 *  - research.ts   grid, walk-forward, sealed holdout
 *  - montecarlo.ts forward block-bootstrap simulation with explicit drift
 *  - thesis.ts     the Luckin pitch as a three-question scorecard + its model
 *  - valuation.ts  scenario tree → expected return → Kelly sizing
 */

export * from "./series";
export * from "./metrics";
export * from "./strategy";
export * from "./research";
export * from "./montecarlo";
export * from "./thesis";
export * from "./valuation";
export * from "./fetch";
export * from "./arena";
