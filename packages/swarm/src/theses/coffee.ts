/**
 * Trend thesis: rising global coffee consumption.
 *
 * Research as of 2026-09-25, gathered for the example Tiger-Cub portfolio.
 * Scores are LONG-side answers to the three questions (5 = emphatic yes); for a
 * short, low "why now" is what makes it a short. Every figure below came from
 * search-engine summaries of the linked pages — the primary filings were not
 * opened (see `caveat`). "(derived)" marks a number computed from sourced
 * figures. Illustrative and dated; NOT investment advice.
 */

import type { TrendThesis } from "../tigercub";

export const COFFEE_THESIS: TrendThesis = {
  asOf: "2026-09-25",
  caveat:
    "Figures are from search-engine summaries of the cited pages; primary filings were not opened. " +
    "Verify every number against the source before use.",
  trend: {
    name: "Rising global coffee consumption",
    thesis:
      "Volume grows in Asia and US spend shifts to specialty, cold, and app/drive-thru formats; green-coffee " +
      "deflation from 2025's record highs should restore 2027 margins for operators with traffic momentum. " +
      "Offsets: the ICO shows 2025/26 global consumption down ~0.9% on price elasticity, and Gen Z is " +
      "substituting energy drinks.",
    evidence: [
      {
        claim:
          "USDA forecasts record 2026/27 world consumption of 179.7M bags (production 189.7M); China 6.9M bags, +37% in five years.",
        source: "USDA FAS, June 2026",
        url: "https://apps.fas.usda.gov/psdonline/circulars/coffee.pdf",
      },
      {
        claim:
          "NCA Fall 2026: 66% of US adults had coffee yesterday; a record 48% had specialty; cold/iced at 21% (16% in 2022); 55% of out-of-home orders via drive-thru, a record 40% via app.",
        source: "Daily Coffee News, 2026-09-15",
        url: "https://dailycoffeenews.com/2026/09/15/nca-more-americans-are-drinking-specialty-coffee-and-ordering-by-app/",
      },
      {
        claim:
          "Counter-trend: among 16–24s, energy drinks are now the primary caffeine source for 30.6% (from 20.6%) vs coffee 27.3% (from 40.4%).",
        source: "The AgriBiz on Citi, Aug 2026",
        url: "https://www.theagribiz.com/international/energy-drinks-overtake-coffee-among-young-americans-citi-says/",
      },
      {
        claim:
          "Counter-trend: the ICO estimates 2025/26 world consumption fell ~0.9% to 180.6M bags — the first surplus in five years.",
        source: "ICO Coffee Market Report, Aug 2026",
        url: "https://www.ico.org/documents/cy2025-26/cmr-0826-e.pdf",
      },
      {
        claim:
          "The cost cycle has turned: arabica $2.71/lb on 2026-09-23, −28.2% in 30 days (52-week range $2.44–4.23), on a record Brazil crop.",
        source: "Trading Economics, 2026-09-23",
        url: "https://tradingeconomics.com/commodity/coffee",
      },
    ],
  },
  candidates: [
    {
      ticker: "SBUX",
      company: "Starbucks",
      role: "long",
      trendExposure: 5,
      company_q: {
        score: 4,
        evidence: [
          "Q3 FY26 global comps +7.9%, with transactions +4.2% doing half the work; fourth straight positive quarter.",
          "Non-GAAP operating margin 14.4%, up 430 bps — still below the FY28 target range.",
          "~$1.8B of debt repaid from China proceeds; leverage ~2.9x. Dividend is ~95% of FY26 EPS guidance (derived).",
        ],
      },
      management_q: {
        score: 5,
        evidence: [
          "Brian Niccol (ex-Chipotle turnaround) CEO since 2024-09-09.",
          "FY26 EPS guidance raised twice: $2.15–2.40 → $2.25–2.45 → $2.55–2.65.",
          "Capital allocation: 60% of China sold to Boyu (closed 2026-03-30, $3.1B consideration); $2B cost program.",
        ],
      },
      whyNow_q: {
        score: 4,
        evidence: [
          "FY27 guidance lands as coffee flips from headwind to tailwind (arabica −28% in 30 days).",
          "Street still at Hold, average target ~$110 vs ~$97.",
          "Japan majority-stake sale (~$3B valuation) being explored; ~$1B café 'uplift' program.",
        ],
        catalysts: [
          { event: "Green-coffee deflation starts flowing into FY27 costs", expected: "2026-10" },
          { event: "Q4 FY26 results + FY27 guidance (tentative date)", expected: "2026-10-29" },
          { event: "Japan majority-stake sale process", expected: "2026-12" },
        ],
      },
      keyRisk:
        "~30x forward P/E already prices a lot in; US transactions turning negative while lapping +7.9%; FY27 guide implying stalled margins; the union boycott escalating.",
      sources: [
        { label: "SBUX Q3 FY26 8-K", url: "https://www.sec.gov/Archives/edgar/data/829224/000082922426000129/sbux-06282026xearningsrele.htm" },
        { label: "Quartz, 2026-07-30", url: "https://qz.com/starbucks-earnings-same-store-sales-guidance-raised-073026" },
        { label: "CNBC investor day, 2026-01-29", url: "https://www.cnbc.com/2026/01/29/starbucks-investor-day-updates-brian-niccol-turnaround.html" },
        { label: "CNBC Japan stake, 2026-09-16", url: "https://www.cnbc.com/2026/09/16/starbucks-considers-selling-majority-stake-japan.html" },
      ],
    },
    {
      ticker: "BROS",
      company: "Dutch Bros",
      role: "short",
      trendExposure: 5,
      company_q: {
        score: 4,
        evidence: [
          "Q2'26 revenue +32.5% to $550.9M; company-operated same-shop sales +8.3%.",
          "But systemwide transactions slowed to +1.7% (vs +4.7% in Q3'25).",
          "FY26 capex $350–370M vs adjusted EBITDA $385–390M — little free cash flow (derived).",
        ],
      },
      management_q: {
        score: 4,
        evidence: [
          "Christine Barone CEO since 2024-01-01; FY26 guidance raised.",
          "Walked away from the $105M Salad and Go sites deal (2026-08-31) — discipline.",
          "Founder Travis Boersma holds ~73% of voting power (secondary source).",
        ],
      },
      whyNow_q: {
        score: 2,
        evidence: [
          "Pricing adds <1 pt to H2 ticket; CFO calls coffee 'the biggest headwind'.",
          "~57x P/E into a print that laps +7.4% comps / +6.8% transactions.",
          "7 Brew added 222 units in a year; price targets cut in September.",
        ],
        catalysts: [
          { event: "Q3 2026 results (laps +7.4% comps)", expected: "2026-11-11" },
          { event: "FY2027 outlook", expected: "2027-02" },
        ],
      },
      keyRisk:
        "Already ~47% off its high with a trough relative multiple; coffee deflation could lift 2027 margins; unit growth >16% — short squeeze risk. Run it as a sized pair leg against SBUX, not an outright short.",
      sources: [
        { label: "BROS Q2'26 8-K", url: "https://www.sec.gov/Archives/edgar/data/1866581/000186658126000131/a2026-q2_ex991.htm" },
        { label: "Yahoo Finance on coffee costs", url: "https://finance.yahoo.com/markets/stocks/article/coffee-prices-keep-rising-and-chains-like-dutch-bros-are-swallowing-most-of-the-costs-174707200.html" },
        { label: "QSR Magazine on 7 Brew", url: "https://www.qsrmagazine.com/story/the-race-between-7-brew-and-dutch-bros-is-officially-on/" },
      ],
    },
    {
      ticker: "LKNCY",
      company: "Luckin Coffee",
      role: "watch",
      trendExposure: 5,
      company_q: {
        score: 4,
        evidence: [
          "Q2'26 revenue +28.5% to RMB15.9B; 36,310 stores; 112.7M monthly transacting customers.",
          "Self-operated same-store sales −5.3% against subsidy-inflated comps.",
          "Cash RMB10.9B; ~11x annualized Q2 earnings (derived).",
        ],
      },
      management_q: {
        score: 3,
        evidence: [
          "Jinyi Guo CEO since the 2020 post-fraud reset.",
          "Buyback upsized to $500M (2026-09-01).",
          "Centurium controls 47.8% of the vote.",
        ],
      },
      whyNow_q: {
        score: 3,
        evidence: ["Delivery-subsidy war easing.", "Materials 39% of revenue — relief from coffee deflation."],
        catalysts: [
          { event: "Q3 2026 results (date unverified)", expected: "2026-11" },
          { event: "Mubadala $1B minority stake closing", expected: null },
          { event: "US exchange relisting", expected: null },
        ],
      },
      keyRisk: "OTC listing, US–China audit/delisting risk, and a China price war keeping same-store sales negative.",
      sources: [
        { label: "Luckin Q2'26 results", url: "https://www.globenewswire.com/news-release/2026/08/03/3337369/0/en/luckin-coffee-announces-second-quarter-2026-financial-results.html" },
      ],
    },
    {
      ticker: "KDP",
      company: "Keurig Dr Pepper",
      role: "watch",
      trendExposure: 4,
      company_q: {
        score: 3,
        evidence: [
          "US Coffee Q2 sales −3.2%, operating income −36.1%; K-Cup pod volume under price-elasticity pressure.",
          "US Refreshment Beverages +10%; JDE Peet's 14.8% adjusted operating margin.",
          "~4.1x leverage targeted at YE2026.",
        ],
      },
      management_q: {
        score: 3,
        evidence: [
          "Tim Cofer CEO since 2024-04-26; guidance reaffirmed.",
          "Designated Global Coffee Co CEO left after ~4 months.",
        ],
      },
      whyNow_q: {
        score: 3,
        evidence: ["Management expects US Coffee to 'turn a corner' in H2.", "Separation timing depends on leverage and markets."],
        catalysts: [
          { event: "Q3 2026 results (third-party calendar)", expected: "2026-10-26" },
          { event: "Separation into Beverage Co and Global Coffee Co", expected: "2027-03" },
          { event: "Global Coffee Co CEO named", expected: null },
        ],
      },
      keyRisk: "Spin value unlock vs a levered, CEO-less coffee spin-off.",
      sources: [
        { label: "KDP Q2'26 results", url: "https://investors.keurigdrpepper.com/2026-08-06-Keurig-Dr-Pepper-Reports-Q2-Results-and-Reaffirms-Guidance-for-2026" },
      ],
    },
    {
      ticker: "NESN",
      company: "Nestlé",
      role: "watch",
      trendExposure: 4,
      company_q: {
        score: 3,
        evidence: [
          "H1'26 coffee organic growth +7.5% (4.7% of it price); group organic growth 3.6%.",
          "Net profit −31.4% on restructuring; net debt CHF 56.3B.",
        ],
      },
      management_q: {
        score: 3,
        evidence: ["Philipp Navratil (ex-Nespresso) CEO since 2025-09-01; exiting waters, focusing the portfolio."],
      },
      whyNow_q: {
        score: 2,
        evidence: ["Falling green coffee reverses the price contribution to coffee growth."],
        catalysts: [
          { event: "Nine-month sales", expected: "2026-10-22" },
          { event: "Waters JV proceeds (~CHF 2.8B)", expected: "2027-06" },
        ],
      },
      keyRisk: "Slow-growth conglomerate with a long restructuring; coffee is under 30% of sales (derived).",
      sources: [
        { label: "FoodNavigator H1'26", url: "https://www.foodnavigator.com/Article/2026/07/23/nestle-h1-2026-organic-growth-up-but-net-profit-falls-314/" },
      ],
    },
    {
      ticker: "QSR",
      company: "Restaurant Brands (Tim Hortons)",
      role: "watch",
      trendExposure: 2,
      company_q: { score: 3, evidence: ["Q2'26 comps +3.8%, but Tim Hortons Canada same-store sales only +0.1%."] },
      management_q: { score: 3, evidence: ["On track for ~8% organic operating-income growth in 2026."] },
      whyNow_q: {
        score: 2,
        evidence: ["Coffee exposure diluted by Burger King and international."],
        catalysts: [{ event: "Q3 2026 results", expected: "2026-10-29" }],
      },
      keyRisk: "Mostly a Burger King and international story — a weak way to own the coffee trend.",
      sources: [
        { label: "GuruFocus Q2'26 call", url: "https://www.gurufocus.com/news/9014325/restaurant-brands-international-inc-qsr-q2-2026-earnings-call-highlights-strong-burger-king-performance-drives-beat-but-tim-hortons-and-popeyes-lag" },
      ],
    },
    {
      ticker: "SJM",
      company: "J.M. Smucker (Folgers)",
      role: "watch",
      trendExposure: 3,
      company_q: {
        score: 2,
        evidence: ["Coffee volumes guided down low single digits.", "$961.7M Hostess impairment; leverage ~3x."],
      },
      management_q: { score: 3, evidence: ["Deleveraging on plan."] },
      whyNow_q: {
        score: 4,
        evidence: [
          "FY27 EPS guidance raised to $10.50–11.00 on green-coffee deflation.",
          "Coffee segment profit $300M incl. ~$115M one-off tariff refunds.",
        ],
        catalysts: [{ event: "Q2 FY27 results", expected: "2026-11" }],
      },
      keyRisk: "The commodity-squeeze short has reversed — deflation now lifts guidance. Tariff refunds are one-off.",
      sources: [
        { label: "Pulse2 on Q1 FY27", url: "https://pulse2.com/j-m-smucker-coffee-profit-jumps-124-as-tariff-refunds-boost-quarterly-earnings/" },
      ],
    },
    {
      ticker: "WEST",
      company: "Westrock Coffee",
      role: "watch",
      trendExposure: 3,
      company_q: {
        score: 2,
        evidence: ["Record Q2 adjusted EBITDA $21.3M (+39%), first positive FCF.", "Secured net leverage 3.36x."],
      },
      management_q: { score: 3, evidence: ["2026 adjusted EBITDA guidance $90–100M reaffirmed; missed Q2 estimates."] },
      whyNow_q: {
        score: 3,
        evidence: ["Conway RTD/extracts plant ramping — operating leverage."],
        catalysts: [{ event: "Q3 2026 results (date unverified)", expected: "2026-11" }],
      },
      keyRisk: "Leverage, small cap, execution.",
      sources: [
        { label: "Yahoo Finance Q2 call", url: "https://finance.yahoo.com/markets/stocks/articles/westrock-coffee-co-west-q2-050659686.html" },
      ],
    },
  ],
};
