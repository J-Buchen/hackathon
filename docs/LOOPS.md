# Improvement loops: capital allocated across agents

Five loops aimed at the most novel part of the project: **a delegation tree as the control layer of a
multi-manager fund whose PMs are AI agents**, where

- **(R)** capital is *reserved* per agent when it is granted, not merely capped when spent;
- **(A)** the allocator *resizes* those reservations from risk-adjusted, attributable records;
- **(G)** agents that look independent but are one trade are *cut as a group*;
- **(C)** a stop-out *closes* the agent's whole subtree, taking back its capital and everything it
  delegated, in one operation.

## Protocol (why a number here can be trusted)

1. **Research.** Five researchers per loop, one angle each (R, A, G, C, wildcard), each in its own
   git worktree, working only on research seeds (< 10000) of the virtual-world arena
   (`packages/lab/src/arena.ts`).
2. **Review.** A skeptic per proposal rejects look-ahead, reading strategy internals to identify
   skill, edits to the arena or judge, weakened tests, and guarantees its tests do not prove.
3. **Selection.** `scripts/loop-driver.mjs` applies each surviving diff to a fresh worktree, runs
   the tests, and judges it world by world against the current code on **sealed block A** (200
   worlds nobody saw). Performance claims need a paired 90% lower bound > 0. Structural claims must
   not reduce utility.
4. **Confirmation.** Winners are combined and must **confirm on a separate sealed block B**. Only
   then does anything merge.

The utility is the CRRA certainty-equivalent annual return (risk aversion 3) of the whole fund,
center book vs per-agent guardrails. All worlds are **virtual**; nothing here is market data.
Rejected ideas are recorded below with the reviewers' reasons.

## Loop 1

**Merged: (A) volatility-scaled drawdown ladder.** An agent's cut and stop-out levels now scale with the volatility that agent runs (fixed 10%/20% kept as floors; σ measured only up to the agent's last high-water mark, so a crash cannot loosen its own stop). A 20% drawdown on a 2×-levered, 50%-vol agent is noise, not evidence: the fixed ladder stopped out ~80% of skilled pickers. Stop-outs fall from ~8.2 to ~2.5 per world and become selective (pickers ~12% stopped vs herders ~46%).

| candidate | review | sealed block A (fund utility vs current code) | outcome |
|---|---|---|---|
| reserve — (R) Reservation: every agent carves an ops (data/execution) sub-mandate from its | rejected | — | rejected by review |
| (A) Risk-adjusted resizing, drawdown-aware: the drawdown ladder (cut to x0 | passed | +4.05 pp [90% +3.13 pp, +4.97 pp], better in 68% of worlds | winner on A |
| (G) Group cuts by operator | rejected | — | rejected by review |
| (C) Stop-out closes the subtree: book | passed | +0.59 pp [90% +0.30 pp, +0.89 pp], better in 56% of worlds | winner on A |
| Risk-scaled drawdown ladder | rejected | — | rejected by review |

**Confirmation on sealed block B** (seeds 11500–11699): (A) alone, +5.07 pp [90% +4.12 pp, +6.01 pp], better in 74% of worlds; tiger track unchanged (0.00 pp).

(C) also won on block A (+0.59 pp) but its diff conflicts with (A) in the ladder code, so it could not be combined. It is carried into loop 2, rebased onto the new code, to face the judge again.

Rejected by review:
- **(R) reservation with ops sub-mandates:** its headline guarantee ("the allocator is only handed what the fund can reserve") was false. A 13-agent roster throws at deploy 0.995, and the test passed through rounding.
- **(G) operator-level ladder:** replacing each agent's own record with a capital-weighted operator record lets a second, unfunded name shield a losing agent from its own stop-out.
- **Wildcard risk-scaled ladder:** uncapped scaling and an in-sample σ, so a crash loosened its own stop. Most of its gain was simply deleting stop-outs (8.2 to 1.7 per world). (A) fixes both flaws.

Full numbers: [`docs/loops/loop-1.json`](loops/loop-1.json). Note: the coffee-portfolio numbers in `docs/CENTER-BOOK.md` predate the loops and will be regenerated after loop 5.

