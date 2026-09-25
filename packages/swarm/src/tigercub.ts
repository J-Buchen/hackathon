/**
 * The Tiger Cub process, as an agent.
 *
 * Julian Robertson's alumni ("Tiger Cubs") run fundamental long/short books
 * with a recognizable discipline:
 *
 *   1. Start from a TREND (e.g. rising global coffee consumption).
 *   2. Map the companies exposed to it.
 *   3. Own the one that best answers three questions — all three, not two:
 *        - Is this a good company?          (economics, growth, moat, balance sheet)
 *        - Is this a good management team?  (track record, capital allocation, alignment)
 *        - Why now?                          (dated catalysts in the next 6–12 months)
 *   4. Pair it with a short in a name that rides the SAME trend but has no
 *      reason to work now (fails "Why now?"), so the book is paid for picking
 *      the winner within the trend, not for trend or market beta.
 *   5. Size by conviction, and lean in ahead of catalysts.
 *
 * This file is that process as data + pure functions + a `Strategy`. The
 * research itself (evidence, scores, catalyst dates) lives in `theses/`.
 *
 * It is also why the center book matters: Tiger Cubs are the canonical example
 * of crowding. Smart PMs running the same process on the same public facts
 * converge on the same names ("hedge-fund hotels"), so a fund of Tiger-Cub
 * agents is precisely the population whose risk no single agent can see.
 */

import type { Observation, Strategy, Weights } from "./strategies";

/* ------------------------------------------------------------------ */
/* Research data                                                      */
/* ------------------------------------------------------------------ */

export interface Evidence {
  claim: string;
  source?: string;
  url?: string;
}

export interface Catalyst {
  event: string;
  /** Expected date: "YYYY-MM-DD", "YYYY-MM", or null when undated. */
  expected: string | null;
}

export interface QuestionAnswer {
  /** 1 (clear no) … 5 (emphatic yes). */
  score: number;
  evidence: string[];
}

export interface Candidate {
  ticker: string;
  company: string;
  /** How directly the business rides the trend, 1–5. */
  trendExposure: number;
  /** The researcher's own call; the scorecard below decides what trades. */
  role?: "long" | "short" | "watch";
  company_q: QuestionAnswer;
  management_q: QuestionAnswer;
  whyNow_q: QuestionAnswer & { catalysts: Catalyst[] };
  keyRisk: string;
  /** Primary / secondary sources behind the answers. */
  sources?: { label: string; url: string }[];
}

export interface TrendThesis {
  /** Research as-of date, "YYYY-MM-DD". */
  asOf: string;
  /** How the research was gathered and what was not verified. Shown wherever the thesis is. */
  caveat?: string;
  trend: { name: string; thesis: string; evidence: Evidence[] };
  candidates: Candidate[];
}

/* ------------------------------------------------------------------ */
/* Scoring                                                            */
/* ------------------------------------------------------------------ */

export type Question = "company" | "management" | "whyNow";

export const QUESTION_TEXT: Record<Question, string> = {
  company: "Is this a good company?",
  management: "Is this a good management team?",
  whyNow: "Why now?",
};

/** How a PM weighs the three questions, and how strict it is. */
export interface PmStyle {
  weights: Record<Question, number>;
  /** Minimum score on EVERY question for a long ("yes" to all three). */
  passMark: number;
  /** A short must fail "Why now?" AND ride the trend at least this much. */
  shortMinExposure: number;
}

export const BALANCED_STYLE: PmStyle = {
  weights: { company: 1 / 3, management: 1 / 3, whyNow: 1 / 3 },
  passMark: 3,
  shortMinExposure: 3,
};

export interface ScoredCandidate {
  ticker: string;
  company: string;
  scores: Record<Question, number>;
  /** Weighted score, 1–5. */
  total: number;
  /** Questions scored below the pass mark. */
  failed: Question[];
  /** 0–1: how far above the bar the weakest answer is, scaled by trend exposure. */
  conviction: number;
}

function answers(c: Candidate): Record<Question, number> {
  return { company: c.company_q.score, management: c.management_q.score, whyNow: c.whyNow_q.score };
}

export function scoreCandidates(thesis: TrendThesis, style: PmStyle): ScoredCandidate[] {
  const wsum = style.weights.company + style.weights.management + style.weights.whyNow;
  return thesis.candidates
    .map((c) => {
      const scores = answers(c);
      const total =
        (scores.company * style.weights.company +
          scores.management * style.weights.management +
          scores.whyNow * style.weights.whyNow) /
        wsum;
      const failed = (Object.keys(scores) as Question[]).filter((q) => scores[q] < style.passMark);
      const weakest = Math.min(scores.company, scores.management, scores.whyNow);
      // A 5/5/5 on a pure-play is full conviction; scraping the bar is not.
      const conviction =
        failed.length > 0
          ? 0
          : Math.min(1, ((weakest - style.passMark + 1) / (6 - style.passMark)) * (0.5 + c.trendExposure / 10));
      return { ticker: c.ticker, company: c.company, scores, total, failed, conviction };
    })
    .sort((a, b) => b.total - a.total || a.ticker.localeCompare(b.ticker));
}

export interface TradeIdea {
  trend: string;
  long: ScoredCandidate | null;
  short: ScoredCandidate | null;
  /** Catalysts behind the long, from the research. */
  catalysts: Catalyst[];
  rationale: string[];
}

/**
 * The Tiger Cub decision: the best-scoring candidate that says yes to all three
 * questions is the long; the weakest trend-exposed name that fails at least one
 * is the short.
 */
export function pickTrade(thesis: TrendThesis, style: PmStyle = BALANCED_STYLE): TradeIdea {
  const ranked = scoreCandidates(thesis, style);
  const long = ranked.find((c) => c.failed.length === 0) ?? null;
  const exposure = new Map(thesis.candidates.map((c) => [c.ticker, c.trendExposure]));
  // A Tiger pair short is not "the worst company". It is the name that rides
  // the SAME trend (so the pair cancels trend and commodity beta) but has no
  // reason to work now — it fails "Why now?". Most trend-exposed first, then
  // weakest why-now, then weakest overall.
  const short =
    ranked
      .filter(
        (c) =>
          c.failed.includes("whyNow") &&
          c.ticker !== long?.ticker &&
          (exposure.get(c.ticker) ?? 0) >= style.shortMinExposure,
      )
      .sort(
        (a, b) =>
          (exposure.get(b.ticker) ?? 0) - (exposure.get(a.ticker) ?? 0) ||
          a.scores.whyNow - b.scores.whyNow ||
          a.total - b.total,
      )[0] ?? null;
  const catalysts = long ? thesis.candidates.find((c) => c.ticker === long.ticker)!.whyNow_q.catalysts : [];

  const fmt = (c: ScoredCandidate) =>
    `${c.ticker} (company ${c.scores.company}, management ${c.scores.management}, why-now ${c.scores.whyNow})`;
  const rationale: string[] = [];
  if (long) rationale.push(`LONG ${fmt(long)}: yes to all three questions, weighted ${long.total.toFixed(2)}/5.`);
  else rationale.push("No candidate answers all three questions — no long. Cash is a position.");
  if (short) {
    const why = short.failed.map((q) => `"${QUESTION_TEXT[q]}"`).join(" and ");
    const exp = exposure.get(short.ticker) ?? 0;
    rationale.push(`SHORT ${fmt(short)}: rides the same trend (exposure ${exp}/5) but fails ${why} — the pair hedge.`);
  }
  return { trend: thesis.trend.name, long, short, catalysts, rationale };
}

/* ------------------------------------------------------------------ */
/* Catalyst calendar                                                  */
/* ------------------------------------------------------------------ */

/** Parse "YYYY-MM-DD" or "YYYY-MM" (mid-month) to a UTC Date; null if undated/invalid. */
export function parseExpected(expected: string | null): Date | null {
  if (!expected) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(expected.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 15));
}

/** Map a calendar date to a simulation tick (trading days ≈ 252 per 365 calendar days). */
export function dateToTick(date: Date, simStart: Date): number {
  const days = (date.getTime() - simStart.getTime()) / 86_400_000;
  return Math.round((days * 252) / 365);
}

/** Catalyst ticks within [0, ticks), sorted. Undated or past catalysts are dropped. */
export function catalystTicks(catalysts: readonly Catalyst[], simStart: Date, ticks: number): number[] {
  const out: number[] = [];
  for (const c of catalysts) {
    const d = parseExpected(c.expected);
    if (!d) continue;
    const t = dateToTick(d, simStart);
    if (t >= 0 && t < ticks) out.push(t);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* The agent                                                          */
/* ------------------------------------------------------------------ */

export interface TigerCubOptions {
  /** Share of full size held between catalysts (the "core" position). */
  coreSize: number;
  /** Ticks ahead of a catalyst at which the position is built to full size. */
  leadTicks: number;
  /** Short notional as a fraction of long notional. */
  hedgeRatio: number;
}

export const DEFAULT_TIGER_OPTIONS: TigerCubOptions = { coreSize: 0.6, leadTicks: 15, hedgeRatio: 0.5 };

export class TigerCubStrategy implements Strategy {
  readonly style = "tiger-cub";
  readonly idea: TradeIdea;
  private readonly calendar: number[];

  constructor(
    thesis: TrendThesis,
    readonly pmStyle: PmStyle,
    simStart: Date,
    horizon: number,
    private readonly opts: TigerCubOptions = DEFAULT_TIGER_OPTIONS,
  ) {
    this.idea = pickTrade(thesis, pmStyle);
    this.calendar = catalystTicks(this.idea.catalysts, simStart, horizon);
  }

  /** Full size inside the run-up to a catalyst (and on the day), core size otherwise. */
  private sizing(t: number): number {
    const upcoming = this.calendar.some((c) => c >= t && c - t <= this.opts.leadTicks);
    return upcoming ? 1 : this.opts.coreSize;
  }

  decide(obs: Observation): Weights {
    const { long, short } = this.idea;
    // The mandate decides what is tradeable; an off-mandate pick means no trade.
    if (!long || !obs.universe.includes(long.ticker)) return {};
    const size = long.conviction * this.sizing(obs.t);
    const hedge = short && obs.universe.includes(short.ticker) ? this.opts.hedgeRatio : 0;
    // Keep gross ≤ 1 so the gate never has to clip a well-behaved PM.
    const scale = 1 / Math.max(1, size * (1 + hedge));
    const w: Weights = { [long.ticker]: size * scale };
    if (hedge > 0 && short) w[short.ticker] = -size * hedge * scale;
    return w;
  }
}
