/**
 * TEST-ONLY synthetic panels. These exist so the machinery can be tested
 * without market data; nothing in the research CLI imports this file, and no
 * result reported anywhere comes from it.
 */

import { gaussian, mulberry32 } from "@allowance/swarm";
import type { Panel, PanelEvent } from "./series";

export function syntheticPanel(opts: {
  days: number;
  seed: number;
  beta?: number;
  drift?: number;
  vol?: number;
  hedgeVol?: number;
  rfAnnual?: number;
  /** Override primary returns at given indices (e.g. a crash). */
  shocks?: Record<number, number>;
}): Panel {
  const z = gaussian(mulberry32(opts.seed));
  const beta = opts.beta ?? 1.2;
  const dates: string[] = [];
  const rL = [0];
  const rH = [0];
  const start = Date.UTC(2020, 0, 1);
  for (let t = 0; t < opts.days; t++) dates.push(new Date(start + t * 86_400_000).toISOString().slice(0, 10));
  for (let t = 1; t < opts.days; t++) {
    const h = (opts.hedgeVol ?? 0.015) * z();
    const idio = (opts.vol ?? 0.03) * z();
    rH.push(h);
    rL.push(opts.shocks?.[t] ?? (opts.drift ?? 0) + beta * h + idio);
  }
  const px = (r: number[]) => {
    const p = [100];
    for (let t = 1; t < r.length; t++) p.push(p[t - 1]! * (1 + r[t]!));
    return p;
  };
  return {
    primary: "LK",
    symbols: ["LK", "HG"],
    dates,
    px: { LK: px(rL), HG: px(rH) },
    ret: { LK: rL, HG: rH },
    rf: dates.map(() => (opts.rfAnnual ?? 0) / 252),
  };
}

/** Quarterly prints every 63 trading days starting at `first`. */
export function quarterlyEvents(days: number, first = 40): PanelEvent[] {
  const out: PanelEvent[] = [];
  for (let t = first; t < days; t += 63) out.push({ t, date: `d${t}`, label: "print" });
  return out;
}
