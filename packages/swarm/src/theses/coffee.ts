// TEMPORARY stub — replaced by the sourced research before commit.
import type { TrendThesis } from "../tigercub";
const c = (ticker: string, s: [number, number, number], e = 4) => ({
  ticker, company: ticker, trendExposure: e,
  company_q: { score: s[0], evidence: [] }, management_q: { score: s[1], evidence: [] },
  whyNow_q: { score: s[2], evidence: [], catalysts: [{ event: "earnings", expected: "2026-11" }] }, keyRisk: "",
});
export const COFFEE_THESIS: TrendThesis = {
  asOf: "2026-09-25", trend: { name: "stub", thesis: "", evidence: [] },
  candidates: [c("AAA", [4, 4, 4]), c("BBB", [3, 3, 3]), c("CCC", [2, 2, 3])],
};
