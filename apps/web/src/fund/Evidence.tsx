import type { LoopEvidence } from "./types";
import { evidenceRows, pp, pct, type EvidenceRow } from "./model";

/**
 * Sealed-loop evidence: each merged, confirmed change's paired uplift (vs the
 * version before it) on two blocks of virtual worlds nobody tuned on, as a
 * point with its 90% interval against a zero line. Every value is also printed.
 * Loops that merged nothing are listed with their verdict but never plotted.
 */

const GOLD = "#b8841f";

type Row = EvidenceRow;

/**
 * Point-and-interval rows on one shared x scale (percentage points). Plain
 * HTML positioned in percent, so it reflows to any width without scaling
 * text; the table below it is the full-precision fallback.
 */
function Forest({ rows }: { rows: Row[] }) {
  const lo = Math.min(0, ...rows.map((r) => r.u.lo));
  const hi = Math.max(0, ...rows.map((r) => r.u.hi));
  const span = hi - lo || 0.01;
  const x0 = lo - span * 0.06;
  const x1 = hi + span * 0.1;
  const x = (v: number) => `${(((v - x0) / (x1 - x0)) * 100).toFixed(2)}%`;
  const step = span > 0.04 ? 0.02 : span > 0.02 ? 0.01 : 0.005;
  const ticks: number[] = [];
  for (let v = Math.ceil(x0 / step) * step; v <= x1 + 1e-12; v += step) ticks.push(Number(v.toFixed(6)));
  const tickLabel = (t: number) => (t === 0 ? "0" : `${t > 0 ? "+" : "−"}${Math.abs(t * 100).toFixed(step < 0.01 ? 1 : 0)} pp`);
  return (
    <div
      className="fc-forest"
      role="img"
      aria-label={`Paired uplift in certainty-equivalent return with 90% intervals: ${rows
        .map((r) => `${r.label}, ${r.sub}: ${pp(r.u.mean)} (${pp(r.u.lo)} to ${pp(r.u.hi)})`)
        .join("; ")}`}
    >
      {rows.map((r) => (
        <div key={r.key} className="fc-forest-row" title={`${r.label}: ${pp(r.u.mean)} [${pp(r.u.lo)}, ${pp(r.u.hi)}], better in ${pct(r.u.wins, 0)} of worlds`}>
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
            <span className="fc-forest-dot" style={{ left: x(r.u.mean), background: GOLD }} />
          </div>
          <div className="fc-forest-val">
            <strong>{pp(r.u.mean)}</strong>
            <span>
              {pp(r.u.lo, 1)} to {pp(r.u.hi, 1)}
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

export function Evidence({ loops }: { loops: LoopEvidence[] }) {
  if (loops.length === 0) {
    return (
      <p className="panel-empty-text fc-evidence-empty">
        No sealed loop reports yet (docs/loops/loop-*.json). Run the loop driver to produce one.
      </p>
    );
  }
  const rows: Row[] = evidenceRows(loops);
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
              {l.note && <p className="fc-loop-note">{l.note}</p>}
              <p className="fc-loop-meta">
                {l.candidates} candidate changes reviewed ·{" "}
                {Object.entries(l.statuses)
                  .map(([k, v]) => `${v} ${STATUS_LABEL[k] ?? k.replace(/-/g, " ")}`)
                  .join(" · ")}
              </p>
            </li>
          );
        })}
      </ol>
      {rows.length > 0 && (
        <figure className="chart fc-forest-fig">
          <figcaption className="chart-title">Paired uplift of the merged change, certainty-equivalent return (γ = 3), 90% interval</figcaption>
          <Forest rows={rows} />
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
                  <tr key={r.key}>
                    <th scope="row">
                      {r.label}
                      <span className="cb-style">{r.sub}</span>
                    </th>
                    <td className="num">{pp(r.u.mean)}</td>
                    <td className="num">
                      {pp(r.u.lo)} to {pp(r.u.hi)}
                    </td>
                    <td className="num">{pct(r.u.wins, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      )}
      {loops.map(
        (l) =>
          l.headVsBaseline && (
            <p key={`h${l.loop}`} className="fc-note">
              Before loop {l.loop}, on the same {l.headVsBaseline.worlds} sealed worlds, the center book's certainty-equivalent
              return was {pct(l.headVsBaseline.utility, 2)} vs {pct(l.headVsBaseline.baseline, 2)} for per-agent guardrails
              ({pp(l.headVsBaseline.uplift)}, 90% interval {pp(l.headVsBaseline.lo)} to {pp(l.headVsBaseline.hi)}; better in{" "}
              {pct(l.headVsBaseline.winRate, 0)} of worlds).
            </p>
          ),
      )}
    </div>
  );
}
