import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LineChart, type Series } from "../swarm/LineChart";
import type { FundAgent, FundSnapshot, LadderState } from "./types";
import { MandateTree } from "./MandateTree";
import { DecisionLog, entryKind } from "./DecisionLog";
import { SealedContext } from "./Context";
import { parseConsoleHash } from "./hash";
import {
  day,
  entryAgents,
  groupCutStats,
  pct,
  replayIndexAt,
  showcaseContext,
  signedPct,
  signedUsd,
  statusLabel,
  usdCompact,
  type LogEntry,
  type LogFilter,
} from "./model";

/**
 * Fund console v1: one virtual world, the allocator vs per-agent guardrails.
 * (a) fund NAV, (b) the mandate tree with replay, (c) the decision log, (d) the
 * agent table. The sealed-loop evidence is its own section right after it
 * (EvidencePanel.tsx). Lazy-loaded (see App.tsx).
 */

// Validated pair (dataviz validator): gold = center book, blue = baseline.
const CENTER = "#b8841f";
const BASELINE = "#4f88d6";

/** Below this width the tree and the log stack (styles.css .fc-grid). */
const STACKED = "(max-width: 980px)";

function Sparkline({ values, max, label }: { values: number[]; max: number; label: string }) {
  const W = 96;
  const H = 26;
  const n = values.length;
  const d = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${((i / Math.max(1, n - 1)) * W).toFixed(1)},${(H - 2 - (v / (max || 1)) * (H - 4)).toFixed(1)}`)
    .join("");
  return (
    <svg className="fc-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none">
      <line x1={0} x2={W} y1={H - 2} y2={H - 2} className="fc-spark-base" />
      <path d={d} fill="none" stroke={CENTER} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const RANK = { active: 0, cut: 1, stopped: 2 } as const;
const ICON = { active: "●", cut: "▼", stopped: "⦸" } as const;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export default function FundConsole({ snapshot }: { snapshot: FundSnapshot }) {
  const { world, books } = snapshot;
  const [treeIndex, setTreeIndex] = useState(snapshot.treeStates.length);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [filter, setFilter] = useState<LogFilter>("key");
  /** Set when a selection should bring the replayed tree into view (stacked layout). */
  const revealTree = useRef(false);

  // Links such as "See the rebalances" (#fc-log-rebalance) pick the log filter
  // or the replay; App.tsx scrolls to the panel.
  useEffect(() => {
    const apply = () => {
      const h = parseConsoleHash(window.location.hash);
      if (h?.filter) {
        setFilter(h.filter);
        setSelected(null);
      }
      if (h?.replay) {
        setSelected(null);
        setTreeIndex(h.replay === "grant" ? 0 : snapshot.treeStates.length);
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [snapshot]);

  const onSelect = useCallback(
    (e: LogEntry) => {
      setSelected(e);
      setTreeIndex(replayIndexAt(snapshot, e.t));
      // Stacked layout: the tree is above the log, so show the replay there.
      revealTree.current = window.matchMedia?.(STACKED).matches === true;
    },
    [snapshot],
  );
  useEffect(() => {
    if (!revealTree.current) return;
    revealTree.current = false;
    const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
    const ringed = document.querySelectorAll<HTMLElement>("#fc-tree .fc-node.is-hl");
    const target = ringed[0] ?? document.getElementById("fc-tree");
    target?.scrollIntoView({ behavior, block: ringed.length === 1 ? "center" : "start" });
  }, [selected]);
  const onBackToLog = useCallback(() => {
    const item = document.querySelector<HTMLElement>("#fc-log .fc-log-item.is-selected");
    const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
    (item ?? document.getElementById("fc-log"))?.scrollIntoView({ behavior, block: "center" });
    item?.querySelector<HTMLButtonElement>(".fc-log-select")?.focus({ preventScroll: true });
  }, []);
  const onIndex = useCallback((i: number) => {
    setTreeIndex(i);
    setSelected(null);
  }, []);
  const onFilter = useCallback((f: LogFilter) => setFilter(f), []);
  const highlight = useMemo(() => new Set(selected ? entryAgents(selected) : []), [selected]);

  const nav: Series[] = useMemo(
    () => [
      { key: "center", label: "Center book", color: CENTER, values: books.center.nav.map((v) => v / world.aum) },
      { key: "baseline", label: "Per-agent guardrails", color: BASELINE, values: books.baseline.nav.map((v) => v / world.aum) },
    ],
    [books, world.aum],
  );
  const bands = world.crowd.present
    ? [{ from: world.crowd.startTick, to: world.crowd.crashTick, label: `crowd piles into ${world.crowd.instrument}` }]
    : [];
  const markers = world.crowd.present ? [{ at: world.crowd.crashTick, label: "unwind" }] : [];

  const c = books.center.summary;
  const b = books.baseline.summary;
  const pairs = [
    { label: "Total return", center: signedPct(c.totalReturn), base: signedPct(b.totalReturn) },
    // Two decimals, as in the context card below and the ledger's sealed means.
    { label: "Max drawdown", center: pct(c.maxDrawdown, 2), base: pct(b.maxDrawdown, 2) },
    { label: "Sharpe", center: c.sharpe.toFixed(2), base: b.sharpe.toFixed(2) },
    { label: "Certainty equivalent", center: signedPct(c.utility), base: signedPct(b.utility) },
  ];
  const cuts = groupCutStats(snapshot.groupCuts);
  const freed = snapshot.stopOuts.reduce((s, x) => s + x.freed, 0);
  const sharedOps = world.operators.filter((o) => o.agents.length > 1);
  const operatorCaps = snapshot.decisions.filter((d) => d.kind === "OPERATOR_CUT").length;
  // Was any agent of a shared operator stopped out (the operator cap's trigger)?
  const sharedStopped = snapshot.stopOuts.some((x) => sharedOps.some((o) => o.agents.includes(x.agent)));
  const context = useMemo(() => showcaseContext(snapshot), [snapshot]);

  const agents = useMemo(
    () =>
      [...snapshot.agents].sort(
        (x, y) => RANK[x.status] - RANK[y.status] || (y.capital.at(-1) ?? 0) - (x.capital.at(-1) ?? 0) || x.label.localeCompare(y.label),
      ),
    [snapshot.agents],
  );
  const maxCapital = useMemo(() => Math.max(1, ...snapshot.agents.flatMap((a) => a.capital)), [snapshot.agents]);
  const stoppedAt = useMemo(() => new Map(snapshot.stopOuts.map((s) => [s.name, s.t])), [snapshot.stopOuts]);
  const opCount = useMemo(() => new Map(world.operators.map((o) => [o.id, o.agents.length])), [world.operators]);

  // `capital` is the agent's capital now; the guardrails book passes none (its
  // status is its ladder state only).
  const status = (state: LadderState, at: number | null | undefined, capital?: number) => (
    <span className={`fc-status fc-status-${state}`}>
      <span aria-hidden="true">{ICON[state]}</span> {statusLabel(state, snapshot.policy.center.cutFactor, capital ?? 1)}
      {state === "stopped" && at !== undefined && at !== null && <span className="fc-status-at"> {day(at)}</span>}
    </span>
  );

  return (
    <div className="fc">
      <div className="fc-world" aria-label="About this virtual world">
        <span className="fc-sim">
          <span className="fc-sim-dot" aria-hidden="true" /> Virtual world #{world.seed} · simulated
        </span>
        <span>{world.stocks.length} virtual stocks</span>
        <span>{world.ticks} trading days</span>
        <span>
          {snapshot.agents.length} AI PMs · {world.pods.length} pods · {world.operators.length} operators
        </span>
        {world.crowd.present && (
          <span>
            crowd in {world.crowd.instrument}, {day(world.crowd.startTick)}–{day(world.crowd.crashTick).replace("Day ", "")}
          </span>
        )}
        <span>{usdCompact(world.aum)} USDC AUM</span>
      </div>
      <p className="fc-rule">
        <strong>How this world was picked:</strong> {world.seedRule} (seed {world.seed}). The rule looks at the world's
        make-up, never at either book's result. Every price, agent and operator here is simulated; nothing is market data.
        {context.sealed?.favourable && (
          <>
            {" "}
            It still turned out kinder to the center book than the sealed average, so its numbers sit next to that average{" "}
            <a href="#fc-context">below</a>.
          </>
        )}
        {sharedOps.length > 0 && (
          <>
            {" "}
            In the roster, {sharedOps.map((o) => `${o.agents.join(" and ")} are run by one operator (${o.id})`).join("; ")}.
            The crowding cut groups agents by overlapping positions only; a cut whose members share an operator is flagged.
            Separately, since loop 3 a stop-out caps the same operator's other agents
            {operatorCaps > 0
              ? `, which happened ${operatorCaps} ${operatorCaps === 1 ? "time" : "times"} in this world.`
              : sharedStopped
                ? "; it did not fire in this world."
                : "; no agent of a shared operator was stopped out in this world, so it did not fire."}
          </>
        )}
      </p>

      <div className="fc-top">
        <div className="fc-kpis" role="list" aria-label={`Center book vs per-agent guardrails, virtual world #${world.seed}`}>
          {pairs.map((t) => (
            <div key={t.label} className="cb-tile" role="listitem">
              <div className="tile-label">{t.label}</div>
              <div className="cb-tile-row">
                <span className="chart-key" style={{ background: CENTER }} aria-hidden="true" />
                <span className="cb-tile-value">{t.center}</span>
                <span className="cb-tile-who">center book</span>
              </div>
              <div className="cb-tile-row">
                <span className="chart-key" style={{ background: BASELINE }} aria-hidden="true" />
                <span className="cb-tile-value cb-tile-value-dim">{t.base}</span>
                <span className="cb-tile-who">per-agent guardrails</span>
              </div>
            </div>
          ))}
          <div className="cb-tile fc-kpi-single" role="listitem">
            <div className="tile-label">Group cuts (G)</div>
            <div className="fc-kpi-value">{cuts.total}</div>
            <div className="fc-kpi-sub">
              {cuts.oneTrade} one-trade (overlapping books) · {cuts.bookWide} book-wide caps
            </div>
            {cuts.oneTradeSharedOperator > 0 && (
              <div className="fc-kpi-note">
                <span aria-hidden="true">⚑</span> {cuts.oneTradeSharedOperator} one-trade cuts included both agents of one
                operator (flagged)
                {operatorCaps > 0
                  ? `; ${operatorCaps} operator ${operatorCaps === 1 ? "cap" : "caps"} (a stop-out capping the operator's other agents).`
                  : "."}
              </div>
            )}
          </div>
          <div className="cb-tile fc-kpi-single" role="listitem">
            <div className="tile-label">Stop-outs</div>
            <div className="fc-kpi-value">{snapshot.stopOuts.length}</div>
            <div className="fc-kpi-sub">Each one a single close; {usdCompact(freed)} USDC back to the pods</div>
          </div>
        </div>
        {/* Always rendered: without a sealed average it says so (DESIGN.md §11.1). */}
        <SealedContext ctx={context} seed={world.seed} />
      </div>

      <div className="panel cb-panel" id="fc-nav">
        <LineChart
          title={`Fund NAV, start = 1.00 · virtual world #${world.seed}`}
          series={nav}
          format={(v) => v.toFixed(3)}
          xLabel={day}
          bands={bands}
          markers={markers}
          tableStep={20}
        />
        <p className="fc-caption">
          Same agents, same prices, same leverage ({snapshot.policy.center.leverage}×) and the same deployment. The
          center book (the allocator) looks <em>across</em> the agents (allocation and crowding limits
          {operatorCaps > 0 ? ", and operator caps after a stop-out" : ""}) and
          judges each agent's drawdown against the risk it runs (a stop between 20% and a 40% ceiling); per-agent
          guardrails keep each agent's fixed 20% stop-loss.
        </p>
      </div>

      <div className="fc-grid">
        <div className="panel fc-tree-panel" id="fc-tree">
          <div className="panel-head">
            <h3>
              Mandate tree <span className="fc-vw">virtual world</span>
            </h3>
            <p className="panel-sub">
              Fund → pods → agents: how much of the {usdCompact(world.aum)} USDC AUM each node is <em>allowed</em> to run.
              PnL accrues to the NAV above, not to the tree. Each allocator move is a <code>resize</code> on this tree (
              {snapshot.resizes.toLocaleString("en-US")} in this run). A stop-out is one <code>close</code> of the agent's
              mandate (and anything it delegated); the unspent capital returns to its pod.
            </p>
          </div>
          <MandateTree
            snapshot={snapshot}
            index={treeIndex}
            onIndex={onIndex}
            highlight={highlight}
            selectedKind={selected ? entryKind(selected) : null}
            onBackToLog={onBackToLog}
          />
        </div>
        <div className="panel" id="fc-log">
          <div className="panel-head">
            <h3>
              Decision log <span className="fc-vw">virtual world</span>
            </h3>
            <p className="panel-sub">
              {snapshot.decisions.length.toLocaleString("en-US")} decisions; routine reallocations are folded per rebalance.
              Select one to replay the tree on that day.
            </p>
          </div>
          <DecisionLog snapshot={snapshot} filter={filter} onFilter={onFilter} selected={selected?.id ?? null} onSelect={onSelect} />
        </div>
      </div>

      <div className="panel" id="fc-agents">
        <div className="panel-head">
          <h3>
            Agents <span className="fc-vw">virtual world</span>
          </h3>
          <p className="panel-sub">
            Each record is per unit of capital and bound to its operator. PnL is simulated USDC at the capital the allocator
            actually gave the agent.
          </p>
        </div>
        <div className="table-scroll fc-table-scroll" tabIndex={0} role="region" aria-label="Agents">
          <table className="cb-table fc-table fc-sticky">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Operator</th>
                <th scope="col">Pod</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Capital now</th>
                <th scope="col">Capital path</th>
                <th scope="col" className="num">PnL</th>
                <th scope="col" className="num">Sharpe</th>
                <th scope="col">Per-agent guardrails book</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a: FundAgent) => {
                const now = a.capital.at(-1) ?? 0;
                const shared = a.operator ? (opCount.get(a.operator) ?? 1) > 1 : false;
                return (
                  <tr key={a.name} className={a.status === "stopped" ? "fc-row-stopped" : undefined}>
                    <th scope="row">
                      {a.label}
                      <span className="cb-style">{a.style}</span>
                    </th>
                    <td>
                      {a.operator ? (
                        <span className={`fc-op${shared ? " fc-op-shared" : ""}`}>
                          {a.operator}
                          {shared && <span className="fc-op-count">· runs {opCount.get(a.operator)}</span>}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{a.pod}</td>
                    <td>{status(a.status, stoppedAt.get(a.name), now)}</td>
                    <td className="num">{now > 0 ? usdCompact(now) : "0"}</td>
                    <td>
                      <Sparkline
                        values={a.capital}
                        max={maxCapital}
                        label={`${a.label} capital from ${usdCompact(a.capital[0] ?? 0)} to ${usdCompact(now)}, peak ${usdCompact(Math.max(...a.capital))}`}
                      />
                    </td>
                    <td className="num">{signedUsd(a.totalPnl)}</td>
                    <td className="num">{a.sharpe.toFixed(2)}</td>
                    <td className="fc-baseline">
                      {status(a.baseline.status, a.baseline.stoppedAt)}
                      <span className="fc-baseline-pnl"> {signedUsd(a.baseline.totalPnl)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
