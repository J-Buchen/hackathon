import { useId, useMemo } from "react";
import type { FundSnapshot } from "./types";
import {
  day,
  ladderAt,
  maxAgentBudget,
  pct,
  sharedOperatorMap,
  stateAtIndex,
  treeRows,
  usdCompact,
  type TreeRow,
} from "./model";

/**
 * The mandate tree at one decision tick: fund → pods → agents. Two scales, both
 * named in the legend: the fund and pod bars are shares of the fund's AUM; the
 * agent bars are shares of the largest mandate any agent held in the run, so a
 * resize is visible at agent size. Segments: spent, delegated to children,
 * available. A tick mark shows the reservation at grant.
 *
 * The tree carries mandate AUTHORITY on the AUM. PnL accrues to the fund's NAV
 * (the chart above it), not to the tree (packages/swarm/src/book.ts).
 */

interface Props {
  snapshot: FundSnapshot;
  /** 0 = at grant; i ≥ 1 = snapshot.treeStates[i − 1] (see model.stateAtIndex). */
  index: number;
  onIndex: (i: number) => void;
  /** Agent labels to ring (the selected log entry's agents). */
  highlight: ReadonlySet<string>;
  /** What the selected log entry is, for the status line ("Group cut", …). */
  selectedKind?: string | null;
  /** Narrow screens: jump back to the decision log after a replay. */
  onBackToLog?: () => void;
}

/**
 * Segments are full-width layers placed with transform only (translateX to the
 * span's start, scaleX to its length, origin at the left), so a replay step
 * animates on the compositor (DESIGN.md §11.2). Patterns are horizontal bands,
 * which a horizontal scale does not distort.
 */
function Bar({ scale, spent, reserved, available, grant, closed }: {
  scale: number;
  spent: number;
  reserved: number;
  available: number;
  grant: number | null;
  closed: boolean;
}) {
  const f = (x: number) => Math.max(0, Math.min(100, (x / (scale || 1)) * 100));
  const a = f(spent);
  const b = f(spent + reserved);
  const c = f(spent + reserved + available);
  const seg = (from: number, to: number) => ({ transform: `translateX(${from}%) scaleX(${Math.max(0, to - from) / 100})` });
  return (
    <div className={`fc-bar${closed ? " fc-bar-closed" : ""}`} aria-hidden="true">
      <span className="fc-seg fc-seg-spent" style={seg(0, a)} />
      <span className="fc-seg fc-seg-reserved" style={seg(a, b)} />
      <span className="fc-seg fc-seg-available" style={seg(b, c)} />
      {/* Static (the grant never moves), so `left` is fine here. */}
      {grant !== null && grant > 0 && <span className="fc-grant-tick" style={{ left: `${f(grant)}%` }} />}
    </div>
  );
}

const STATUS_ICON = { active: "●", cut: "▼", stopped: "⦸" } as const;

export function MandateTree({ snapshot, index, onIndex, highlight, selectedKind, onBackToLog }: Props) {
  const rows = useMemo(() => treeRows(snapshot), [snapshot]);
  const shared = useMemo(() => sharedOperatorMap(snapshot), [snapshot]);
  const agentMax = useMemo(() => maxAgentBudget(snapshot), [snapshot]);
  const sliderId = useId();
  const states = snapshot.treeStates;
  const state = stateAtIndex(snapshot, index);
  const ladder = useMemo(() => ladderAt(snapshot, state.t), [snapshot, state.t]);
  const aum = snapshot.world.aum;
  const grant = snapshot.treeAtGrant;
  const isEnd = index >= states.length;
  const stoppedAt = useMemo(() => new Map(snapshot.stopOuts.map((s) => [s.name, s])), [snapshot]);
  const anySpent = state.spent.some((x) => x > 0);
  const cutText = `cut ×${snapshot.policy.center.cutFactor}`;
  const statusText = { active: "active", cut: cutText, stopped: "stopped out" } as const;

  const podStats = (pod: string) => {
    const agents = rows.filter((r) => r.depth === 2 && r.pod === pod);
    const active = agents.filter((r) => !state.revoked[r.index]).length;
    return { total: agents.length, active };
  };

  const renderRow = (r: TreeRow) => {
    const i = r.index;
    const present = state.present[i];
    const budget = state.budget[i] ?? 0;
    const revoked = state.revoked[i] ?? false;
    const agent = r.agent;
    const status = revoked ? "stopped" : agent ? (ladder.get(agent.name) ?? "active") : "active";
    const stop = revoked ? stoppedAt.get(r.name) : undefined;
    const op = agent?.operator ?? null;
    const twins = op ? shared.get(op) : undefined;
    const hl = agent ? highlight.has(agent.label) : false;
    const granted = grant.budget[i] ?? 0;
    return (
      <li
        key={r.name}
        className={`fc-node fc-depth-${r.depth}${revoked ? " is-closed" : ""}${hl ? " is-hl" : ""}${present ? "" : " is-absent"}`}
      >
        <div className="fc-node-id">
          <span className="fc-node-label">
            {r.depth === 0 ? (
              <>
                <span className="fc-node-kind">Fund</span> {r.label}
              </>
            ) : r.depth === 1 ? (
              <>
                <span className="fc-node-kind">Pod</span> {r.label}
              </>
            ) : (
              r.label
            )}
          </span>
          {r.depth === 1 && (() => {
            const p = podStats(r.pod!);
            return (
              <span className="fc-node-meta">
                {p.total === 0 ? "no agents" : `${p.active} of ${p.total} agents active`}
              </span>
            );
          })()}
          {agent && (
            <span className="fc-node-badges">
              {op && (
                <span
                  className={`fc-op${twins ? " fc-op-shared" : ""}`}
                  title={twins ? `Operator ${op} runs ${twins.join(" and ")}` : `Operator ${op}`}
                >
                  <span className="sr-only">operator </span>
                  {op}
                  {twins && <span className="fc-op-count">· runs {twins.length}</span>}
                </span>
              )}
              <span className={`fc-status fc-status-${status}`}>
                <span aria-hidden="true">{STATUS_ICON[status]}</span> {statusText[status]}
              </span>
            </span>
          )}
        </div>
        <Bar
          scale={r.depth === 2 ? agentMax : aum}
          spent={state.spent[i] ?? 0}
          reserved={state.reserved[i] ?? 0}
          available={state.available[i] ?? 0}
          grant={r.depth === 0 ? null : granted}
          closed={revoked}
        />
        <div className="fc-node-amt">
          {revoked && budget === 0 ? (
            <span className="fc-node-closed">{stop ? `revoked ${day(stop.t)}` : "revoked"}</span>
          ) : r.depth === 0 ? (
            <>
              <strong>{usdCompact(state.reserved[i] ?? 0)}</strong>
              <span className="fc-node-sub">delegated to pods</span>
              <span className="fc-node-sub">{usdCompact(state.available[i] ?? 0)} undelegated</span>
            </>
          ) : r.depth === 1 ? (
            <>
              <strong>{usdCompact(budget)}</strong>
              <span className="fc-node-sub">{pct(budget / aum, 1)} of AUM</span>
            </>
          ) : (
            <>
              <strong>{usdCompact(budget)}</strong>
              <span className="fc-node-sub">{granted > 0 ? `×${(budget / granted).toFixed(2)} vs grant` : " "}</span>
            </>
          )}
        </div>
      </li>
    );
  };

  const fund = rows.filter((r) => r.depth === 0);
  const pods = rows.filter((r) => r.depth === 1);
  const ringed = rows.filter((r) => r.agent && highlight.has(r.agent.label)).map((r) => r.label);
  const announce =
    `Tree at ${day(state.t)}${isEnd ? ", end of run" : ""}.` +
    (ringed.length ? ` ${selectedKind ?? "Selected decision"}: ${ringed.length} ${ringed.length === 1 ? "agent" : "agents"} highlighted, ${ringed.join(", ")}.` : "");

  return (
    <div className="fc-tree">
      <div className="fc-replay">
        <div className="fc-replay-top">
          <label htmlFor={sliderId} className="fc-replay-label">
            Replay <span className="faint">·</span> <strong>{day(state.t)}</strong>
            {isEnd && <span className="faint"> (end of run)</span>}
            {ringed.length > 0 && (
              <span className="fc-replay-hl">
                {" "}
                · {ringed.length} {ringed.length === 1 ? "agent" : "agents"} ringed
              </span>
            )}
          </label>
          {onBackToLog && highlight.size > 0 && (
            <button type="button" className="fc-back" onClick={onBackToLog}>
              Back to the log <span aria-hidden="true">↓</span>
            </button>
          )}
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {announce}
        </span>
        <div className="fc-replay-row">
          <button type="button" className="fc-step" onClick={() => onIndex(Math.max(0, index - 1))} disabled={index === 0} aria-label="Previous decision">
            ‹
          </button>
          <input
            id={sliderId}
            type="range"
            min={0}
            max={states.length}
            step={1}
            value={index}
            onChange={(e) => onIndex(Number(e.target.value))}
            aria-valuetext={day(state.t)}
          />
          <button type="button" className="fc-step" onClick={() => onIndex(Math.min(states.length, index + 1))} disabled={isEnd} aria-label="Next decision">
            ›
          </button>
          <button type="button" className="fc-step fc-step-end" onClick={() => onIndex(states.length)} disabled={isEnd}>
            End
          </button>
        </div>
      </div>
      <div className="fc-legend">
        <span aria-hidden="true"><i className="fc-key fc-seg-available" /> available to trade</span>
        <span aria-hidden="true"><i className="fc-key fc-seg-reserved" /> delegated down</span>
        {anySpent && <span aria-hidden="true"><i className="fc-key fc-seg-spent" /> spent</span>}
        <span aria-hidden="true"><i className="fc-key fc-key-tick" /> at grant</span>
        {highlight.size > 0 && (
          <span aria-hidden="true"><i className="fc-key fc-key-hl" /> in the selected decision</span>
        )}
        <span className="fc-legend-scale">
          Bar scales: fund and pods, share of the {usdCompact(aum)} AUM; agents, share of the largest agent mandate in
          the run ({usdCompact(agentMax)}).
        </span>
      </div>
      <ul className="fc-nodes" aria-label={`Mandate tree at ${day(state.t)}`}>
        {fund.map(renderRow)}
        {pods.map((p) => (
          <li key={p.name} className="fc-pod">
            <ul className="fc-nodes">
              {renderRow(p)}
              <li className="fc-pod-agents">
                <ul className="fc-nodes">{rows.filter((r) => r.depth === 2 && r.pod === p.pod).map(renderRow)}</ul>
              </li>
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
