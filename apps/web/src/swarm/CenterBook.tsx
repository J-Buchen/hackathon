import { useMemo } from "react";
import { LineChart, type Series } from "./LineChart";
import type { Decision, Question, ScorecardRow, SwarmSnapshot } from "./types";

/**
 * The center book: a Tiger-Cub-style fund whose PMs are agents, run twice on
 * the same market — once with per-agent guardrails only, once with the center
 * book looking across all of them.
 */

// Validated categorical pair for the dark chart surface (dataviz validator:
// lightness band, chroma floor, CVD + normal-vision separation, contrast).
const CENTER = "#b8841f";
const NAIVE = "#4f88d6";

const Q_LABEL: Record<Question, string> = {
  company: "Good company?",
  management: "Good management?",
  whyNow: "Why now?",
};

const pct = (x: number, dp = 1) => `${(x * 100).toFixed(dp)}%`;
const signedPct = (x: number, dp = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(dp)}%`;
const compact = (x: number) => {
  const a = Math.abs(x);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0);
  return `${x < 0 ? "−" : ""}${s}`;
};

const SHOWN: ReadonlySet<Decision["kind"]> = new Set(["CROWDING_CUT", "STOP_OUT", "CUT", "GATE_CLIP"]);
const KIND_LABEL: Record<Decision["kind"], string> = {
  ALLOCATE: "Allocate",
  REALLOCATE: "Reallocate",
  CUT: "Drawdown cut",
  RESTORE: "Restore",
  STOP_OUT: "Stop-out · closed",
  CROWDING_CUT: "Crowding cut",
  GATE_CLIP: "Gate clip",
};

export default function CenterBook({ snapshot }: { snapshot: SwarmSnapshot }) {
  const { books, crowd, thesis } = snapshot;
  const day = (i: number) => `Day ${i + 1}`;
  const bands = [{ from: crowd.startTick, to: crowd.crashTick, label: `crowd piles into ${crowd.instrument}` }];
  const markers = [{ at: crowd.crashTick, label: "unwind" }];

  const nav: Series[] = useMemo(
    () => [
      { key: "center", label: "Center book", color: CENTER, values: books.center.nav.map((v) => v / snapshot.aum) },
      { key: "naive", label: "Per-agent guardrails", color: NAIVE, values: books.naive.nav.map((v) => v / snapshot.aum) },
    ],
    [books, snapshot.aum],
  );
  const exposure: Series[] = useMemo(
    () => [
      { key: "center", label: "Center book", color: CENTER, values: books.center.crowdExposure },
      { key: "naive", label: "Per-agent guardrails", color: NAIVE, values: books.naive.crowdExposure },
    ],
    [books],
  );

  const c = books.center.summary;
  const n = books.naive.summary;
  const tiles = [
    { label: "Loss in the unwind", center: signedPct(c.crashWindowReturn), naive: signedPct(n.crashWindowReturn) },
    { label: "Max drawdown", center: pct(c.maxDrawdown), naive: pct(n.maxDrawdown) },
    { label: `Peak ${crowd.instrument} exposure`, center: pct(c.peakCrowdExposure, 0), naive: pct(n.peakCrowdExposure, 0) },
    { label: "Sharpe", center: c.sharpe.toFixed(2), naive: n.sharpe.toFixed(2) },
    { label: "Total return", center: signedPct(c.totalReturn), naive: signedPct(n.totalReturn) },
  ];
  const decisions = snapshot.decisions.filter((d) => SHOWN.has(d.kind));

  return (
    <div className="cb">
      {thesis && <Thesis thesis={thesis} />}

      <div className="cb-tiles" role="list">
        {tiles.map((t) => (
          <div key={t.label} className="cb-tile" role="listitem">
            <div className="tile-label">{t.label}</div>
            <div className="cb-tile-row">
              <span className="chart-key" style={{ background: CENTER }} aria-hidden="true" />
              <span className="cb-tile-value">{t.center}</span>
              <span className="cb-tile-who">center book</span>
            </div>
            <div className="cb-tile-row">
              <span className="chart-key" style={{ background: NAIVE }} aria-hidden="true" />
              <span className="cb-tile-value cb-tile-value-dim">{t.naive}</span>
              <span className="cb-tile-who">per-agent only</span>
            </div>
          </div>
        ))}
      </div>
      <p className="cb-note">
        Same simulated market, same agents, same gate, same leverage. The center book adds what looks{" "}
        <em>across</em> the agents (allocation and crowding limits) and judges each agent's drawdown against the
        risk it runs (a stop between 20% and a 40% ceiling), where per-agent guardrails keep a fixed 20% stop-loss.
        Across {snapshot.sweep.seeds} market seeds the center book
        had the smaller max drawdown on <strong>{snapshot.sweep.centerWinsDrawdown}/{snapshot.sweep.seeds}</strong>{" "}
        and the higher Sharpe on <strong>{snapshot.sweep.centerWinsSharpe}/{snapshot.sweep.seeds}</strong>{" "}
        (mean max drawdown {pct(snapshot.sweep.centerMean.maxDrawdown)} vs{" "}
        {pct(snapshot.sweep.naiveMean.maxDrawdown)}; mean unwind {signedPct(snapshot.sweep.centerMean.crashWindowReturn)} vs{" "}
        {signedPct(snapshot.sweep.naiveMean.crashWindowReturn)}).
        {snapshot.sweepNoEdge && (
          <>
            {" "}If the research is wrong and catalysts carry no edge, the center book still had the smaller
            drawdown on <strong>{snapshot.sweepNoEdge.centerWinsDrawdown}/{snapshot.sweepNoEdge.seeds}</strong>{" "}
            (mean {pct(snapshot.sweepNoEdge.centerMean.maxDrawdown)} vs {pct(snapshot.sweepNoEdge.naiveMean.maxDrawdown)}).
          </>
        )}
      </p>

      <div className="panel cb-panel">
        <LineChart
          title="Fund NAV (start = 1.00)"
          series={nav}
          format={(v) => v.toFixed(3)}
          xLabel={day}
          bands={bands}
          markers={markers}
          tableStep={20}
        />
      </div>
      <div className="panel cb-panel">
        <LineChart
          title={`Net exposure to ${crowd.instrument}, share of NAV`}
          series={exposure}
          format={(v) => pct(v, 0)}
          xLabel={day}
          bands={bands}
          markers={markers}
          baseline={0}
          height={220}
          tableStep={20}
        />
      </div>

      <div className="panel cb-panel">
        <div className="panel-head">
          <h2>Agent track records</h2>
          <p className="panel-sub">
            Per unit of capital, so they're attributable. Twin = the agent whose returns most resemble this one.
          </p>
        </div>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Agent track records">
          <table className="cb-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Pod</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Sharpe</th>
                <th scope="col" className="num">Max DD</th>
                <th scope="col" className="num">Avg capital</th>
                <th scope="col" className="num">PnL</th>
                <th scope="col">Twin</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.agents.map((a) => (
                <tr key={a.name} className={a.status === "stopped" ? "cb-row-stopped" : undefined}>
                  <th scope="row">
                    {a.agent}
                    <span className="cb-style">{a.style}</span>
                  </th>
                  <td>{a.pod}</td>
                  <td>
                    <span className={`cb-status cb-status-${a.status}`}>
                      {a.status === "stopped" ? "⦸ stopped" : a.status === "cut" ? "▼ cut" : "● active"}
                    </span>
                  </td>
                  <td className="num">{a.sharpe.toFixed(2)}</td>
                  <td className="num">{pct(a.maxDrawdown, 0)}</td>
                  <td className="num">{compact(a.avgCapital)}</td>
                  <td className="num">{compact(a.pnl)}</td>
                  <td>
                    {a.closestTwin ? `${a.closestTwin.agent} (${a.closestTwin.corr.toFixed(2)})` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cb-grid">
        <div className="panel">
          <div className="panel-head">
            <h2>Center-book decisions</h2>
            <p className="panel-sub">
              Every cut is a mandate <code>resize</code>, every stop-out a <code>revoke</code>, in the same
              tree as payments. Plus {snapshot.decisionCounts.REALLOCATE ?? 0} routine reallocations.
            </p>
          </div>
          <div className="panel-scroll cb-log-scroll" tabIndex={0} role="region" aria-label="Center-book decisions">
            <ol className="cb-log">
              {decisions.map((d, i) => (
                <li key={`${d.t}-${i}`} className={`cb-log-item cb-log-${d.kind.toLowerCase()}`}>
                  <div className="cb-log-head">
                    <span className="cb-log-kind">{KIND_LABEL[d.kind]}</span>
                    <span className="cb-log-t">{day(d.t)}</span>
                  </div>
                  <div className="cb-log-node">{d.node.split(", ").map((x) => x.split(".")[0]).join(", ")}</div>
                  <div className="cb-log-detail">{d.detail}</div>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="panel cb-panel">
          <div className="panel-head">
            <h2>What earns its keep?</h2>
            <p className="panel-sub">
              Components switched off one at a time, averaged over {snapshot.sweep.seeds} seeds. Reported as-is.
            </p>
          </div>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Ablation">
            <table className="cb-table">
              <thead>
                <tr>
                  <th scope="col">Variant</th>
                  <th scope="col" className="num">Max DD</th>
                  <th scope="col" className="num">Unwind</th>
                  <th scope="col" className="num">Sharpe</th>
                  <th scope="col" className="num">Return</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.ablation.map((r) => (
                  <tr key={r.variant}>
                    <th scope="row">
                      {r.variant}
                      <span className="cb-style">{r.description}</span>
                    </th>
                    <td className="num">{pct(r.meanMaxDrawdown)}</td>
                    <td className="num">{signedPct(r.meanCrashWindowReturn)}</td>
                    <td className="num">{r.meanSharpe.toFixed(2)}</td>
                    <td className="num">{signedPct(r.meanTotalReturn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The thesis: trend → three questions → the trade                            */
/* -------------------------------------------------------------------------- */

function Score({ v }: { v: number }) {
  return (
    <span className={`cb-score cb-score-${v >= 4 ? "hi" : v >= 3 ? "mid" : "lo"}`} aria-label={`${v} of 5`}>
      {v}
    </span>
  );
}

function verdict(row: ScorecardRow, long: string | null, short: string | null): string {
  if (row.ticker === long) return "LONG";
  if (row.ticker === short) return "SHORT";
  if (row.failed.length > 0) return `fails: ${row.failed.map((q) => Q_LABEL[q].replace("?", "")).join(", ")}`;
  return "passes · not top";
}

function Thesis({ thesis }: { thesis: NonNullable<SwarmSnapshot["thesis"]> }) {
  const pm = thesis.pms[0];
  const long = pm?.long ?? null;
  const short = pm?.short ?? null;
  const longRow = thesis.scorecard.find((r) => r.ticker === long);
  const shortRow = thesis.scorecard.find((r) => r.ticker === short);
  const converged = thesis.pms.length > 1 && thesis.pms.every((p) => p.long === long);

  return (
    <div className="panel cb-panel cb-thesis">
      <div className="panel-head">
        <span className="overline">The trend · research as of {thesis.asOf}</span>
        <h2>{thesis.trend.name}</h2>
        <p className="panel-sub">{thesis.trend.thesis}</p>
      </div>
      <div className="cb-thesis-body">
        <ul className="cb-evidence">
          {thesis.trend.evidence.map((e, i) => (
            <li key={i}>
              {e.claim}{" "}
              {e.url ? (
                <a href={e.url} target="_blank" rel="noreferrer">
                  {e.source ?? "source"}
                </a>
              ) : (
                e.source && <span className="faint">{e.source}</span>
              )}
            </li>
          ))}
        </ul>

        <div className="table-scroll" tabIndex={0} role="region" aria-label="Three-question scorecard">
          <table className="cb-table cb-scorecard">
            <thead>
              <tr>
                <th scope="col">Company</th>
                {(Object.keys(Q_LABEL) as Question[]).map((q) => (
                  <th key={q} scope="col" className="num">{Q_LABEL[q]}</th>
                ))}
                <th scope="col" className="num">Weighted</th>
                <th scope="col">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {thesis.scorecard.map((r) => {
                const v = verdict(r, long, short);
                return (
                  <tr key={r.ticker} className={v === "LONG" ? "cb-row-long" : v === "SHORT" ? "cb-row-short" : undefined}>
                    <th scope="row">
                      {r.ticker}
                      <span className="cb-style">{r.company}</span>
                    </th>
                    <td className="num"><Score v={r.scores.company} /></td>
                    <td className="num"><Score v={r.scores.management} /></td>
                    <td className="num"><Score v={r.scores.whyNow} /></td>
                    <td className="num">{r.total.toFixed(2)}</td>
                    <td className="cb-verdict">{v}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {longRow && (
          <div className="cb-pick">
            <div className="cb-pick-col">
              <h3>Why {longRow.ticker}</h3>
              {(Object.keys(Q_LABEL) as Question[]).map((q) => (
                <div key={q} className="cb-q">
                  <div className="cb-q-head">
                    {Q_LABEL[q]} <Score v={longRow.scores[q]} />
                  </div>
                  <ul>
                    {longRow.evidence[q].map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className="cb-risk">
                <strong>What would make this wrong:</strong> {longRow.keyRisk}
              </p>
              {longRow.sources.length > 0 && (
                <p className="cb-sources">
                  Sources:{" "}
                  {longRow.sources.map((src, i) => (
                    <span key={src.url}>
                      {i > 0 && " · "}
                      <a href={src.url} target="_blank" rel="noreferrer">
                        {src.label}
                      </a>
                    </span>
                  ))}
                </p>
              )}
            </div>
            <div className="cb-pick-col">
              <h3>Catalyst calendar</h3>
              <ul className="cb-catalysts">
                {longRow.catalysts.map((cat, i) => (
                  <li key={i}>
                    <span className="cb-cat-date">{cat.expected ?? "undated"}</span> {cat.event}
                  </li>
                ))}
              </ul>
              {shortRow && (
                <>
                  <h3>The pair: short {shortRow.ticker}</h3>
                  <p className="cb-risk">
                    Rides the same trend (exposure {shortRow.trendExposure}/5) but fails "Why now?"{" "}
                    <Score v={shortRow.scores.whyNow} />. {shortRow.evidence.whyNow[0]}
                  </p>
                  <p className="cb-risk">
                    <strong>What would make this wrong:</strong> {shortRow.keyRisk}
                  </p>
                </>
              )}
              <h3>The Tiger Cubs in this book</h3>
              <ul className="cb-pms">
                {thesis.pms.map((p) => (
                  <li key={p.agent}>
                    <strong>{p.agent}</strong> <span className="faint">({p.pod} pod)</span> — weights company{" "}
                    {pct(p.weights.company, 0)} · management {pct(p.weights.management, 0)} · why-now{" "}
                    {pct(p.weights.whyNow, 0)} → long {p.long ?? "nothing"}
                    {p.short ? `, short ${p.short}` : ""}
                  </li>
                ))}
              </ul>
              {converged && (
                <p className="cb-risk">
                  <strong>{thesis.pms.length} PMs in {new Set(thesis.pms.map((p) => p.pod)).size} pods, weighting the
                  questions differently, all land on {long}.</strong> Each is inside its own limits. Together they
                  are one crowded trade — the thing only the center book can see.
                </p>
              )}
            </div>
          </div>
        )}
        <p className="cb-disclaimer">
          {thesis.caveat && <>{thesis.caveat} </>}
          Research is illustrative and dated; not investment advice. Prices in the simulation are synthetic;
          real tickers are used only to label the thesis.{" "}
          {thesis.assumesEdge
            ? "The simulation assumes the thesis has a modest edge around its catalysts, so you can watch the book size a correct-but-crowded idea. It does not test whether the thesis is right."
            : "The simulation gives the thesis no edge: catalysts add variance only."}
        </p>
      </div>
    </div>
  );
}
