# Improvement loops: capital allocated across agents

Improvement loops (five run so far; one more to come) aimed at the most novel part of the project: **a delegation tree as the control layer of a
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
   **Combinations (from loop 4).** When block-A winners' diffs conflict with each other, the
   orchestrator composes them by hand (three-way merges, all suites green) before the sealed run,
   and the driver uses a composition only if the winners are exactly its members. A diff the
   driver cannot apply is recorded, never silently dropped (loop 3's defect).
   **Structure winners stand alone (from loop 5).** If neither the combination nor the best single
   winner confirms, each structural winner is checked alone on block B for neutrality: a neutrality
   check cannot be won by chasing noise, and a guarantee should not fail because it was paired with
   a performance claim that did.
   **Simulator harvests (from loop 4).** A change whose gain disappears when a known, hard-coded
   feature of the arena's market generator is switched off is a harvest of the yardstick, not an
   improvement, and is rejected before judging: the sealed blocks come from the same generator,
   so the judge cannot catch it.
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

## Loop 3

**Merged: (G) an operator is one counterparty, and (R) every order is sized from the tree.** Both
are structural guarantees, not return claims.

- **(G) operator credit event.** When one of an operator's agents is stopped out, its other live
  agents are capped together, in one `applyTargets` plan, at `cutFactor` of their full size (what
  the allocator would give them uncut) until each makes a new high on its own record or its ladder
  lifts a cut. The cap is a ceiling on capital, so it never compounds with a ladder cut or an
  earlier cap (loop 2's version halved an already-halved name); it never revokes; and every
  stop-out happens on exactly the tick the agent's own record, replayed alone, breaches its own
  stop. Sealed block A: −0.02 pp [−0.06, +0.02], max drawdown 0.00 pp. Confirmed neutral on block B
  (seeds 13500–13699): +0.01 pp [−0.03, +0.06], max drawdown −0.02 pp [−0.04, 0.00].
- **(R) reservation binds.** Each agent's order is sized from its mandate's available authority in
  the tree (budget − its own spend − what it handed down) × leverage, not from a number the book
  keeps, and a trade audit checks every order against the tree before it is marked. Its review
  found that before this change a slice handed to a desk was counted twice (as the desk's
  authority and as trading capital). Bit-identical to the operator change alone on both sealed
  blocks (every paired difference exactly 0).

On block B the center book returns a certainty equivalent of 14.41% vs 8.63% for per-agent
guardrails; its mean max drawdown is 6.63% vs 6.53% (**5.88% at the guardrails' volatility**).

| candidate | review | sealed block A (vs current code) | outcome |
|---|---|---|---|
| (G) operator credit event | passed | −0.02 pp [−0.06, +0.02], max DD 0.00 pp | winner on A; confirmed neutral on B; **merged** |
| (R) orders sized from the tree | passed | 0.00 pp (bit-identical) | winner on A; bit-identical on B; **merged** |
| established-crowd limit (risk track) | passed | −0.06 pp [−0.16, +0.04], max DD −0.15 pp [−0.20, −0.09] | winner on A; **failed B in combination** |
| drawdown (risk track) | — | no diff | null result |
| wildcard | — | no diff | null result |

**A driver defect, found and fixed.** The driver combines block-A winners by applying their diffs
in turn. The reserve and crowd diffs did not apply on top of the operator diff (conflicting
`package.json` test lists and `book.ts` lines) and were dropped without a record, so its block-B
"combination" was the operator change alone. The orchestrator composed the three by hand with
three-way merges (all 262 Node tests pass) and judged the true combination on block B: utility
−0.13 pp [−0.25, −0.02] for max drawdown −0.13 pp [−0.18, −0.07]. That fails: the utility cost is
over the 0.1 pp tolerance and it buys 0.98 pp of drawdown per pp given up, under the 1.3
deleveraging bar. The established-crowd limit is therefore not merged. The protocol's fallback,
the best single winner, is the operator change the driver had confirmed; the reserve change was
added because it is bit-identical to it on both blocks. The driver now three-way-applies,
records any diff it drops, and records every confirmation attempt.

**What the null results found.** The drawdown researcher tested a fund-level ladder, a cap on each
agent's share of book variance and no re-growing agents in drawdown: none beats uniform
deleveraging. (a) The center book's higher raw drawdown is a scale effect: it runs more volatility
than the guardrails, and per unit of volatility its drawdown is lower. The arena now reports this
(the drawdown at the guardrails' volatility). (b) Drawdowns do not predict agents' forward
returns, so cutting agents in drawdown gives up paid-for return. (c) About 44% of the loss in a
world's worst drawdown comes from one agent, often one that won a full slot early on a short
record. That is loop 4's lead. The same researcher showed the risk track could be won by trimming
the deploy fraction, which led to the deleveraging bar, and that the allocator's `n/(n+60)`
shrinkage cancels when every agent starts together; the docs now say so.

Full numbers: [`docs/loops/loop-3.json`](loops/loop-3.json); diffs: [`docs/loops/loop-3/`](loops/loop-3/).

## Loop 4

**Merged: the Tiger overlay hedges its full shrunk beta (tigerhedge) and halves a crowded long
(tigersize).** Both are tiger-track changes; the allocator is untouched (every allocator number is
bit-identical). This is the first loop to improve the Tiger-Cub single-name overlay, the model
behind the Luckin study.

- **Beta hedge.** The short hedge leg now cancels the long's whole trailing beta to the hedge index
  instead of half of it. The beta is shrunk toward 0.5 by its own standard error (a Vasicek prior)
  and clipped to [0, 1.5]. Block A: +3.22 pp [+2.12, +4.31], overlay max drawdown −2.00 pp. Its
  review found that a plain hedge ratio of 1.0 does about as well as the shrinkage, and that part
  of the gain comes from the gross cap (1.5×) binding more often.
- **Crowding gate.** When the name's market-adjusted return over the last 60 days is more than 2
  standard errors above zero (a flow-driven rally the thesis cannot explain), the long runs at half
  size until it is not. Block A: +2.67 pp [+1.17, +4.17], max drawdown −1.58 pp. At a matched
  drawdown it beats plain deleveraging by about 1.4–1.5 pp.

Composed (the two diffs conflict in `strategy.ts`; composed before the sealed run, the hedge sized
from the shrunk beta, the gate on the raw beta it was reviewed with) and confirmed on block B
(seeds 14500–14699): Tiger utility **+3.36 pp [90% +1.79, +4.93]**, better in 63% of worlds; overlay
max drawdown **−2.51 pp [−3.05, −1.98]**; Sharpe +0.016. The overlay's certainty equivalent on that
block is −10.96% vs −28.05% for buy-and-hold (it was −14.32%), with max drawdown 25.8% vs 43.3%.
Still negative: a single volatile name is expensive for a γ = 3 investor.

**Caveat: a hindsight bias in the yardstick.** The crowding gate's gain is concentrated in worlds
where the Tiger panel's primary is the crowded name (+5.5 to +8.3 pp there, about 0 elsewhere),
and the arena picks that primary as the world's most volatile stock over the whole year, crash
included. The gate itself is point-in-time, and the bias affects the baseline too, but it inflates
how often the gate matters. **Fixed and re-measured.** The arena now picks the Tiger primary by variance over the 60 days
before the overlay trades (`TIGER_START`). Re-measured with the corrected arena on both sides,
loop 4's merged change is worth about half its first estimate: block B **+1.56 pp [+0.19, +2.92]**
(better in 59% of worlds), block A +1.30 pp [−0.32, +2.91]; the overlay's max drawdown still falls
by 1.7–1.9 pp on both blocks. The change stays merged; the corrected numbers are the ones that
stand. With the corrected arena, on research seeds 1–200 the overlay's certainty equivalent is
−6.1% vs −18.9% for buy-and-hold (max drawdown 23.9% vs 39.1%).

| candidate | review | sealed block A (vs current code) | outcome |
|---|---|---|---|
| tigerhedge: full shrunk-beta hedge | passed | tiger +3.22 pp [+2.12, +4.31], max DD −2.00 pp | winner on A; **merged** |
| tigersize: crowding gate | passed | tiger +2.67 pp [+1.17, +4.17], max DD −1.58 pp | winner on A; **merged** |
| ramp: credibility-weighted shares (risk track) | passed | utility −0.34 pp [−0.58, −0.11], max DD −0.13 pp | failed: utility cost over 0.1 pp |
| wildcard: crowd-unwind cool-off | passed review | — | **rejected before judging: simulator harvest** |
| operatorlift: ladder cut under a cap | rejected | — | rejected by review |

- **The simulator harvest.** The cool-off's reviewer switched off the arena generator's hard-coded
  3-tick aftershock after a crowd unwinds, and its gain disappeared (−0.07 pp and −0.05 pp on two
  research blocks). The mechanism reacts to a public signal and is point-in-time, but all of its
  edge came from a deterministic feature the researcher had read in `market.ts`. The sealed blocks
  use the same generator, so the judge could not catch it; the new rule rejects it before judging.
- **Ramp** made capital follow evidence (a share is a credibility-weighted mix, `√(n/252)`, of the
  record's verdict and an equal grant), which diversified early and lowered drawdown, but on block A
  it cost 0.34 pp of utility; its researcher had flagged that risk.
- **Operatorlift**'s review found a counterexample: with three or more names per operator, the cap
  and the ladder can still compound to 25%.

Full numbers: [`docs/loops/loop-4.json`](loops/loop-4.json); diffs: [`docs/loops/loop-4/`](loops/loop-4/).

## Loop 5

**Merged: an agent's own ladder cut is never weakened by its operator's cap (a (G) fix).** Loop 3's
operator cap could stop an agent's own drawdown cut from biting (a capped name already below the
cap was not cut when its ladder fired), and loop 4's first fix was rejected because with three or
more names per operator the cap and the ladder could still compound. Now the operator cap is a
ceiling kept separate from each agent's own size, and the agent holds the smaller of the two, for
any number of names per operator and any order of stop-outs, cuts and restores (property tests
over random event sequences with 1–5 names per operator). Structural: block A 0.00 pp; alone on
block B (seeds 15500–15699) −0.0014 pp [−0.0037, +0.0008], max drawdown unchanged. On that block
the center book returns a certainty equivalent of 12.41% vs 5.85% for per-agent guardrails, max
drawdown 7.29% vs 6.92% (6.26% at the guardrails' volatility); the Tiger overlay −6.91% vs −21.61%
for buy-and-hold, max drawdown 24.1% vs 39.7%.

| candidate | review | sealed block A (vs current code) | outcome |
|---|---|---|---|
| operator fix: cap as a separate ceiling (structure) | passed | 0.00 pp, max DD 0.00 pp | winner on A; neutral alone on B; **merged** |
| de-risk the Tiger overlay into dated prints (tiger) | passed | tiger +1.02 pp [+0.17, +1.87], max DD −0.93 pp | winner on A; **failed B** (+0.86 pp [−0.04, +1.76]) |
| alpha scoring: rank agents net of the market (allocator) | passed | +0.23 pp [−0.00, +0.46], max DD −0.11 pp | no confirmed gain on A |
| risk-scaled Tiger stop-loss (tiger) | — | no diff | null result |
| residual (crowd-neutral) scoring (allocator) | — | no diff | null result |

**The driver's fallback, fixed again.** The block-A winners were the print-timing change and the
operator fix. Their combination failed block B (the timing change did), and the fallback, the
best single winner, was the timing change, so the operator fix was never checked on its own. A
structural winner should not fail because it was paired with a performance claim that did, and
a neutrality check cannot be won by chasing noise, so the orchestrator checked it alone on block B
(neutral, above) and the driver now does this itself.

**What the null results found.** The overlay is already vol-targeted, so a fixed-percentage
drawdown ladder on it is close to risk-scaled already, and drawdowns measured in σ predict forward
returns no better than in percent. More broadly: in the arena the Tiger overlay's single name has
no edge (overlay Sharpe about −0.2), so any exposure cut raises its certainty equivalent. Tiger
changes that trim exposure have to beat plain deleveraging (a lower vol target), and the
print-timing change did not do so reliably. Scoring agents on returns net of the crowd changed
nothing measurable.

Full numbers: [`docs/loops/loop-5.json`](loops/loop-5.json); diffs: [`docs/loops/loop-5/`](loops/loop-5/).

## Cumulative out-of-sample check (after loop 5)

The code before loop 1 (`f5b2d80`) against the code after loop 5 (`64b1690`), on **400 sealed
worlds (seeds 19000–19399) that no loop ever used**. Both sides pick the Tiger primary the same
point-in-time way (the pre-loop checkout has the arena's tiger fix applied); the market generator
and the strategies have not changed since `f5b2d80`, so both see identical worlds.

| | before loop 1 | after loop 5 | paired change (90% interval) |
|---|---:|---:|---|
| center book certainty equivalent | 7.32% | **11.89%** | **+4.56 pp [+3.82, +5.30]**, better in 70% of worlds |
| per-agent guardrails, same worlds | 6.39% | 6.39% | — |
| center book Sharpe | 0.81 | 1.20 | |
| center book max drawdown | 6.73% (guardrails 7.26%) | **7.52%** (6.47% at the guardrails' volatility) | |
| Tiger overlay certainty equivalent | −8.24% | **−5.87%** | **+2.37 pp [+1.60, +3.13]**, better in 62% of worlds |
| Tiger overlay max drawdown (buy-and-hold 39.2%) | 25.2% | 23.6% | |

What this says, plainly: the loops made the fund's risk-adjusted outcome clearly better on worlds
nobody tuned on, and they did it by keeping skilled agents that run more volatility. The price is
a raw max drawdown that went from below the per-agent guardrails' to above it; per unit of
volatility it is still lower. The Tiger overlay improved but still loses money for a γ = 3
investor, because in the arena its single name has no edge. Full numbers:
[`docs/loops/cumulative.json`](loops/cumulative.json).


## Loop 6

**Merged: every stop-out goes on the operator's record (G), and the mandate tree is audited
against its own event log (R, C).** Both structural; no utility is claimed. On both sealed blocks
(A: seeds 16000–16199, B: 16500–16699) every paired change is exactly zero: utility, max drawdown,
Sharpe, and the Tiger overlay. On block B the center book returns a certainty equivalent of 13.71%
vs 8.20% for per-agent guardrails, max drawdown 7.32% vs 6.95% (still above the guardrails', 6.58% at their volatility); the
Tiger overlay −7.35% vs −21.89% for buy-and-hold, max drawdown 24.6% vs 41.9%.

- **Incident.** When the book stops an agent out, it now reports one `stop-out` incident to an
  optional sink (a small port in `packages/swarm`; the adapters' `IncidentLedger` implements it).
  Each incident records the agent's operator, tick, drawdown, stop rung and the exact amount
  `close` freed. A stop-out is a loss, not misconduct: it is never sent to AgentHire's dispute
  route, never a slash, and has its own limit (`maxOperatorStopOuts`, default 2), separate from
  the misconduct limit (default 0, unchanged). The same rule screens new AgentHire hires and new
  grants in a fund's tree (`OperatorGrantScreen`). A refused grant creates no node and reserves
  nothing. The arena passes no sink, so it is bit-identical.
- **Replay.** `DelegationTree.replay(events)` rebuilds a tree from its log, and
  `verifyAgainstLog()` lists every way the live tree differs. The book runs this check at its
  start, trade and end audits every tick. A direct write that bypasses the API (for example,
  moving budget between two agents of one pod, which keeps every invariant) is caught at the next
  audit, even when a later resize overwrites it: each RESIZE now records the budget it started
  from. Property tests cover random operation sequences.

| candidate | review | sealed block A (vs current code) | outcome |
|---|---|---|---|
| stop-outs on the operator's record (structure) | passed | 0.00 pp, max DD 0.00 pp | winner on A; confirmed with replay on B (0.00 pp); **merged** |
| replay audit of the mandate tree (structure) | passed | 0.00 pp, max DD 0.00 pp | winner on A; confirmed with incident on B; **merged** |
| wildcard | — | no diff | nothing to judge |

**Limits, from the reviews.** The log is not signed. `recordEvent` is public, so a direct write
paired with a forged matching event passes the check (a test documents this). Replay holds in
memory only: snapshot JSON (`serializeEvent`) does not carry the new `grant` and prior-budget
fields, so a persisted snapshot cannot be replayed. The audit runs three times a tick and makes the
arena about 25% slower.

Full numbers: [`docs/loops/loop-6.json`](loops/loop-6.json); diffs: [`docs/loops/loop-6/`](loops/loop-6/).
