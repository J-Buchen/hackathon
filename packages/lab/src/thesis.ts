/**
 * The Luckin thesis, from the pitch ("LUCKIN COFFEE (LKNCY) – Buy (high
 * conviction)", dated 2026-08-26), in the same three-question shape as the
 * swarm's Tiger-Cub scorecard.
 *
 * Scores are OUR reading of the pitch's evidence, not the author's: management
 * gets a 3, not the pitch's implied 5, because the 2020 accounting fraud,
 * Centurium's voting control, the related-party Blue Bottle deal and the OTC
 * listing are all still true. The model numbers are the pitch's own (pages
 * 10–12, "Model versus Street"); they are inputs to scenarios, not facts.
 */

import type { TrendThesis } from "@allowance/swarm";

export const LUCKIN_THESIS: TrendThesis = {
  asOf: "2026-08-26",
  caveat:
    "Scores and model figures come from the pitch document (proprietary Baidu Maps scrape, WeChat price pulls, an expert-network call) and have not been independently verified. Not investment advice.",
  trend: {
    name: "China's coffee habit is being built",
    thesis:
      "China drank ~22 cups per capita in 2025 (4 in 2015) vs ~400 in South Korea. The same urban, white-collar, app-and-delivery drivers can take it toward ~90 cups by 2035, and the lowest-cost scaled operator captures most of it.",
    evidence: [
      { claim: "~22 cups/capita in 2025, up from ~4 in 2015; South Korea ~300–400.", source: "Pitch, p.5" },
      { claim: "Mass-market cup price fell from RMB 20–30 to 10–15 while disposable income doubled (2015→2025).", source: "Pitch, p.5" },
      { claim: "Luckin 35,730 China stores (Baidu Maps scrape, 2026-07-21) vs Cotti ~16k (shrinking) and Starbucks China ~8k.", source: "Pitch, p.2" },
    ],
  },
  candidates: [
    {
      ticker: "LKNCY",
      company: "Luckin Coffee",
      role: "long",
      trendExposure: 5,
      company_q: {
        score: 4,
        evidence: [
          "FY2025 revenue +43% to RMB 49.3B; 31,048 stores at year-end after +8,708 net.",
          "~RMB 2.0–2.5 per-cup cost advantage over Cotti; ~18-month store payback; RMB 350–450k capex per store vs 1.5–2.5M for Starbucks.",
          "But: Q1'26 same-store sales −0.1% and operating margin 10.3% in 2025, down from 12.2% in 2023.",
        ],
      },
      management_q: {
        score: 3,
        evidence: [
          "Former governance-committee chair (expert call, Dec 2025): 'a really strong backbone… a very stable management team'.",
          "First $300M repurchase program (April 2026).",
          "Against: 2020 accounting fraud; Centurium holds voting control; Centurium's Blue Bottle purchase is related-party; OTC listing.",
        ],
      },
      whyNow_q: {
        score: 4,
        evidence: [
          "Store count tracking ~41k at year-end vs Street 37k (Baidu scrape).",
          "WeChat pulls: pricing up ~12% over three months as Cotti ends RMB 9.9 pricing and shrinks its network.",
          "Same-store sales are lapping the 2025 delivery-subsidy war, an 'impossible comp'.",
          "Street models gross margin falling from ~61% (2025) to 55% (2028); the pitch sees price-led expansion.",
        ],
        catalysts: [
          { event: "Q3 2026 results — store count and pricing vs Street", expected: "2026-11" },
          { event: "Q4/FY2026 results and 2027 outlook", expected: "2027-03" },
          { event: "Ongoing $300M buyback", expected: null },
          { event: "US main-board relisting (option, not in the base case)", expected: null },
        ],
      },
      keyRisk:
        "Governance and related-party risk under Centurium control; renewed subsidy wars (Cotti, JD, Alibaba, Meituan); coffee-bean inflation; weak China consumer; OTC liquidity; cannibalization in new cities.",
    },
  ],
};

/** The pitch's "Model versus Street" (RMB millions), pages 10–11. */
export const LUCKIN_MODEL = {
  source: "Pitch pp.10–11 (Model versus Street; Store Count Assumptions)",
  years: ["2023A", "2024A", "2025A", "2026E", "2027E", "2028E"],
  revenue: { street: [24903, 34475, 49288, 60069, 66418, 71008], pitch: [24903, 34475, 49288, 65254, 83194, 98620] },
  nonGaapNetProfit: { street: [3174, 3311, 4196, 5124, 6046, 6974], pitch: [2640, 3227, 4641, 9318, 14853, 19172] },
  endingStores: { street: [16248, 22340, 31048, 37048, 40548, 44048], pitch: [16248, 22340, 31048, 40848, 47348, 53848] },
  aspPerCupRmb: { street: [14.1, 13.2, 13.5, 13.5, 13.3, 13.3], pitch: [14.1, 13.2, 13.5, 14.2, 15.0, 15.5] },
} as const;
