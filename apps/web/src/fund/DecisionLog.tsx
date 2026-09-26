import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FundSnapshot } from "./types";
import { buildLog, day, filterLog, flaggedOperatorCut, pct, usdCompact, type LogEntry, type LogFilter } from "./model";

/**
 * The allocator's decision log. Routine reallocations are folded into one entry
 * per rebalance (its moves open when it is selected); group cuts list every
 * member; stop-outs show what the close handed back. Selecting an entry
 * moves the mandate tree to that day and rings the agents it touched.
 *
 * Keyboard: the list is ONE tab stop (roving tabindex). Arrow keys move between
 * entries, Home/End jump, Enter or Space selects.
 */

interface Props {
  snapshot: FundSnapshot;
  filter: LogFilter;
  onFilter: (f: LogFilter) => void;
  selected: string | null;
  onSelect: (entry: LogEntry) => void;
}

const FILTERS: Array<{ key: LogFilter; label: string }> = [
  { key: "key", label: "Key moves" },
  { key: "group", label: "Group cuts" },
  { key: "operator", label: "Shared operator (flagged)" },
  { key: "stopout", label: "Stop-outs" },
  { key: "ladder", label: "Drawdown ladder" },
  { key: "rebalance", label: "Rebalances" },
  { key: "all", label: "All" },
];

/** Which guarantee an entry shows. A stop-out is one DelegationTree.close (C). */
const GUARANTEE: Record<LogEntry["type"], "R" | "A" | "G" | "C" | null> = {
  grant: "R",
  rebalance: "A",
  ladder: "A",
  group: "G",
  stopout: "C",
  gate: "R",
  opcap: "G",
};

/** Short name of an entry's kind (also used by the tree's status line). */
export function entryKind(e: LogEntry): string {
  switch (e.type) {
    case "grant":
      return "Grant · reserved";
    case "rebalance":
      return "Rebalance";
    case "group":
      return e.cut.kind === "CLONES" ? "Group cut · one trade" : e.cut.kind === "BOOK" ? "Group cut · book-wide" : "Group cut";
    case "stopout":
      return "Stop-out · closed";
    case "ladder":
      return e.kind === "CUT" ? "Drawdown cut" : "Restored";
    case "gate":
      return "Gate clip";
    case "opcap":
      return "Operator cap";
  }
}

function Head({ e }: { e: LogEntry }) {
  const g = GUARANTEE[e.type];
  return (
    <span className="fc-log-head">
      {g ? (
        <span className="fc-log-g" aria-label={`guarantee ${g}`}>{g}</span>
      ) : (
        <span className="fc-log-g fc-log-g-stop" aria-hidden="true">⦸</span>
      )}
      <span className="fc-log-kind">{entryKind(e)}</span>
      <span className="fc-log-t">{e.t === 0 && e.type === "grant" ? "Day 1" : day(e.t)}</span>
    </span>
  );
}

function Body({ e, selected }: { e: LogEntry; selected: boolean }) {
  switch (e.type) {
    case "grant":
      return (
        <span className="fc-log-body">
          {e.agents} agents, {e.each !== null ? `${usdCompact(e.each)} each` : "equal shares"}, carved from the fund's
          budget before any trade.
        </span>
      );
    case "rebalance": {
      const up = e.moves.filter((m) => m.from !== null && m.to !== null && m.to > m.from).length;
      const down = e.moves.filter((m) => m.from !== null && m.to !== null && m.to < m.from).length;
      return (
        <span className="fc-log-body">
          <span>
            {e.moves.length} {e.moves.length === 1 ? "reservation" : "reservations"} resized by risk-adjusted record
            {up + down > 0 && <span className="faint"> ({up} up, {down} down)</span>}
          </span>
          {selected ? (
            <span className="fc-moves">
              {e.moves.map((m) => (
                <span key={m.agent} className="fc-move">
                  <span className="fc-move-agent">{m.agent}</span>
                  {m.from !== null && m.to !== null ? (
                    <span className="fc-move-amt">
                      {usdCompact(m.from)} → {usdCompact(m.to)}
                    </span>
                  ) : (
                    <span className="fc-log-detail">{m.detail}</span>
                  )}
                </span>
              ))}
            </span>
          ) : (
            <span className="fc-moves-hint">Select to list the moves</span>
          )}
        </span>
      );
    }
    case "group": {
      const c = e.cut;
      // On a one-trade cut an operator pair is flagged; on a book-wide cut it is
      // context. (The allocator's operator rule is the separate operator cap.)
      const flagged = flaggedOperatorCut(c);
      const shared = new Set(flagged ? c.sharedOperators.flatMap((o) => o.agents) : []);
      return (
        <span className="fc-log-body">
          <span className="fc-members">
            {c.members.map((m) => (
              <span key={m} className={`fc-member${shared.has(m) ? " fc-member-shared" : ""}`}>
                {m}
              </span>
            ))}
          </span>
          <span className="fc-log-detail">
            {c.instrument
              ? c.kind === "CLONES"
                ? `Overlapping books: one trade in ${c.instrument}`
                : `Book-wide net exposure to ${c.instrument}`
              : "Concentration"}
            {c.share !== null && c.limit !== null && ` at ${pct(c.share)} of NAV, limit ${pct(c.limit, 0)}`}
            {c.scale !== null &&
              ` → ${c.members.length === 1 ? "cut" : c.members.length === 2 ? "both cut" : `all ${c.members.length} cut`} ×${c.scale.toFixed(2)} in one pass`}
            {` · ${c.pods.length} ${c.pods.length === 1 ? "pod" : "pods"}`}
          </span>
          {c.sharedOperators.map((o) =>
            flagged ? (
              <span key={o.operator} className="fc-shared-note">
                <span aria-hidden="true">⚑</span> {o.agents.join(" + ")} also share an operator ({o.operator})
              </span>
            ) : (
              <span key={o.operator} className="fc-shared-context">
                Context: {o.agents.join(" + ")} share an operator ({o.operator}); this cap scaled every holder
              </span>
            ),
          )}
        </span>
      );
    }
    case "stopout": {
      const s = e.stop;
      const why = /drawdown ≥ [^→]+/.exec(s.detail)?.[0]?.trim();
      return (
        <span className="fc-log-body">
          <span>
            <strong>{s.agent}</strong> hit its loss limit{why ? `: ${why}` : ""}.
          </span>
          <span className="fc-close-line">
            {s.freed > 0 ? (
              <>
                Mandate closed: <strong>{usdCompact(s.freed)} USDC</strong> back to its pod
              </>
            ) : (
              "Mandate closed: no capital was at risk, the allocator had already sized it to zero"
            )}
            {s.subtree.length > 1 ? `; ${s.subtree.length - 1} delegated mandates revoked with it.` : "."}
          </span>
        </span>
      );
    }
    case "ladder":
      return (
        <span className="fc-log-body">
          <strong>{e.agent}</strong> <span className="fc-log-detail">{e.detail}</span>
        </span>
      );
    case "gate":
    case "opcap":
      return (
        <span className="fc-log-body">
          <strong>{e.agent}</strong> <span className="fc-log-detail">{e.detail}</span>
        </span>
      );
  }
}

export function DecisionLog({ snapshot, filter, onFilter, selected, onSelect }: Props) {
  const log = useMemo(() => buildLog(snapshot), [snapshot]);
  const counts = useMemo(() => {
    const c = {} as Record<LogFilter, number>;
    for (const f of FILTERS) c[f.key] = filterLog(log, f.key).length;
    return c;
  }, [log]);
  const shown = useMemo(() => filterLog(log, filter), [log, filter]);

  // Roving tabindex: one entry is tabbable, the selected one if it is shown.
  const [focusId, setFocusId] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const selectedShown = selected !== null && shown.some((e) => e.id === selected);
  const current =
    (focusId !== null && shown.some((e) => e.id === focusId) ? focusId : null) ??
    (selectedShown ? selected : null) ??
    shown[0]?.id ??
    null;
  useEffect(() => setFocusId(null), [filter]);

  const moveFocus = (to: number) => {
    const e = shown[Math.max(0, Math.min(shown.length - 1, to))];
    if (!e) return;
    setFocusId(e.id);
    buttons.current.get(e.id)?.focus();
  };
  const onKeyDown = (ev: KeyboardEvent<HTMLOListElement>) => {
    const i = shown.findIndex((e) => e.id === current);
    const page = 8;
    const to =
      ev.key === "ArrowDown" ? i + 1
      : ev.key === "ArrowUp" ? i - 1
      : ev.key === "Home" ? 0
      : ev.key === "End" ? shown.length - 1
      : ev.key === "PageDown" ? i + page
      : ev.key === "PageUp" ? i - page
      : null;
    if (to === null) return;
    ev.preventDefault();
    moveFocus(to);
  };

  const hintId = useId();
  return (
    <div className="fc-log">
      <div className="fc-filters" role="group" aria-label="Filter decisions">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="fc-filter"
            aria-pressed={filter === f.key}
            onClick={() => onFilter(f.key)}
          >
            {f.label} <span className="fc-filter-n">{counts[f.key]}</span>
          </button>
        ))}
      </div>
      {filter === "operator" && (
        <p className="fc-filter-note">
          Operator caps (when one of an operator's agents is stopped out, its other agents are capped together until
          each recovers on its own record) and one-trade cuts whose members include both agents of one operator.
        </p>
      )}
      <p id={hintId} className="sr-only">
        Use the up and down arrow keys to move between decisions, Enter to replay one on the mandate tree.
      </p>
      <div className="fc-log-fill">
        <div className="fc-log-scroll" tabIndex={0} role="region" aria-label="Decision log" aria-describedby={hintId}>
          {shown.length === 0 ? (
            <p className="panel-empty-text fc-log-empty">No decisions of this kind in this world.</p>
          ) : (
            <ol className="fc-log-list" onKeyDown={onKeyDown}>
              {shown.map((e) => {
                const isSel = selected === e.id;
                return (
                  <li key={e.id} className={`fc-log-item fc-log-${e.type}${isSel ? " is-selected" : ""}`}>
                    <button
                      ref={(el) => {
                        if (el) buttons.current.set(e.id, el);
                        else buttons.current.delete(e.id);
                      }}
                      type="button"
                      className="fc-log-select"
                      tabIndex={e.id === current ? 0 : -1}
                      onFocus={() => setFocusId(e.id)}
                      onClick={() => onSelect(e)}
                      aria-pressed={isSel}
                    >
                      <Head e={e} />
                      <Body e={e} selected={isSel} />
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
