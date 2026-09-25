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
   second.
3. **Crowding control.** Pods that pile into the same trade get cut, even when
   every one of them is inside its own limits.

`@allowance/swarm` is that center book, built directly on the mandate tree:

| Pod-shop concept | Mandate-tree operation |
|---|---|
| fund → pod → PM | `fund.eth` → `consumer.fund.eth` → `tiger-quality.consumer.fund.eth` |
| capital allocation | the node's **budget**: `tree.resize(node, budget)` |
| allowed instruments | the node's **allowlist**, attenuated fund ⊇ pod ⊇ PM |
| drawdown cut | `resize` to `cutFactor` × capital |
| stop-out | `resize` to 0, then **`revoke`** |
| audit trail | the same ordered event log as payments (`RESIZE`, `REVOKE`) |

`resize` is the one addition to `@allowance/core`. It can grow a node's budget
only out of its parent's *available* budget. It can shrink it only down to what
the node has already committed (its own spend plus what it has delegated). A
revoked subtree can't be resized, and the root can only shrink.

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

- **Score** = shrunk Sharpe ÷ volatility, over a trailing window. Shrinkage is
  `n / (n + 60)`: a 30-day track record is pulled hard toward zero.
- **Correlation-aware.** Each score is divided by the agent's *multiplicity*: the
  sum of its positive return correlations with the other scoring agents. Two
  clones split one allocation.
- **Caps.** No agent gets more than 25% of deployable capital. Capital freed by
  caps and cuts **stays in cash** rather than being pushed onto whoever is left.
- **Drawdown ladder** on each agent's own attributable (per-unit-of-capital)
  track record:
  - cut to 50% capital at a 10% drawdown;
  - restore once it recovers to within 5% of its high-water mark;
  - **stop out (revoke) at a 20% drawdown;**
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

The baseline ("per-agent guardrails") is what agent-trading products ship today.
It uses the same agents, the same pre-trade gate and the same leverage, with
equal static capital, each agent's own fixed 20% stop-loss, and **nothing that
looks across agents**. The center book differs in what it sees across agents
(allocation, crowding) and, since loop 1, in its ladder: it judges each agent's
drawdown against the risk that agent runs, which a per-agent stop-loss cannot.

## Results

The numbers below come from `npm run demo:swarm` at the current code (loop-1
risk-scaled ladder with its 40% ceiling), using the coffee thesis as of
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
| loss in the unwind | −4.9% | **−2.4%** |
| max drawdown | 7.9% | **5.0%** (smaller on **17/20** seeds) |
| peak crowded (SBUX) exposure | 51.5% of NAV | **15.9%** |
| Sharpe | 0.50 | **0.61** (higher on only 10/20 seeds) |
| total return | **+5.5%** | +3.3% |

On day 1 the center book flags "4 agents across 3 pods running one trade in
SBUX: 48.0% of NAV > 10% limit". The three Tiger Cubs are joined by the rogue
agent, whose clipped book is also long SBUX. Per-agent guardrails never raise
it, because no single agent breached anything.

**If the research is wrong** (catalysts carry no edge), the center book still has
the smaller max drawdown on **17/20** seeds: 5.2% vs 8.3% mean. Sharpe goes from
0.17 to 0.49, and total return from +2.8% to +2.7%. Crowding control doesn't
depend on the thesis being right.

**Ablation (mean over the same 20 seeds):**

| variant | max DD | unwind | Sharpe | return |
|---|---:|---:|---:|---:|
| per-agent guardrails | 7.9% | −4.9% | 0.50 | +5.5% |
| center book (all on) | 5.0% | −2.4% | 0.61 | +3.3% |
| − crowding limits | 15.3% | −12.6% | 0.22 | +3.0% |
| − drawdown cut rung | 5.1% | −2.5% | 0.64 | +3.5% |
| − risk-scaled ladder (fixed 10%/20% rungs) | 4.6% | −1.8% | 0.56 | +2.9% |
| crowding limits only | 4.2% | −2.8% | 0.46 | +2.3% |

What this says, plainly:

- **Crowding control is the product.** Every drawdown and unwind improvement
  comes from it.
- **Performance-chasing allocation without crowding control is worse than doing
  nothing.** Sharpe-weighting pays the crowd for its run-up: max drawdown rises
  to 15.3% vs 7.9% for equal weights. This is the case for a book-level risk
  engine rather than a leaderboard.
- **The cost is return.** The center book gives up about 2.2 points of return in
  the edge-on case, because it refuses to let the fund's single best idea become
  half its NAV.
- **The drawdown-cut rung does not earn its keep on this market.** Removing it
  raises Sharpe from 0.61 to 0.64. It stays in the default because it's standard
  pod-shop practice and costs little drawdown, but the data doesn't support it
  here. The stop-out rung (revocation) stays either way.
- **The risk-scaled ladder (loop 1) trades drawdown for Sharpe here.** With
  fixed 10%/20% rungs the center book's mean max drawdown is 4.6% (Sharpe 0.56);
  risk-scaled, 5.0% (Sharpe 0.61). It was adopted because it raised fund utility
  on sealed arena worlds, where it also leaves mean max drawdown above the
  per-agent baseline's; see [`LOOPS.md`](LOOPS.md).
- **The headline seed (7) is less flattering than the average.** On it the center
  book has the lower drawdown and unwind loss, but also the lower Sharpe (0.91 vs
  1.08). The dashboard shows that seed as-is rather than a cherry-picked one.

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
