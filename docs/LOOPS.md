# Improvement loops: capital allocated across agents

Improvement loops (two run so far; more to come) aimed at the most novel part of the project: **a delegation tree as the control layer of a
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
3. **Selection.** `scripts/loop-driver.mjs` applies each surviving diff to a fresh worktree at HEAD,
   runs the typecheck and every Node and web test suite (loop 1 ran only the typecheck and the
   swarm and lab suites), and judges it world by world against the current code on **sealed block
   A** (200 worlds nobody saw). A performance claim needs a paired 90% lower bound > 0 on its
   track (normal approximation: mean ± 1.645·sd/√n) and must not cost the other track more than
   0.1 pp on average. A structural claim (a new tested guarantee, not a return claim) must be
   neutral: mean change > −0.05 pp and lower bound > −0.2 pp on both tracks. That tolerates a
   small cost; it is not "no reduction".
   **Risk guard (from loop 2).** Under CRRA γ=3 the fund's certainty equivalent rises almost
   linearly with the capital at work at this book's ~10% vol, so a change can win utility just by
   taking more risk. A risk layer must not. Every candidate must also hold each track's risk on
   every block it is judged on: mean max drawdown at most 0.5 pp above the code it replaces, and
   mean Sharpe at most 0.03 below. This rule was fixed after reading loop 2's research-seed
   numbers (one proposal gained +3.9 pp by lifting max drawdown from 7.6% to 10.4%) and before
   any loop-2 sealed run.
   **Risk track (from loop 3).** A proposal may instead claim lower drawdown: it wins if the center
   book's paired change in max drawdown has a 90% upper bound below zero, neither track's mean
   utility falls by more than 0.1 pp, and it beats plain deleveraging: when utility falls, it must
   buy at least 1.3 pp of drawdown per pp given up (uniform deleveraging buys about 0.65). A loop-3
   researcher showed that without this last rule, trimming the deploy fraction from 0.80 to 0.79
   would pass; it was added before any loop-3 sealed run.
4. **Confirmation.** Winners are combined and must **confirm on a separate sealed block B** (target
   track lower bound > 0; every other track neutral as above; risk guard held). Only then does
   anything merge.
5. **Record.** Each report (`docs/loops/loop-N.json`) carries the commit judged against, every
   candidate's diff (`docs/loops/loop-N/`), and each book's utility, Sharpe and max drawdown, not
   just the paired uplift (from loop 2; loop 1's baseline commit was re-derived by verification).
6. **Verification.** After each push, two independent agents clone the pushed commit from GitHub,
   rebuild, run every test and demo, reproduce the sealed confirmation, and screenshot the UI.
   What they find is fixed first in the next loop and recorded here.

The utility is the CRRA certainty-equivalent annual return (risk aversion 3) of the whole fund,
center book vs per-agent guardrails. All worlds are **virtual**; nothing here is market data.
Rejected ideas are recorded below with the reviewers' reasons.

## Loop 1

**Merged: (A) volatility-scaled drawdown ladder.** An agent's cut and stop-out levels now scale with the volatility that agent runs (fixed 10%/20% kept as floors; σ measured only up to the agent's last high-water mark, so a crash cannot loosen its own stop). A 20% drawdown on a 2×-levered, 50%-vol agent is noise, not evidence: the fixed ladder stopped out ~80% of skilled pickers. Stop-outs fall from ~8.2 to ~2.5 per world and become selective (pickers ~12% stopped vs herders ~46%, on research seeds 401–600; on seeds 1–200 herders are 53%).

| candidate | review | sealed block A (fund utility vs current code) | outcome |
|---|---|---|---|
| reserve — (R) Reservation: every agent carves an ops (data/execution) sub-mandate from its | rejected | — | rejected by review |
| (A) Risk-adjusted resizing, drawdown-aware: the drawdown ladder (cut to x0 | passed | +4.05 pp [90% +3.13 pp, +4.97 pp], better in 68% of worlds | winner on A |
| (G) Group cuts by operator | rejected | — | rejected by review |
| (C) Stop-out closes the subtree: book | passed | +0.59 pp [90% +0.30 pp, +0.89 pp], better in 56% of worlds | winner on A |
| Risk-scaled drawdown ladder | rejected | — | rejected by review |

**Confirmation on sealed block B** (seeds 11500–11699): (A) alone, +5.07 pp [90% +4.12 pp, +6.01 pp], better in 74.5% of worlds; tiger track unchanged (0.00 pp).

(C) also won on block A (+0.59 pp) but its diff conflicts with (A) in the ladder code, so it could not be combined. It is carried into loop 2, rebased onto the new code, to face the judge again.

Rejected by review:
- **(R) reservation with ops sub-mandates:** its headline guarantee ("the allocator is only handed what the fund can reserve") was false. A 13-agent roster throws at deploy 0.995, and the test passed through rounding.
- **(G) operator-level ladder:** replacing each agent's own record with a capital-weighted operator record lets a second, unfunded name shield a losing agent from its own stop-out.
- **Wildcard risk-scaled ladder:** uncapped scaling and an in-sample σ, so a crash loosened its own stop. Most of its gain was simply deleting stop-outs (8.2 to 1.7 per world). (A) fixes the in-sample σ but was merged uncapped too; see the correction below.

Full numbers: [`docs/loops/loop-1.json`](loops/loop-1.json).

### Loop 1 correction (found by post-push verification)

Two independent verifiers cloned `d2151ed` from GitHub. The sealed confirmation reproduced bit for
bit (block B paired mean 0.05067830594000386 vs parent `f5b2d80`), but they found:

- **Some agents could never be stopped out.** The widening had no ceiling: on research seeds
  401–600, 160 of 1930 center-book agents ended with a stop at or above a 100% drawdown (widest
  ×11.8). **Fix:** the stop never sits above `ddStopMax` = 40%, twice the agent's own 20%
  stop-loss, with the cut and restore rungs capped in proportion. 40% was fixed in advance, not
  tuned. A ceiling of 100% or more is refused. Its cost, reported and not selected on:

  | seeds | fund utility vs uncapped (paired) | center-book max drawdown |
  |---|---|---|
  | research 401–600 | −1.05 pp [90% −1.51, −0.59] | 7.65% → 7.49% |
  | sealed block A (11000–11199) | −0.11 pp [90% −0.40, +0.17] | 7.35% → 7.32% |
  | sealed block B (11500–11699) | −0.60 pp [90% −0.90, −0.30] | 7.62% → 7.58% |

  With the ceiling, loop 1's gain on block B vs its parent is **+4.47 pp [90% +3.55, +5.39]**
  (was +5.07 pp), better in 73% of worlds. A minimum sample for σ (20 returns) was also tried on
  research seeds and dropped: it cost another 0.6 pp and the ceiling already bounds a σ taken
  from a short record.
- **Max drawdown was not disclosed.** Loop 1 raised the center book's mean max drawdown on block B
  from 6.62% to 7.62% (7.58% with the ceiling), **above per-agent guardrails' 6.73%**; on block A
  from 6.39% to 7.35% (7.32%), vs 6.83%. Fund utility rose because the book keeps skilled but
  volatile agents it used to revoke, and the price is deeper drawdowns. Reports now record each
  book's max drawdown.
- **Stale claims.** README and `docs/CENTER-BOOK.md` described fixed 10%/20% rungs and pre-loop
  numbers, the checked-in `swarm-snapshot.json` was stale, the dashboard said both books share one
  stop-loss, and the AgentHire demo called its fixed rungs "center-book defaults". All are
  corrected: the docs and the snapshot are regenerated, and the AgentHire demo now says its
  ladder is the PM mandate's fixed stop-loss (the floor of the center book's rungs) and prints
  what the risk-scaled rungs would be.
- **Fragile code.** `book.ts` scaled the rungs, then passed them to a function that scales again
  (harmless only because the scaled type lacked the vol field). One `ladderStep` call now returns
  both the next state and the rungs it used.
- **Protocol text** overstated the neutrality rule, the tests the driver runs, and called a normal
  interval a t-interval. The protocol above is corrected, and the driver now runs every suite.

## Loop 2

**Merged: (A) one-year scores and (C) stop-out by `close`.** Sealed block B (seeds 12500–12699), the
two combined vs the loop-1 code with its correction: fund utility **+0.62 pp [90% +0.25, +0.99]**,
better in 59% of worlds; center-book max drawdown **−0.32 pp [90% −0.50, −0.15]**; Sharpe +0.06
[90% +0.02, +0.09]; tiger track unchanged. On that block the center book returns a certainty
equivalent of 11.65% vs 6.13% for per-agent guardrails, with a mean max drawdown of 7.75% vs 6.88%:
lower than before loop 2 (8.07%) but **still above the baseline's**.

- **(A) resize.** Each agent is scored on its last 252 days of attributable record instead of 90,
  and ranked by shrunk Sharpe rather than Sharpe ÷ vol. A Sharpe estimated on 90 days has a
  standard error of about ±1.7, as large as the skill being measured, so the old window re-ranked
  agents on luck. Block A: +0.90 pp [+0.50, +1.30], max drawdown −0.23 pp [−0.40, −0.06].
  Caveat from its review: the arena's skilled agents have stationary skill, which a long window
  rewards; an edge that decays to flat never trips the ladder and keeps its capital longer.
- **(C) close.** A stop-out is now one `DelegationTree.close(agent)`: the agent's capital and every
  sub-mandate it handed out (`AgentSpec.subMandates`, reserved at grant) return to its pod. The
  book audits the tree (`audit()`: no over-commitment, attenuation, no negative budgets, links)
  before and after every tick, `delegate()` refuses under any revoked ancestor, and grows are
  clipped to the parent's available authority. Structure track: block A utility bit-identical.
  Carried from loop 1, where it won block A but conflicted with the ladder change.

| candidate | review | sealed block A (vs current code) | outcome |
|---|---|---|---|
| (C) stop-out closes the subtree, sub-mandates, tree audit | passed | 0.00 pp (bit-identical), max DD 0.00 | winner on A |
| (A) one-year Sharpe scores | passed | +0.90 pp [+0.50, +1.30], max DD −0.23 pp | winner on A |
| (G) crowding measured beyond the lead counterparty | passed | +3.35 pp [+2.58, +4.13], **max DD +2.48 pp** [+2.22, +2.75] | **rejected by the risk guard** |
| wildcard: deploy × NAV and redeploy freed capital | rejected | — | rejected by review |
| (G) operator credit event: cap an operator's other names on a stop-out | rejected | — | rejected by review |

Rejected:
- **Crowding beyond the lead counterparty** won the most utility, by loosening the crowding limits:
  cuts per world fell from 57 to 6, the largest holder's position (up to 40% of NAV) became exempt,
  peak exposure to a crowded name rose from about 21% to 37% of NAV, and worst-world max drawdown
  from 18.8% to 28.6% on research seeds. Its review also found that a net-flat operator could be
  the exempt "lead" and wipe out a real crowd. This is the case the risk guard was written for.
- **Constant-proportion deploy and redeploy:** +0.3 pp by putting more capital at risk (Sharpe
  −0.023, max drawdown +0.27 pp on research seeds), and its "80% of NAV at work" claim was false
  (about 50%). It was also cut against the pre-fix code; the orchestrator's rebase had to switch
  off stop-outs in one of its tests.
- **Operator credit event:** its "caps never compound" guarantee was untested and false: a name the
  ladder had cut and then restored, still at half capital, was halved again (seeds 59, 168, 260).

All five proposals were written against `d2151ed` and rebased by the orchestrator onto the corrected
code (`dc01ec0`); the judge ran at `370e0b8`, which adds only the risk guard and per-world drawdown
reporting. Independent verification (fresh clone of `69d0dcf`) reproduced block B and every
block-A number bit for bit. Full numbers: [`docs/loops/loop-2.json`](loops/loop-2.json); diffs:
[`docs/loops/loop-2/`](loops/loop-2/).

