# The center book — a Tiger Cub fund whose PMs are agents

> `packages/swarm` · `npm run demo:swarm` · dashboard section **Center book**

Allowance began as one primitive: **authority that attenuates down a tree** and
can be revoked. That primitive is table stakes for a single agent. Robinhood's
agent accounts, "authority contracts" and Zodiac Roles all put limits on one
agent at a time.

The differentiated part is what happens once there are **many** agents trading
real capital. A multi-manager ("pod shop") fund doesn't win because any one PM
has limits. It wins through the **center book**:

1. **Allocating capital by risk-adjusted, attributable returns.** Allocation is
   correlation-aware, so clones don't get paid twice.
2. **A drawdown ladder.** A PM is cut at one drawdown and stopped out at a
   second. The stop-out closes its whole mandate subtree in one operation.
3. **Crowding control.** Pods that pile into the same trade get cut, even when
   every one of them is inside its own limits.

`@allowance/swarm` is that center book, built directly on the mandate tree:

| Pod-shop concept | Mandate-tree operation |
|---|---|
| fund → pod → PM | `fund.eth` → `consumer.fund.eth` → `tiger-quality.consumer.fund.eth` |
| capital allocation | the node's **budget**: `tree.resize(node, budget)` |
| allowed instruments | the node's **allowlist**, attenuated fund ⊇ pod ⊇ PM |
| a PM's own sub-agents (execution, data) | **sub-mandates**: children of the PM node, each reserved as a ppm `share` of its budget when granted and resized with it |
| what a PM may trade | its node's **available** authority × leverage: budget − its own spend − what it handed to sub-mandates (`sizeOrder` in the gate) |
| drawdown cut | `resize` to `cutFactor` × capital |
| stop-out | **`close`**: the PM and every sub-mandate shrink to what they spent and are revoked, in one operation; the unspent authority is back in the pod |
| audit trail | the same ordered event log as payments (`RESIZE`, `REVOKE`) |

`resize` can grow a node's budget only out of its parent's *available* budget.
It can shrink it only down to what the node has already committed (its own
spend plus what it has delegated). A revoked subtree can't be resized, and the
root can only shrink. The book clips a grow to what the parent still has, so
once sub-mandates have spent the fund's undeployed buffer the allocator's
targets become ceilings instead of refused moves. `close` is why a stop-out
can't leave authority behind: the old stop-out was "resize to 0, then revoke",
and a PM that had delegated sub-budgets couldn't be resized to 0 at all.

**The reservation is the binding limit.** Every order is sized by the gate from
the PM's *available* authority in the tree at the moment of the trade (after the
tick's reallocation and crowding cuts), never from a capital number the book
keeps. A slice reserved for an execution or data desk is not also trading
capital, and a closed PM (available 0) trades nothing. Before this, a PM that
had handed 30% of its budget to a desk still traded 100% of it. On the arena's
rosters (no desks, no PM spend) available authority equals the budget, so the
arena's numbers are unchanged to the bit.

**Invariants, checked at three points of every tick.** The book audits its tree
(`bookViolations`) before each tick trades and again at its end, and in
between it audits every order it is about to mark (`tradeViolations`): no
PM's gross notional exceeds its available authority × leverage, a closed PM
trades nothing, and nothing off its allowlist is held. It throws
`BookInvariantError` on any failure. The tree invariants:

- no node has spent plus delegated more than it holds (children ≤ parent,
  `available` ≥ 0), and no budget is negative;
- merchants, purposes and expiry attenuate;
- the root still holds exactly the AUM;
- every revoked mandate is *closed*: nothing under it holds unspent authority;
- every stopped PM's mandate is dead, and no PM that is not stopped sits in a
  dead subtree.

`packages/swarm/src/close.test.ts` checks these from the outside at every tick
of books whose PMs hold spending sub-mandates. It also shows that each stop-out
is one `close` that frees exactly budget − spent into the pod, and that a closed
subtree can never pay, delegate or grow again. `packages/swarm/src/reserve.test.ts`
and `packages/lab/src/arena-reserve.test.ts` check every order from the outside at
the trade: sized on no more than available authority, gross notional within
available × leverage, nothing for a closed PM, and the marked PnL exactly the
audited order's. They run books in which the PM's budget overstates what it may
trade (desks, its own spend, an outside grant), and an order inflated for one PM
while the tree is untouched stops the book at the trade, naming that PM.

---

## The example portfolio runs like a Tiger Cub

Julian Robertson's alumni run fundamental long/short books with one recognizable
discipline, implemented in `tigercub.ts`:

1. **Start from a trend.** The example uses rising global coffee consumption, with
   dated, sourced research in `packages/swarm/src/theses/coffee.ts`.
2. **Map the companies exposed to it.**
3. **Answer three questions for each company, and own one only if all three are
   "yes":**
   - *Is this a good company?* Economics, growth, moat, balance sheet.
   - *Is this a good management team?* Track record, capital allocation,
     alignment.
   - *Why now?* Dated catalysts in the next 6–12 months.
4. **Pair the long with a short** in the trend's structural loser: exposed to the
   same trend, but failing at least one question.
5. **Size by conviction, and lean in ahead of catalysts.** Catalyst dates from
   the research map onto the simulated timeline.

The example fund has three Tiger-Cub PMs in three different pods, each weighting
the three questions differently (quality-heavy, management-heavy,
catalyst-heavy). **They all land on the same stock.** That isn't a bug in the
example. It's the best-documented failure mode of real Tiger Cubs: the
"hedge-fund hotel". Each PM is inside its own mandate, but together they are
one crowded trade that no per-agent guardrail can see.

Around them sit agents that give the allocator something to allocate between:
- systematic PMs (trend, mean-reversion);
- a macro sleeve (carry, trend);
- a zero-skill `noise` agent;
- a `rogue` agent that asks for an off-mandate instrument at 3× gross every day.

## What is simulated, and what isn't

- **Prices are synthetic** (`market.ts`, seeded and deterministic). Real tickers
  only label the thesis. The market has factor structure, trending and
  mean-reverting names, and carry. It also has a **crowded trade**: from day 120
  the rest of the market piles into the Tiger Cubs' long, and on day 185 the
  crowd unwinds with a gap down plus a market-wide liquidation hit.
- **The thesis edge is an explicit assumption** (`assumeEdge`, on by default).
  Catalyst days on the long jump +2% on average and on the short −1.5%, each
  with ±4% noise. That lets you watch the book size a correct-but-crowded idea.
  Every result is also reported with the edge **off**. **Nothing here tests
  whether the research is right.**
- **The research is real but dated.** Every claim carries its source and as-of
  date. It is illustrative, not investment advice.

## The allocator (`allocator.ts`, pure functions)

- **Score** = shrunk Sharpe over the agent's last year of record
  (`recordWindow`, 252 days). Shrinkage is `n / (n + 60)`, which pulls a
  short record toward zero relative to a long one. (In the examples and the
  arena every agent starts on day one, so all records have the same length and
  the factor cancels when scores become shares; it changes no allocation there.
  It matters only for agents added mid-run.) A Sharpe estimate's standard error is
  about √(252 / n) — ±1.7 on a 90-day window — so a short window re-ranks
  agents on luck; the whole year is the evidence. Scores are not divided by
  volatility again (a Kelly weight): every agent's Sharpe has the same
  sampling error, so ranking by it ranks by evidence, and with capital capped
  per agent and in total the binding constraint is capital, not risk budget.
- **Correlation-aware.** Each score is divided by the agent's *multiplicity*: the
  sum of its positive return correlations with the other scoring agents. Two
  clones split one allocation.
- **Caps.** No agent gets more than 25% of deployable capital. Capital freed by
  caps and cuts **stays in cash** rather than being pushed onto whoever is left.
- **Drawdown ladder** on each agent's own attributable (per-unit-of-capital)
  track record:
  - cut to 50% capital at a 10% drawdown;
  - restore once it recovers to within 5% of its high-water mark;
  - **stop out at a 20% drawdown: the PM's mandate subtree is closed;**
  - **risk-scaled** (loop 1): the rungs widen for an agent that runs more
    volatility, so the stop sits at 1.5σ of the agent's annualized vol (σ
    measured over the last 90 ticks up to its last high-water mark, so the losses
    being judged cannot loosen their own stop), never below the fixed 20% and
    **never above a 40% ceiling**, so every agent can still be stopped out. The
    cut and restore rungs move in proportion (at most 20% and 10%).
- **Crowding**, checked every day on the books agents *propose*, before they
  trade:
  - **Clones:** union-find over agents whose position vectors have cosine
    similarity ≥ 0.8. A cluster's combined exposure to one instrument is capped
    at 10% of NAV. This check names names ("3 agents across 3 pods running one
    trade in …").
  - **Book:** the whole book's net exposure to any one instrument is capped at
    20% of NAV, however many different-looking strategies it is spread across.
  - A crowding cut stays in force until the agent's book stops resembling the
    crowded book. The cap is not lifted just because its twin got stopped out.
- **Counterparties** (`AgentSpec.operator`, a World ID-verified human in
  production). One operator is one counterparty however many names it runs, so
  a stop-out of one of its names is a credit event for all of them. Its other
  live names are capped in the same tick, as a group, in one tree plan, at 50%
  of their **full size** (what the allocator gives them uncut). The cap is a
  ceiling on capital, not a multiplier on what a name holds. A name already at
  or below it is not cut again: for example, one its own ladder cut, or cut and
  restored but not yet resized, or one an earlier credit event capped. A
  reallocation sizes a name that is both ladder-cut and capped at 50%, never
  25%. The cap lifts at the name's first recovery on its own record: a new
  high, or its own ladder lifting a cut. It never revokes anyone, and it never
  moves a ladder. Every stop-out lands on exactly the tick of the agent's own
  record replayed alone (tested on a scripted book and on every shared-operator
  arena world on seeds 1–40).

The baseline ("per-agent guardrails") is what agent-trading products ship today.
It uses the same agents, the same pre-trade gate and the same leverage, with
equal static capital, each agent's own fixed 20% stop-loss, and **nothing that
looks across agents**. The center book differs in what it sees across agents
(allocation, crowding) and, since loop 1, in its ladder: it judges each agent's
drawdown against the risk that agent runs, which a per-agent stop-loss cannot.

## Results

The numbers below come from `npm run demo:swarm` at the current code (after
loop 2: one-year Sharpe scores, risk-scaled ladder with its 40% ceiling,
stop-outs by `close`), using the coffee thesis as of
2026-09-25, 260 simulated trading days and 20 market seeds. The two books share
agents, gate, leverage and initial capital; they differ in the center book's
cross-agent allocation and crowding limits and its risk-scaled ladder.

**The thesis.** All three Tiger-Cub PMs pick the same trade: long **SBUX**,
short **BROS**.
- **SBUX** scores 4/5/4 on company, management and why-now, and is the only
  scaled name with a "yes" to all three.
- **BROS** scores 4/4/2. It rides the same drive-thru trend (exposure 5/5) but
  fails "Why now?".
- **SJM** is not a short even though it's a weaker company: green-coffee
  deflation is a catalyst in its *favor*.
- **LKNCY** passes all three but ranks second.

**Same market, two books (mean over 20 seeds):**

| | per-agent guardrails | center book |
|---|---:|---:|
| loss in the unwind | −4.9% | **−2.5%** |
| max drawdown | 7.9% | **5.6%** (smaller on **17/20** seeds) |
| peak crowded (SBUX) exposure | 51.5% of NAV | **15.3%** |
| Sharpe | 0.50 | 0.50 (higher on only 10/20 seeds) |
| total return | **+5.5%** | +2.8% |

On day 1 the center book flags "4 agents across 3 pods running one trade in
SBUX: 48.0% of NAV > 10% limit". The three Tiger Cubs are joined by the rogue
agent, whose clipped book is also long SBUX. Per-agent guardrails never raise
it, because no single agent breached anything.

**If the research is wrong** (catalysts carry no edge), the center book still has
the smaller max drawdown on **16/20** seeds: 5.6% vs 8.3% mean. Sharpe goes from
0.17 to 0.35, and total return from +2.8% to +1.9%. Crowding control doesn't
depend on the thesis being right.

**Ablation (mean over the same 20 seeds):**

| variant | max DD | unwind | Sharpe | return |
|---|---:|---:|---:|---:|
| per-agent guardrails | 7.9% | −4.9% | 0.50 | +5.5% |
| center book (all on) | 5.6% | −2.5% | 0.50 | +2.8% |
| − crowding limits | 15.4% | −12.1% | 0.32 | +5.0% |
| − drawdown cut rung | 5.6% | −2.6% | 0.54 | +3.1% |
| − risk-scaled ladder (fixed 10%/20% rungs) | 5.1% | −1.9% | 0.40 | +2.2% |
| crowding limits only | 4.2% | −2.8% | 0.46 | +2.3% |

What this says, plainly:

- **Crowding control is the product.** Every drawdown and unwind improvement
  comes from it.
- **Performance-chasing allocation without crowding control is worse than doing
  nothing.** Sharpe-weighting pays the crowd for its run-up: max drawdown rises
  to 15.4% vs 7.9% for equal weights. This is the case for a book-level risk
  engine rather than a leaderboard.
- **The cost is return.** The center book gives up about 2.7 points of return in
  the edge-on case, because it refuses to let the fund's single best idea become
  half its NAV.
- **The drawdown-cut rung does not earn its keep on this market.** Removing it
  raises Sharpe from 0.50 to 0.54. It stays in the default because it's standard
  pod-shop practice and costs little drawdown, but the data doesn't support it
  here. The stop-out rung (now a `close`) stays either way. Since loop 1 the
  rungs are risk-scaled. The cut still fires (about 9 times per arena world on
  research seeds 801–900, against 18 under the fixed ladder), but dropping it
  moves the arena's CRRA (γ = 3) certainty-equivalent return by only +0.05
  points on seeds 801–1000 (paired 90% CI −0.06..+0.16) and +0.12 on 5600–5749
  (−0.03..+0.27). That is not enough to change the default. It is optional:
  leave `ddCut` unset for a stop-only ladder.
- **The risk-scaled ladder (loop 1) trades drawdown for Sharpe here.** With
  fixed 10%/20% rungs the center book's mean max drawdown is 5.1% (Sharpe 0.40);
  risk-scaled, 5.6% (Sharpe 0.50). It was adopted because it raised fund utility
  on sealed arena worlds, where the center book's mean max drawdown is still
  above the per-agent baseline's; see [`LOOPS.md`](LOOPS.md).
- **Loop 2's one-year scores do not help this example.** On sealed arena worlds
  they raised utility and lowered drawdown; on these 20 coffee markets the
  center book's mean Sharpe fell from 0.61 to 0.50 and its max drawdown rose
  from 5.0% to 5.6%. The markets are one scenario, a crowded trade that unwinds;
  the arena's 200-world blocks are the yardstick.
- **The headline seed (7)** is shown as-is rather than a cherry-picked one. On it
  the center book has the lower drawdown (5.5% vs 6.6%) and unwind loss, and the
  higher Sharpe (1.22 vs 1.08), but the lower return (+7.4% vs +9.3%).

## Limits

- **Synthetic prices.** The crowded-trade scenario is built into the market, so
  this shows the mechanism, not a forecast.
- **The research is second-hand.** It was gathered through search-engine
  summaries; the primary filings were not opened. It is marked as such in the
  data, the demo and the dashboard.
- **Agents are deterministic reference strategies.** An LLM-backed agent
  implements the same async `Strategy.decide` interface, and the swarm already
  awaits every agent concurrently each tick.
- **The market is exogenous.** The book is a price-taker, and its own crowding
  doesn't move prices.
