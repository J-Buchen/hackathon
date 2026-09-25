/**
 * The swarm snapshot: the JSON the dashboard's "center book" section reads.
 * Plain numbers (USDC as floats) — this is analytics output, not settlement, so
 * the bigint-string convention of the payment snapshot doesn't apply. The
 * embedded `tree` IS a core `Snapshot` (same schema as demo-snapshot.json) so
 * the final mandate tree renders with the existing tree components.
 */

import { toSnapshot, type Snapshot } from "@allowance/core";
import type { AblationRow, BookSummary, HeadToHead, SeedSweep } from "./evaluate";
import type { CenterBookPolicy } from "./allocator";
import type { BookResult, Decision } from "./book";
import { tickToUnix } from "./book";
import { trackRecords, type TrackRecord } from "./trackrecord";
import {
  BALANCED_STYLE,
  TigerCubStrategy,
  scoreCandidates,
  type Candidate,
  type Catalyst,
  type Question,
  type ScoredCandidate,
  type TrendThesis,
} from "./tigercub";
import type { SwarmSpec } from "./book";

export interface BookView {
  nav: number[];
  crowdExposure: number[];
  summary: BookSummary;
}

export interface SwarmAgentView extends TrackRecord {
  name: string;
  /** Capital run each tick under the center book (USDC). */
  capital: number[];
}

export interface ThesisView {
  asOf: string;
  trend: TrendThesis["trend"];
  /** Balanced-style scorecard for every candidate, best first. */
  scorecard: Array<
    ScoredCandidate & {
      role: Candidate["role"] | null;
      trendExposure: number;
      evidence: Record<Question, string[]>;
      catalysts: Catalyst[];
      keyRisk: string;
    }
  >;
  /** What each Tiger-Cub PM in the book decided to trade. */
  pms: Array<{ agent: string; pod: string; weights: Record<Question, number>; rationale: string[]; long: string | null; short: string | null }>;
  /** Catalyst jumps scheduled in the simulated market. */
  catalysts: Array<{ tick: number; instrument: string; label: string }>;
  /** True when the simulation assumes the thesis has an edge (catalyst jumps with non-zero mean). */
  assumesEdge: boolean;
}

export interface SweepView {
  seeds: number;
  centerWinsDrawdown: number;
  centerWinsSharpe: number;
  naiveMean: BookSummary;
  centerMean: BookSummary;
}

function sweepView(s: SeedSweep): SweepView {
  return {
    seeds: s.seeds.length,
    centerWinsDrawdown: s.centerWinsDrawdown,
    centerWinsSharpe: s.centerWinsSharpe,
    naiveMean: s.naiveMean,
    centerMean: s.centerMean,
  };
}

export interface SwarmSnapshot {
  asOf: number;
  currency: "USDC";
  fund: string;
  aum: number;
  ticks: number;
  crowd: { instrument: string; startTick: number; crashTick: number };
  policy: CenterBookPolicy;
  books: { naive: BookView; center: BookView };
  agents: SwarmAgentView[];
  /** Center-book decisions, excluding routine reallocations (counted instead). */
  decisions: Decision[];
  decisionCounts: Record<string, number>;
  sweep: SweepView;
  /** The same sweep with the thesis given no edge (catalysts = variance only). */
  sweepNoEdge: SweepView | null;
  ablation: AblationRow[];
  thesis: ThesisView | null;
  /** Final center-book mandate tree (nodes only; the audit log is `decisions`). */
  tree: Snapshot;
}

const round = (x: number, dp: number) => Number(x.toFixed(dp));

function view(book: BookResult, summary: BookSummary): BookView {
  return {
    nav: book.nav.map((x) => round(x, 0)),
    crowdExposure: book.crowdExposure.map((x) => round(x, 4)),
    summary,
  };
}

function thesisView(spec: SwarmSpec, h: HeadToHead): ThesisView | null {
  const thesis = spec.thesis;
  if (!thesis) return null;
  const byTicker = new Map(thesis.candidates.map((c) => [c.ticker, c]));
  const pms: ThesisView["pms"] = [];
  for (const a of spec.agents) {
    if (!(a.strategy instanceof TigerCubStrategy)) continue;
    const { idea, pmStyle } = a.strategy;
    pms.push({
      agent: a.label,
      pod: a.pod,
      weights: pmStyle.weights,
      rationale: idea.rationale,
      long: idea.long?.ticker ?? null,
      short: idea.short?.ticker ?? null,
    });
  }
  const events = h.market.config.events ?? [];
  return {
    asOf: thesis.asOf,
    trend: thesis.trend,
    scorecard: scoreCandidates(thesis, BALANCED_STYLE).map((s) => {
      const c = byTicker.get(s.ticker)!;
      return {
        ...s,
        role: c.role ?? null,
        trendExposure: c.trendExposure,
        evidence: { company: c.company_q.evidence, management: c.management_q.evidence, whyNow: c.whyNow_q.evidence },
        catalysts: c.whyNow_q.catalysts,
        keyRisk: c.keyRisk,
      };
    }),
    pms,
    catalysts: events.map((e) => ({ tick: e.tick, instrument: e.instrument, label: e.label })),
    assumesEdge: events.some((e) => e.mean !== 0),
  };
}

export function buildSwarmSnapshot(
  spec: SwarmSpec,
  h: HeadToHead,
  sweep: SeedSweep,
  ablation: AblationRow[],
  sweepNoEdge: SeedSweep | null = null,
): SwarmSnapshot {
  const { center } = h;
  if (center.policy.kind !== "center") throw new Error("buildSwarmSnapshot: center book expected");
  const records = trackRecords(center);
  const decisionCounts: Record<string, number> = {};
  for (const d of center.decisions) decisionCounts[d.kind] = (decisionCounts[d.kind] ?? 0) + 1;
  const root = center.tree.listNodes().find((n) => n.parent === null)!;
  const asOf = tickToUnix(h.market.ticks.length);
  return {
    asOf,
    currency: "USDC",
    fund: root.name,
    aum: center.startNav,
    ticks: h.market.ticks.length,
    crowd: {
      instrument: h.market.config.crowd.instrument,
      startTick: h.market.config.crowd.startTick,
      crashTick: h.market.config.crowd.crashTick,
    },
    policy: center.policy,
    books: { naive: view(h.naive, h.naiveSummary), center: view(center, h.centerSummary) },
    agents: records.map((r, i) => ({
      ...r,
      name: center.agents[i]!.name,
      capital: center.agents[i]!.capital.map((c) => round(c, 0)),
    })),
    decisions: center.decisions.filter((d) => d.kind !== "REALLOCATE"),
    decisionCounts,
    sweep: sweepView(sweep),
    sweepNoEdge: sweepNoEdge ? sweepView(sweepNoEdge) : null,
    ablation,
    thesis: thesisView(spec, h),
    tree: toSnapshot(center.tree, { asOf, events: [] }),
  };
}
