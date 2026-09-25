/**
 * Mirror of @allowance/swarm's `SwarmSnapshot` (packages/swarm/src/snapshot.ts)
 * — the JSON written by `npm run demo:swarm` to public/swarm-snapshot.json.
 * Kept as a local copy (like types.ts for the payment snapshot) so the web app
 * has no build-time dependency on the workspace packages.
 */

import type { Snapshot } from "../types";

export type Question = "company" | "management" | "whyNow";

export interface BookSummary {
  totalReturn: number;
  sharpe: number;
  maxDrawdown: number;
  crashWindowReturn: number;
  peakCrowdExposure: number;
  stopOuts: number;
}

export interface BookView {
  nav: number[];
  crowdExposure: number[];
  summary: BookSummary;
}

export interface SwarmAgentView {
  agent: string;
  name: string;
  pod: string;
  style: string;
  status: "active" | "cut" | "stopped";
  liveTicks: number;
  sharpe: number;
  annualVol: number;
  maxDrawdown: number;
  corrToBook: number;
  closestTwin: { agent: string; corr: number } | null;
  pnl: number;
  avgCapital: number;
  gateViolations: number;
  capital: number[];
}

export interface Decision {
  t: number;
  kind:
    | "ALLOCATE"
    | "REALLOCATE"
    | "CUT"
    | "RESTORE"
    | "STOP_OUT"
    | "CROWDING_CUT"
    | "OPERATOR_CUT"
    | "OPERATOR_RESTORE"
    | "GATE_CLIP";
  node: string;
  detail: string;
}

export interface AblationRow {
  variant: string;
  description: string;
  meanMaxDrawdown: number;
  meanSharpe: number;
  meanCrashWindowReturn: number;
  meanTotalReturn: number;
}

export interface Catalyst {
  event: string;
  expected: string | null;
}

export interface ScorecardRow {
  ticker: string;
  company: string;
  scores: Record<Question, number>;
  total: number;
  failed: Question[];
  conviction: number;
  role: "long" | "short" | "watch" | null;
  trendExposure: number;
  evidence: Record<Question, string[]>;
  catalysts: Catalyst[];
  keyRisk: string;
  sources: Array<{ label: string; url: string }>;
}

export interface ThesisView {
  asOf: string;
  caveat: string | null;
  trend: {
    name: string;
    thesis: string;
    evidence: Array<{ claim: string; source?: string; url?: string }>;
  };
  scorecard: ScorecardRow[];
  pms: Array<{
    agent: string;
    pod: string;
    weights: Record<Question, number>;
    rationale: string[];
    long: string | null;
    short: string | null;
  }>;
  catalysts: Array<{ tick: number; instrument: string; label: string }>;
  assumesEdge: boolean;
}

export interface SweepView {
  seeds: number;
  centerWinsDrawdown: number;
  centerWinsSharpe: number;
  naiveMean: BookSummary;
  centerMean: BookSummary;
}

export interface SwarmSnapshot {
  asOf: number;
  currency: "USDC";
  fund: string;
  aum: number;
  ticks: number;
  crowd: { instrument: string; startTick: number; crashTick: number };
  policy: Record<string, number | string>;
  books: { naive: BookView; center: BookView };
  agents: SwarmAgentView[];
  decisions: Decision[];
  decisionCounts: Record<string, number>;
  sweep: SweepView;
  sweepNoEdge: SweepView | null;
  ablation: AblationRow[];
  thesis: ThesisView | null;
  tree: Snapshot;
}

/**
 * Boundary check for the untrusted JSON: verifies the fields the view
 * dereferences so a stale or partial file fails with a clear message instead of
 * a render-time crash.
 */
export function parseSwarmSnapshot(raw: unknown): SwarmSnapshot {
  const fail = (path: string) => {
    throw new Error(`swarm-snapshot.json: missing or invalid ${path}`);
  };
  if (typeof raw !== "object" || raw === null) fail("root");
  const s = raw as Partial<SwarmSnapshot>;
  if (typeof s.ticks !== "number") fail("ticks");
  if (typeof s.aum !== "number") fail("aum");
  if (!s.crowd || typeof s.crowd.crashTick !== "number") fail("crowd");
  for (const k of ["naive", "center"] as const) {
    const b = s.books?.[k];
    if (!b || !Array.isArray(b.nav) || !Array.isArray(b.crowdExposure) || !b.summary) fail(`books.${k}`);
  }
  if (!Array.isArray(s.agents)) fail("agents");
  if (!Array.isArray(s.decisions)) fail("decisions");
  if (!Array.isArray(s.ablation)) fail("ablation");
  if (!s.sweep || !s.sweep.centerMean || !s.sweep.naiveMean) fail("sweep");
  return s as SwarmSnapshot;
}
