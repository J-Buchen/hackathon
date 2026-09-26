import type { LoopEvidence } from "./types";
import { drawdownRows, evidenceRows, pp, pct, winPct, type DrawdownRow, type EvidenceRow } from "./model";

/**
 * Sealed-loop evidence, per loop: (a) the merged change's paired uplift in the
 * fund's certainty equivalent with its 90% interval (the corrected number
 * first, when a post-push fix re-measured it), (b) what it did to the center
 * book's mean max drawdown on the confirmation block next to per-agent
 * guardrails' (flagged from before AND after: "still above" only if it already
 * was), the ledger's own note, always visible, and (c) the candidates it did not
 * merge, with the ledger's reasons (collapsed). Two small charts follow, one
 * axis each: the uplift intervals (percentage points) and the drawdown levels
 * before → after (percent). Every value is also printed. Loops that merged
 * nothing are listed with their verdict but never plotted.
 */

// Validated pair (dataviz validator, dark surface): gold = center book, blue = guardrails.
const GOLD = "#b8841f";
const BLUE = "#4f88d6";

/** Evenly spaced tick values covering [lo, hi]. */
function ticksOf(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-12; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/**
 * Point-and-interval rows on one shared x scale (percentage points). Plain
 * HTML positioned in percent, so it reflows to any width without scaling
 * text; the table below it is the full-precision fallback.
 */
function Forest({ rows }: { rows: EvidenceRow[] }) {
  const lo = Math.min(0, ...rows.map((r) => r.u.lo));
  const hi = Math.max(0, ...rows.map((r) => r.u.hi));
  const span = hi - lo || 0.01;
  const x0 = lo - span * 0.06;
  const x1 = hi + span * 0.1;
  const x = (v: number) => `${(((v - x0) / (x1 - x0)) * 100).toFixed(2)}%`;
  const step = span > 0.04 ? 0.02 : span > 0.02 ? 0.01 : 0.005;
  const ticks = ticksOf(x0, x1, step);
  const tickLabel = (t: number) => (t === 0 ? "0" : `${t > 0 ? "+" : "−"}${Math.abs(t * 100).toFixed(step < 0.01 ? 1 : 0)} pp`);
  return (
    <div
      className="fc-forest"
      role="img"
      aria-label={`Paired uplift in certainty-equivalent return with 90% intervals: ${rows
        .map((r) => `${r.label}, ${r.sub}${r.superseded ? " (replaced by the next row)" : ""}: ${pp(r.u.mean)} (${pp(r.u.lo)} to ${pp(r.u.hi)})`)
        .join("; ")}`}
    >
      {rows.map((r) => (
        <div
          key={r.key}
          className={`fc-forest-row${r.superseded ? " is-superseded" : ""}`}
          title={`${r.label}, ${r.sub}${r.detail ? ` (${r.detail})` : ""}: ${pp(r.u.mean)} [${pp(r.u.lo)}, ${pp(r.u.hi)}], better in ${winPct(r.u.wins)} of worlds`}
        >
          <div className="fc-forest-id">
            <span className="fc-forest-label">{r.label}</span>
            <span className="fc-forest-sub">{r.sub}</span>
          </div>
          <div className="fc-forest-track" aria-hidden="true">
            {ticks.map((t) => (
              <span key={t} className="fc-forest-grid" style={{ left: x(t) }} />
            ))}
            <span className="fc-forest-zero" style={{ left: x(0) }} />
            <span className="fc-forest-ci" style={{ left: x(r.u.lo), right: `calc(100% - ${x(r.u.hi)})`, borderColor: GOLD }} />
            {/* A superseded result: hollow dot (the dashed, faded interval is in styles.css). */}
            <span
              className={`fc-forest-dot${r.superseded ? " is-hollow" : ""}`}
              style={r.superseded ? { left: x(r.u.mean), borderColor: GOLD } : { left: x(r.u.mean), background: GOLD }}
            />
          </div>
          <div className="fc-forest-val">
            <strong>{pp(r.u.mean)}</strong>
            <span>
              {pp(r.u.lo, 1).replace(" pp", "")} to {pp(r.u.hi, 1)}
            </span>
          </div>
        </div>
      ))}
      <div className="fc-forest-row fc-forest-axis" aria-hidden="true">
        <div />
        <div className="fc-forest-track">
          {ticks.map((t) => (
            <span key={t} className="fc-forest-tick" style={{ left: x(t) }}>
              {tickLabel(t)}
            </span>
          ))}
        </div>
        <div />
      </div>
    </div>
  );
}

/**
 * The center book's mean max drawdown on each loop's confirmation block:
 * before (hollow ring) → after (filled dot) the loop's change, with per-agent
 * guardrails on the same worlds (blue tick). One axis, in percent; it does not
 * start at zero (a dot plot encodes position, not length), and the axis says so.
 */
function DrawdownChart({ rows }: { rows: DrawdownRow[] }) {
  const values = rows.flatMap((r) => [r.before, r.after, r.guardrails]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // Pad the domain so no mark or edge tick label sits on the panel's edge.
  const pad = Math.max(0.0025, (hi - lo) * 0.15);
  const x0 = lo - pad;
  const x1 = hi + pad;
  const step = x1 - x0 > 0.03 ? 0.01 : 0.005;
  const x = (v: number) => `${(((v - x0) / (x1 - x0)) * 100).toFixed(2)}%`;
  const ticks = ticksOf(x0, x1, step);
  return (
    <div
      className="fc-forest fc-dd"
      role="img"
      aria-label={`Center book mean max drawdown before and after each loop, with per-agent guardrails: ${rows
        .map((r) => `${r.label}, ${r.sub}: ${pct(r.before, 2)} to ${pct(r.after, 2)}, guardrails ${pct(r.guardrails, 2)}`)
        .join("; ")}`}
    >
      {rows.map((r) => (
        <div
          key={r.key}
          className="fc-forest-row"
          title={`${r.label}: center book ${pct(r.before, 2)} → ${pct(r.after, 2)}; per-agent guardrails ${pct(r.guardrails, 2)}`}
        >
          <div className="fc-forest-id">
            <span className="fc-forest-label">{r.label}</span>
            <span className="fc-forest-sub">{r.sub}</span>
          </div>
          <div className="fc-forest-track" aria-hidden="true">
            {ticks.map((t) => (
              <span key={t} className="fc-forest-grid" style={{ left: x(t) }} />
            ))}
            <span
              className="fc-dd-move"
              style={{ left: x(Math.min(r.before, r.after)), right: `calc(100% - ${x(Math.max(r.before, r.after))})`, background: GOLD }}
            />
            <span className="fc-dd-guard" style={{ left: x(r.guardrails), background: BLUE }} />
            <span className="fc-dd-before" style={{ left: x(r.before), borderColor: GOLD }} />
            <span className="fc-dd-after" style={{ left: x(r.after), background: GOLD }} />
          </div>
          <div className="fc-forest-val">
            <strong>
              {pct(r.before, 2)} → {pct(r.after, 2)}
            </strong>
            <span>guardrails {pct(r.guardrails, 2)}</span>
          </div>
        </div>
      ))}
      <div className="fc-forest-row fc-forest-axis" aria-hidden="true">
        <div />
        <div className="fc-forest-track">
          {ticks.map((t) => (
            <span key={t} className="fc-forest-tick" style={{ left: x(t) }}>
              {(t * 100).toFixed(step < 0.01 ? 1 : 0)}%
            </span>
          ))}
        </div>
        <div />
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  "winner-A": "won block A",
  "rejected-review": "rejected in code review",
  "no-uplift-A": "no uplift on block A",
  "harms-A": "hurt block A",
  "tests-fail": "failed tests",
  "does-not-apply": "did not apply",
  "adds-risk-A": "stopped by the risk guard",
  "no-risk-cut-A": "no drawdown cut on block A",
};

const range = (u: { lo: number; hi: number }) => `${pp(u.lo)} to ${pp(u.hi)}`;
const blockSeeds = (b: { from: number; count: number }) => `seeds ${b.from}–${b.from + b.count - 1}`;

/**
 * The drawdown flag, worked out from before AND after: "still above" only when
 * the center book was already above guardrails before the loop; when this loop
 * is what took it above, the flag says so.
 */
const STANDING: Record<DrawdownRow["standing"], { glyph: string; text: string; tone: "bad" | "good" } | null> = {
  "still-above": { glyph: "▲", text: "center book still above", tone: "bad" },
  "now-above": { glyph: "▲", text: "now above · was below before this loop", tone: "bad" },
  "now-below": { glyph: "▼", text: "now below · was above before this loop", tone: "good" },
  below: null,
};

function StandingFlag({ standing }: { standing: DrawdownRow["standing"] }) {
  const s = STANDING[standing];
  if (!s) return null;
  return (
    <span className={`fc-flag${s.tone === "good" ? " is-good" : ""}`}>
      <span aria-hidden="true">{s.glyph} </span>
      {s.text}
    </span>
  );
}

/**
 * (a) + (b): what the merged change did, on the block that confirmed it. When
 * a post-push correction re-measured the gain, the card leads with the number
 * that stands (the code that shipped) and keeps the first confirmation below it.
 */
function LoopFacts({ l, dd }: { l: LoopEvidence; dd: DrawdownRow | undefined }) {
  const first = l.blockB?.allocator ?? null;
  const fixed = first && l.correctedB ? l.correctedB.uplift : null;
  const lead = fixed ?? first;
  if (!lead && !dd) return null;
  return (
    <dl className="fc-facts">
      {lead && (
        <div className="fc-fact">
          <dt>Certainty equivalent vs the code before it · block B</dt>
          <dd>
            <strong className="fc-fact-v">{pp(lead.mean)}</strong>{" "}
            <span className="fc-fact-ci">
              90% interval {range(lead)}; better in {winPct(lead.wins)} of worlds
            </span>
          </dd>
          {fixed && first && (
            <>
              <dd className="fc-fact-sub">Re-measured after the fix, on the code that shipped.</dd>
              <dd className="fc-fact-sub fc-fact-note">
                As first confirmed, before the fix: {pp(first.mean)} ({range(first)}), better in {winPct(first.wins)} of
                worlds.
              </dd>
            </>
          )}
        </div>
      )}
      {dd && (
        <div className="fc-fact">
          <dt>Center-book mean max drawdown · block {l.riskSummary?.block ?? "B"}</dt>
          <dd>
            <strong className="fc-fact-v">
              {pct(dd.before, 2)} → {pct(dd.after, 2)}
            </strong>{" "}
            <span className="fc-fact-ci">
              {dd.paired ? (
                <>
                  paired change {pp(dd.paired.mean)}, 90% interval {range(dd.paired)}
                </>
              ) : (
                "paired change not recorded"
              )}
            </span>
          </dd>
          <dd className="fc-fact-sub">
            Per-agent guardrails on the same worlds: <strong>{pct(dd.guardrails, 2)}</strong>
            <StandingFlag standing={dd.standing} />
          </dd>
          {dd.note && !dd.paired && <dd className="fc-fact-sub fc-fact-note">Ledger: {dd.note}</dd>}
        </div>
      )}
    </dl>
  );
}

/**
 * (c): the candidates the loop did not merge, with the ledger's reasons,
 * collapsed by default. A native details/summary: keyboard operable. (The
 * ledger's own note on the loop stays visible in the loop card.)
 */
function Rejections({ l }: { l: LoopEvidence }) {
  const n = l.rejections.length;
  if (n === 0) return null;
  return (
    <details className="fc-rejects">
      <summary>
        <span className="fc-rejects-chev" aria-hidden="true" />
        <span className="sr-only">Loop {l.loop}: </span>
        {n} candidate{n === 1 ? "" : "s"} not merged, and why
      </summary>
      <ul className="fc-rejects-list" aria-label={`Candidates not merged in loop ${l.loop}`}>
        {l.rejections.map((r) => (
          <li key={r.title}>
            <strong>{r.title}</strong>
            <span>{r.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Evidence({ loops }: { loops: LoopEvidence[] }) {
  if (loops.length === 0) {
    return (
      <p className="panel-empty-text fc-evidence-empty">
        No sealed loop reports yet (docs/loops/loop-*.json). Run the loop driver to produce one.
      </p>
    );
  }
  const rows = evidenceRows(loops);
  const dds = drawdownRows(loops);
  const ddOf = new Map(dds.map((d) => [d.loop, d]));
  return (
    <div className="fc-evidence">
      <ol className="fc-loops">
        {loops.map((l) => {
          const [title, ...rest] = (l.merged[0]?.angle ?? "").split(": ");
          return (
            <li key={l.loop} className="fc-loop">
              <div className="fc-loop-head">
                <span className="fc-loop-n">Loop {l.loop}</span>
                <span className={`fc-loop-verdict${l.confirmed ? " is-ok" : ""}`}>
                  {l.confirmed ? "✓ merged · confirmed on block B" : l.merged.length ? "merged · not confirmed" : "nothing merged"}
                </span>
              </div>
              {l.merged.length > 0 &&
                (l.title ? (
                  <p className="fc-loop-change">
                    <strong>{l.title}</strong>
                  </p>
                ) : (
                  <p className="fc-loop-change">
                    <strong>{title}</strong>
                    {rest.length > 0 && <>: {rest.join(": ")}</>}
                  </p>
                ))}
              <LoopFacts l={l} dd={ddOf.get(l.loop)} />
              {/* The ledger's own words on the loop, always visible: they say
                  what the loop did to drawdown, including the bad news. */}
              {l.note && (
                <p className="fc-loop-note">
                  <span className="fc-loop-note-k">Ledger note</span>
                  {l.note}
                </p>
              )}
              <p className="fc-loop-meta">
                {l.candidates} candidate changes reviewed ·{" "}
                {Object.entries(l.statuses)
                  .map(([k, v]) => `${v} ${STATUS_LABEL[k] ?? k.replace(/-/g, " ")}`)
                  .join(" · ")}
              </p>
              <Rejections l={l} />
            </li>
          );
        })}
      </ol>
      {rows.length > 0 && (
        <figure className="chart fc-forest-fig">
          <figcaption className="chart-title">Paired uplift of the merged change, certainty-equivalent return (γ = 3), 90% interval</figcaption>
          <Forest rows={rows} />
          {rows.some((r) => r.superseded) && (
            <p className="fc-note fc-dd-caption">
              <span className="fc-forest-key" aria-hidden="true" /> Hollow and dashed: a result a later re-measurement
              replaced, kept on the record. The solid row right after it is the number that stands (see that loop's ledger
              note).
            </p>
          )}
          <details className="chart-table">
            <summary>
              Show data table<span className="sr-only">: paired uplift by loop</span>
            </summary>
            <div className="table-scroll fc-table-scroll" tabIndex={0} role="region" aria-label="Sealed loop results">
              <table className="cb-table fc-evidence-table fc-sticky">
                <thead>
                  <tr>
                    <th scope="col">Block</th>
                    <th scope="col" className="num">Uplift</th>
                    <th scope="col" className="num">90% interval</th>
                    <th scope="col" className="num">Worlds improved</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={r.superseded ? "fc-row-superseded" : undefined}>
                      <th scope="row">
                        {r.label}
                        <span className="cb-style">{r.sub}</span>
                        {r.detail && <span className="cb-style">{r.detail}</span>}
                      </th>
                      <td className="num">{pp(r.u.mean)}</td>
                      <td className="num">
                        {pp(r.u.lo)} to {pp(r.u.hi)}
                      </td>
                      <td className="num">{winPct(r.u.wins)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </figure>
      )}
      {/* Certainty equivalent on block A before each loop (the reports'
          baselineA), next to the uplift chart it belongs with, and named as
          block A so it is not read as the block-B drawdown rows below. */}
      {loops.map(
        (l) =>
          l.headVsBaseline && (
            <p key={`h${l.loop}`} className="fc-note">
              Before loop {l.loop}, on block A ({l.headVsBaseline.worlds} sealed worlds, {blockSeeds(l.blocks.A)}), the center
              book's certainty equivalent was {pct(l.headVsBaseline.utility, 2)} vs {pct(l.headVsBaseline.baseline, 2)} for
              per-agent guardrails ({pp(l.headVsBaseline.uplift)}, 90% interval {pp(l.headVsBaseline.lo)} to{" "}
              {pp(l.headVsBaseline.hi)}; better in {winPct(l.headVsBaseline.winRate)} of worlds).
            </p>
          ),
      )}
      {dds.length > 0 && (
        <figure className="chart fc-forest-fig">
          <figcaption className="chart-title">
            Center book's mean max drawdown on each loop's block B, before → after its change, vs per-agent guardrails
          </figcaption>
          <div className="chart-legend fc-dd-legend" aria-hidden="true">
            <span className="chart-legend-item">
              <span className="fc-dd-key fc-dd-key-before" style={{ borderColor: GOLD }} /> Center book, before the loop
            </span>
            <span className="chart-legend-item">
              <span className="fc-dd-key" style={{ background: GOLD }} /> Center book, after
            </span>
            <span className="chart-legend-item">
              <span className="fc-dd-key fc-dd-key-guard" style={{ background: BLUE }} /> Per-agent guardrails
            </span>
          </div>
          <DrawdownChart rows={dds} />
          <p className="fc-note fc-dd-caption">
            Lower is better. Each loop is confirmed on its own block of 200 sealed virtual worlds, so the rows are different
            worlds. The axis does not start at zero.
          </p>
          <details className="chart-table">
            <summary>
              Show data table<span className="sr-only">: center-book max drawdown by loop</span>
            </summary>
            <div className="table-scroll fc-table-scroll" tabIndex={0} role="region" aria-label="Center-book max drawdown by loop">
              <table className="cb-table fc-sticky">
                <thead>
                  <tr>
                    <th scope="col">Loop</th>
                    <th scope="col" className="num">Before</th>
                    <th scope="col" className="num">After</th>
                    <th scope="col" className="num">Paired change (90%)</th>
                    <th scope="col" className="num">Guardrails</th>
                    <th scope="col">After vs guardrails</th>
                  </tr>
                </thead>
                <tbody>
                  {dds.map((d) => (
                    <tr key={d.key}>
                      <th scope="row">
                        {d.label}
                        <span className="cb-style">{d.sub}</span>
                      </th>
                      <td className="num">{pct(d.before, 2)}</td>
                      <td className="num">{pct(d.after, 2)}</td>
                      <td className="num">{d.paired ? `${pp(d.paired.mean)} (${range(d.paired)})` : "not recorded"}</td>
                      <td className="num">{pct(d.guardrails, 2)}</td>
                      <td>{STANDING[d.standing]?.text ?? "center book below"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </figure>
      )}
    </div>
  );
}
