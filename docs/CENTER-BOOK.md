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
  - **stop out (revoke) at a 20% drawdown.**
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
It uses the same agents, the same pre-trade gate, the same leverage and the same
stop-out, with equal static capital and **nothing that looks across agents**.

## Results

See the bottom of this file. They are regenerated by `npm run demo:swarm`.
