/**
 * Market data in: CSV parsing, calendar alignment, returns, and earnings events.
 *
 * Accepts the two free formats people actually have:
 *   Yahoo:  Date,Open,High,Low,Close,Adj Close,Volume
 *   Stooq:  Date,Open,High,Low,Close,Volume
 * plus any CSV with a Date column and a Close (or Adj Close) column. Adjusted
 * close is preferred when present so splits/dividends don't show up as returns.
 *
 * Nothing in this package fabricates prices. Tests use explicitly synthetic
 * panels; the research CLI refuses to run without real files.
 */

export interface Bar {
  date: string; // YYYY-MM-DD
  close: number; // adjusted when the source provides it
  volume: number | null;
}

export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataError";
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function splitCsvLine(line: string): string[] {
  // Market-data CSVs don't quote fields in practice; tolerate simple quotes.
  return line.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
}

/** Normalize common date spellings to YYYY-MM-DD (YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY). */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim().slice(0, 10);
  if (ISO.test(s)) return s;
  let m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(raw.trim());
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return null;
}

export function parsePriceCsv(text: string, symbol: string): Bar[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new DataError(`${symbol}: CSV has no data rows`);
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iDate = col("date", "timestamp", "time");
  const iAdj = col("adjclose", "adjustedclose");
  const iClose = col("close", "price", "last");
  const iVol = col("volume", "vol");
  if (iDate < 0) throw new DataError(`${symbol}: no Date column in header "${lines[0]}"`);
  if (iAdj < 0 && iClose < 0) throw new DataError(`${symbol}: no Close / Adj Close column`);
  const iPx = iAdj >= 0 ? iAdj : iClose;

  const byDate = new Map<string, Bar>();
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const date = normalizeDate(cells[iDate] ?? "");
    const px = Number(cells[iPx]);
    if (!date || !Number.isFinite(px) || px <= 0) continue; // Yahoo writes "null" rows on halts
    const vol = iVol >= 0 ? Number(cells[iVol]) : NaN;
    byDate.set(date, { date, close: px, volume: Number.isFinite(vol) ? vol : null });
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 2) throw new DataError(`${symbol}: fewer than two valid rows`);
  return bars;
}

/** Prices for several symbols on one shared trading calendar. */
export interface Panel {
  primary: string;
  symbols: string[];
  dates: string[];
  /** Adjusted closes, aligned to `dates`. */
  px: Record<string, number[]>;
  /** Simple returns; ret[s][0] is 0 by convention (no prior close). */
  ret: Record<string, number[]>;
  /** Daily risk-free rate (simple), aligned to `dates`; zeros when not supplied. */
  rf: number[];
}

export interface AlignReport {
  /** Primary-calendar days dropped because another symbol had no print. */
  dropped: number;
  firstDate: string;
  lastDate: string;
  /** Largest absolute daily return per symbol — a sanity flag for bad ticks. */
  maxAbsReturn: Record<string, { date: string; ret: number }>;
}

/**
 * Align symbols on the PRIMARY's calendar, keeping only days where every
 * symbol printed (intersection). Returns are computed after alignment, so a
 * dropped day folds into the next day's return rather than vanishing.
 */
export function alignPanel(
  series: Record<string, Bar[]>,
  primary: string,
  opts: { from?: string; to?: string; riskFree?: RatePoint[] } = {},
): { panel: Panel; report: AlignReport } {
  const base = series[primary];
  if (!base) throw new DataError(`primary symbol ${primary} not loaded`);
  const symbols = [primary, ...Object.keys(series).filter((s) => s !== primary).sort()];
  const maps = new Map(symbols.map((s) => [s, new Map(series[s]!.map((b) => [b.date, b.close]))]));
  const dates: string[] = [];
  let dropped = 0;
  for (const b of base) {
    if (opts.from && b.date < opts.from) continue;
    if (opts.to && b.date > opts.to) continue;
    if (symbols.every((s) => maps.get(s)!.has(b.date))) dates.push(b.date);
    else dropped++;
  }
  if (dates.length < 30) throw new DataError(`only ${dates.length} aligned days — check symbols and date range`);
  const px: Record<string, number[]> = {};
  const ret: Record<string, number[]> = {};
  const maxAbsReturn: AlignReport["maxAbsReturn"] = {};
  for (const s of symbols) {
    const m = maps.get(s)!;
    px[s] = dates.map((d) => m.get(d)!);
    const r = px[s]!.map((p, i) => (i === 0 ? 0 : p / px[s]![i - 1]! - 1));
    ret[s] = r;
    let worst = { date: dates[0]!, ret: 0 };
    r.forEach((x, i) => {
      if (Math.abs(x) > Math.abs(worst.ret)) worst = { date: dates[i]!, ret: x };
    });
    maxAbsReturn[s] = worst;
  }
  return {
    panel: { primary, symbols, dates, px, ret, rf: alignRiskFree(dates, opts.riskFree ?? []) },
    report: { dropped, firstDate: dates[0]!, lastDate: dates[dates.length - 1]!, maxAbsReturn },
  };
}

/* ------------------------------------------------------------------ */
/* Risk-free rate                                                      */
/* ------------------------------------------------------------------ */

/** An annualized yield observation in PERCENT (e.g. FRED DTB3: 4.85). */
export interface RatePoint {
  date: string;
  pct: number;
}

/** FRED CSV (DATE,SERIES) → rate points; "." marks missing observations. */
export function parseFredCsv(text: string): RatePoint[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const out: RatePoint[] = [];
  for (const line of lines.slice(1)) {
    const [d, v] = splitCsvLine(line);
    const date = normalizeDate(d ?? "");
    const pct = Number(v);
    if (date && Number.isFinite(pct)) out.push({ date, pct });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Daily simple rate on each date: last observation on or before it, / 252. */
export function alignRiskFree(dates: readonly string[], points: readonly RatePoint[]): number[] {
  let j = -1;
  return dates.map((d) => {
    while (j + 1 < points.length && points[j + 1]!.date <= d) j++;
    return j >= 0 ? points[j]!.pct / 100 / 252 : 0;
  });
}

/* ------------------------------------------------------------------ */
/* Earnings / catalyst events                                          */
/* ------------------------------------------------------------------ */

export interface EventRow {
  date: string;
  /** BMO = before market open (reaction that day); AMC = after close (reaction next day). */
  timing: "BMO" | "AMC";
  label: string;
}

/** CSV with columns: date[, timing][, label]. Timing defaults to BMO. */
export function parseEventsCsv(text: string): EventRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const hasHeader = header.includes("date");
  const iDate = hasHeader ? header.indexOf("date") : 0;
  const iTiming = hasHeader ? header.indexOf("timing") : 1;
  const iLabel = hasHeader ? header.indexOf("label") : 2;
  const out: EventRow[] = [];
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const c = splitCsvLine(line);
    const date = normalizeDate(c[iDate] ?? "");
    if (!date) throw new DataError(`events: bad date in "${line}"`);
    const t = (iTiming >= 0 ? c[iTiming] ?? "" : "").toUpperCase();
    out.push({ date, timing: t === "AMC" ? "AMC" : "BMO", label: (iLabel >= 0 ? c[iLabel] : "") || "earnings" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** An event mapped onto the panel: `t` is the index of the price-reaction day. */
export interface PanelEvent {
  t: number;
  date: string;
  label: string;
}

/**
 * Map events to reaction-day indices: BMO → first trading day ≥ date;
 * AMC → first trading day > date. Events outside the calendar are dropped.
 */
export function mapEvents(events: readonly EventRow[], dates: readonly string[]): PanelEvent[] {
  const out: PanelEvent[] = [];
  for (const e of events) {
    const t = dates.findIndex((d) => (e.timing === "AMC" ? d > e.date : d >= e.date));
    if (t > 0) out.push({ t, date: e.date, label: e.label });
  }
  return out;
}
