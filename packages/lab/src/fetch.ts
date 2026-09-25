/**
 * Data acquisition with provenance. Nothing downloaded here is trusted on its
 * own say-so:
 *
 *  - Prices come from Yahoo's chart API (adjusted closes) and are checked day
 *    by day against an independent second source (Stooq). The agreement rate
 *    and every disagreeing day are written to provenance.json.
 *  - Earnings dates come from Luckin's own SEC filings: the 6-Ks whose
 *    exhibit headline says "… Financial Results". Timing (before/after the
 *    US open) comes from the EDGAR acceptance time.
 *  - The risk-free rate is the 3-month T-bill (FRED DTB3).
 *
 * Every file gets its source URL, fetch time and SHA-256 in provenance.json.
 * Downloads go through `curl` so the environment's proxy and CA bundle apply.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parsePriceCsv, type Bar } from "./series";

const run = promisify(execFile);

export const LUCKIN_CIK = "1767582";

export interface Fetched {
  url: string;
  status: number;
  body: string;
}

export async function fetchText(url: string, headers: Record<string, string> = {}): Promise<Fetched> {
  const args = ["-sS", "-L", "--max-time", "60", "-w", "\n%{http_code}"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  args.push(url);
  try {
    const { stdout } = await run("curl", args, { maxBuffer: 64 * 1024 * 1024 });
    const cut = stdout.lastIndexOf("\n");
    return { url, status: Number(stdout.slice(cut + 1)), body: stdout.slice(0, cut) };
  } catch (e) {
    return { url, status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Prices                                                             */
/* ------------------------------------------------------------------ */

function nyDate(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(epochSeconds * 1000),
  );
}

/** Yahoo chart API → CSV text (Date,Close,Adj Close,Volume). */
export async function fetchYahoo(symbol: string, from: string, to: string): Promise<{ csv: string; url: string }> {
  const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
  const r = await fetchText(url, { "User-Agent": "Mozilla/5.0 (allowance-lab)" });
  if (r.status !== 200) throw new Error(`Yahoo ${symbol}: HTTP ${r.status} ${r.body.slice(0, 200)}`);
  const j = JSON.parse(r.body) as {
    chart: { result?: { timestamp?: number[]; indicators: { quote: { close: (number | null)[]; volume: (number | null)[] }[]; adjclose?: { adjclose: (number | null)[] }[] } }[]; error?: unknown };
  };
  const res = j.chart.result?.[0];
  if (!res?.timestamp) throw new Error(`Yahoo ${symbol}: no data (${JSON.stringify(j.chart.error)})`);
  const q = res.indicators.quote[0]!;
  const adj = res.indicators.adjclose?.[0]?.adjclose;
  const rows = ["Date,Close,Adj Close,Volume"];
  res.timestamp.forEach((ts, i) => {
    const c = q.close[i];
    const a = adj?.[i] ?? c;
    if (c == null || a == null) return;
    rows.push(`${nyDate(ts)},${c},${a},${q.volume[i] ?? ""}`);
  });
  return { csv: rows.join("\n") + "\n", url };
}

/** Stooq daily CSV (independent second source). */
export async function fetchStooq(symbol: string): Promise<{ csv: string; url: string }> {
  const url = `https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.us&i=d`;
  const r = await fetchText(url, { "User-Agent": "Mozilla/5.0 (allowance-lab)" });
  if (r.status !== 200 || !/^Date,/i.test(r.body.trim())) throw new Error(`Stooq ${symbol}: HTTP ${r.status} ${r.body.slice(0, 120)}`);
  return { csv: r.body, url };
}

export interface CrossCheck {
  symbol: string;
  overlapDays: number;
  /** Share of overlapping days whose daily returns agree within `tolerance`. */
  agreement: number;
  tolerance: number;
  worst: { date: string; primary: number; secondary: number }[];
}

/** Compare daily returns of two sources on their common dates. */
export function crossCheck(symbol: string, a: Bar[], b: Bar[], tolerance = 0.01): CrossCheck {
  const mb = new Map(b.map((x) => [x.date, x.close]));
  const common = a.filter((x) => mb.has(x.date));
  const diffs: { date: string; primary: number; secondary: number; d: number }[] = [];
  for (let i = 1; i < common.length; i++) {
    const ra = common[i]!.close / common[i - 1]!.close - 1;
    const rb = mb.get(common[i]!.date)! / mb.get(common[i - 1]!.date)! - 1;
    diffs.push({ date: common[i]!.date, primary: ra, secondary: rb, d: Math.abs(ra - rb) });
  }
  const ok = diffs.filter((x) => x.d <= tolerance).length;
  return {
    symbol,
    overlapDays: diffs.length,
    agreement: diffs.length ? ok / diffs.length : 0,
    tolerance,
    worst: diffs
      .sort((x, y) => y.d - x.d)
      .slice(0, 10)
      .map(({ date, primary, secondary }) => ({ date, primary, secondary })),
  };
}

/* ------------------------------------------------------------------ */
/* Risk-free                                                          */
/* ------------------------------------------------------------------ */

export async function fetchFred(series = "DTB3"): Promise<{ csv: string; url: string }> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`;
  const r = await fetchText(url);
  if (r.status !== 200) throw new Error(`FRED ${series}: HTTP ${r.status}`);
  return { csv: r.body, url };
}

/* ------------------------------------------------------------------ */
/* Earnings dates from SEC filings                                    */
/* ------------------------------------------------------------------ */

export interface EarningsFiling {
  date: string;
  timing: "BMO" | "AMC";
  label: string;
  accession: string;
  acceptance: string;
  url: string;
}

function secHeaders(): Record<string, string> {
  // SEC asks automated clients to identify themselves with a contact.
  const ua = process.env.SEC_USER_AGENT ?? "allowance-lab research (github.com/J-Buchen/hackathon)";
  return { "User-Agent": ua, "Accept-Encoding": "identity" };
}

/**
 * EDGAR's acceptanceDateTime is US Eastern wall-clock time despite the "Z"
 * suffix. Before 09:30 → the market reacts that day (BMO); from 16:00 → the
 * next day (AMC); in between → that day's close already reflects it (BMO).
 */
export function timingFromAcceptance(acceptance: string): "BMO" | "AMC" {
  const m = /T(\d{2}):(\d{2})/.exec(acceptance);
  if (!m) return "BMO";
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 16 * 60 ? "AMC" : "BMO";
}

const RESULTS_HEADLINE = /announces\s+(?:unaudited\s+)?(first|second|third|fourth)\s+quarter(?:\s+and\s+(?:full|fiscal)\s+year)?\s+(\d{4})\s+financial\s+results/i;

export async function fetchEarningsFilings(
  cik = LUCKIN_CIK,
  log: (m: string) => void = () => {},
): Promise<{ filings: EarningsFiling[]; scanned: number; url: string }> {
  const padded = cik.padStart(10, "0");
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  const r = await fetchText(url, secHeaders());
  if (r.status !== 200) throw new Error(`SEC submissions: HTTP ${r.status} — set SEC_USER_AGENT to "Name email@domain" if 403`);
  const j = JSON.parse(r.body) as {
    filings: { recent: { form: string[]; filingDate: string[]; acceptanceDateTime: string[]; accessionNumber: string[]; primaryDocument: string[] } };
  };
  const rec = j.filings.recent;
  const out: EarningsFiling[] = [];
  let scanned = 0;
  for (let i = 0; i < rec.form.length; i++) {
    if (rec.form[i] !== "6-K") continue;
    const acc = rec.accessionNumber[i]!;
    const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}`;
    const idx = await fetchText(`${base}/index.json`, secHeaders());
    await sleep(150); // SEC fair-access: ≤ 10 requests/second
    if (idx.status !== 200) continue;
    const items = (JSON.parse(idx.body) as { directory: { item: { name: string }[] } }).directory.item.map((x) => x.name);
    const docs = items.filter((n) => /\.htm$/i.test(n) && !/index/i.test(n));
    scanned++;
    for (const doc of docs.sort((a, b) => Number(/ex.?99/i.test(b)) - Number(/ex.?99/i.test(a)))) {
      const d = await fetchText(`${base}/${doc}`, secHeaders());
      await sleep(150);
      const text = d.body.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
      const m = RESULTS_HEADLINE.exec(text.slice(0, 20000));
      if (m) {
        out.push({
          date: rec.filingDate[i]!,
          timing: timingFromAcceptance(rec.acceptanceDateTime[i]!),
          label: `${m[1]!.toLowerCase()} quarter ${m[2]} results`,
          accession: acc,
          acceptance: rec.acceptanceDateTime[i]!,
          url: `${base}/${doc}`,
        });
        log(`  6-K ${rec.filingDate[i]} — ${m[0]}`);
        break;
      }
    }
  }
  // One release per quarter: if a quarter shows up twice (e.g. an amendment), keep the first.
  const seen = new Set<string>();
  const filings = out
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true)));
  return { filings, scanned, url };
}

/* ------------------------------------------------------------------ */
/* Orchestrated download                                              */
/* ------------------------------------------------------------------ */

export interface ProvenanceEntry {
  file: string;
  source: string;
  fetchedAt: string;
  rows: number;
  sha256: string;
}

export interface Provenance {
  files: ProvenanceEntry[];
  crossChecks: CrossCheck[];
  earnings: { scanned6K: number; found: number };
  errors: string[];
}

export async function downloadAll(
  dir: string,
  opts: { primary: string; hedges: string[]; from: string; to: string },
  log: (m: string) => void = console.log,
): Promise<Provenance> {
  await mkdir(join(dir, "prices"), { recursive: true });
  await mkdir(join(dir, "events"), { recursive: true });
  await mkdir(join(dir, "rates"), { recursive: true });
  const prov: Provenance = { files: [], crossChecks: [], earnings: { scanned6K: 0, found: 0 }, errors: [] };
  const record = async (file: string, source: string, text: string, rows: number) => {
    await writeFile(join(dir, file), text, "utf8");
    prov.files.push({ file, source, fetchedAt: new Date().toISOString(), rows, sha256: sha256(text) });
  };

  for (const sym of [opts.primary, ...opts.hedges]) {
    try {
      const y = await fetchYahoo(sym, opts.from, opts.to);
      const bars = parsePriceCsv(y.csv, sym);
      await record(`prices/${sym}.csv`, y.url, y.csv, bars.length);
      log(`  ${sym}: ${bars.length} days from Yahoo (${bars[0]!.date} → ${bars[bars.length - 1]!.date})`);
      try {
        const s = await fetchStooq(sym);
        const sb = parsePriceCsv(s.csv, `${sym}/stooq`);
        await record(`prices/${sym}.stooq.csv`, s.url, s.csv, sb.length);
        const cc = crossCheck(sym, bars, sb);
        prov.crossChecks.push(cc);
        log(`  ${sym}: Stooq agrees on ${(cc.agreement * 100).toFixed(1)}% of ${cc.overlapDays} days (±${cc.tolerance * 100}% daily return)`);
      } catch (e) {
        prov.errors.push(`cross-check ${sym}: ${e instanceof Error ? e.message : e}`);
        log(`  ${sym}: no second source — ${e instanceof Error ? e.message : e}`);
      }
    } catch (e) {
      prov.errors.push(`prices ${sym}: ${e instanceof Error ? e.message : e}`);
      log(`  ${sym}: FAILED — ${e instanceof Error ? e.message : e}`);
    }
  }

  try {
    const f = await fetchFred("DTB3");
    await record("rates/DTB3.csv", f.url, f.csv, f.csv.split("\n").length - 2);
    log("  DTB3 (3-month T-bill) from FRED");
  } catch (e) {
    prov.errors.push(`risk-free: ${e instanceof Error ? e.message : e}`);
  }

  try {
    log("  scanning Luckin's SEC 6-K filings for results releases…");
    const { filings, scanned } = await fetchEarningsFilings(LUCKIN_CIK, log);
    const csv = ["date,timing,label,accession,acceptance,url", ...filings.map((f) => `${f.date},${f.timing},${f.label},${f.accession},${f.acceptance},${f.url}`)].join("\n") + "\n";
    await record(`events/${opts.primary}.csv`, `https://data.sec.gov/submissions/CIK${LUCKIN_CIK.padStart(10, "0")}.json`, csv, filings.length);
    prov.earnings = { scanned6K: scanned, found: filings.length };
    log(`  ${filings.length} results releases found in ${scanned} 6-Ks`);
  } catch (e) {
    prov.errors.push(`earnings: ${e instanceof Error ? e.message : e}`);
  }

  await writeFile(join(dir, "provenance.json"), JSON.stringify(prov, null, 2) + "\n", "utf8");
  return prov;
}
