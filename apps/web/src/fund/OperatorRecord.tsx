import { TableScroll } from "../components/TableScroll";
import type { FundSnapshot, OperatorRecordRow } from "./types";
import { auditLine, day, freedLabel, grantStatus, operatorRecordSummary, pct, unallocatedSince } from "./model";

/**
 * The operator record: every stop-out the showcase run filed against the
 * agent's operator (runBook's IncidentSink → the adapters'
 * StopOutIncidentSink), and what the adapters' OperatorGrantScreen WOULD answer
 * that operator for a new grant under its default limits. It is a what-if: the
 * showcase book grants every mandate at the start and none after, and its own
 * grants do not go through that screen. A stop-out is a loss on the agent's
 * own per-unit record, never misconduct: nothing is slashed and nothing
 * already granted is taken back. Operators with no stop-outs share one row, so
 * only the filed rows take space.
 */
export function OperatorRecord({ snapshot }: { snapshot: FundSnapshot }) {
  const { operatorRecord: rows, operatorRecordLimits: limits } = snapshot;
  if (!rows || !limits) {
    return (
      <p className="fc-note-missing" id="fc-operators">
        This snapshot was written before the operator record existed. Run <code>npm run demo:fund</code> to regenerate it.
      </p>
    );
  }
  const sum = operatorRecordSummary({ operatorRecord: rows, operatorRecordLimits: limits });
  const { maxStopOuts } = limits;
  const filed = rows.filter((o) => o.stopOuts.length > 0);
  const clean = rows.filter((o) => o.stopOuts.length === 0);
  return (
    <div className="panel" id="fc-operators">
      <div className="panel-head">
        <h3>
          Operator record <span className="fc-vw">virtual world</span>
        </h3>
        <p className="panel-sub">
          Every stop-out is filed, once, against the operator who runs the agent. It is a record of <strong>losses</strong>,
          not misconduct: nothing is slashed, and nothing already granted is taken back. A stop-out is judged on the agent's
          own per-unit record, even after the allocator has already cut it to zero, so a drawdown here is not money the
          fund lost. A new grant made through the record's grant screen (<code>OperatorGrantScreen</code>) is refused above{" "}
          {maxStopOuts} stop-outs; the showcase book makes no grants after the start, so the last column is what that screen{" "}
          <em>would</em> answer. The operators here are simulated labels (World ID is a mock in this demo).{" "}
          <a href="#fc-log-stopout">See the stop-outs in the log</a>.
        </p>
      </div>
      <p className="fc-oprec-sum">
        <span>
          <strong>{sum.filed}</strong> stop-out{sum.filed === 1 ? "" : "s"} filed against {sum.withStopOuts} of {sum.operators}{" "}
          operators
        </span>
        <span>
          <strong>0</strong> misconduct incidents
        </span>
        <span>
          a new grant would be refused to <strong>{sum.refused}</strong> operator{sum.refused === 1 ? "" : "s"}
          {sum.refused === 0 && sum.filed > 0 && (
            <span className="fc-oprec-why">
              {" "}
              (the most any one has is {sum.most}; the limit is {maxStopOuts})
            </span>
          )}
        </span>
      </p>
      <TableScroll label="Operator record" className="fc-table-scroll">
        {/* Explicit roles: below 640px the rows restyle as cards (styles.css), and the table keeps its semantics. */}
        <table className="cb-table fc-table fc-sticky fc-oprec" role="table">
          <caption className="sr-only">
            Stop-outs filed against each operator in virtual world #{snapshot.world.seed}, and what the grant screen would
            answer a new grant (limit {maxStopOuts} stop-outs)
          </caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">Operator</th>
              <th scope="col" role="columnheader">Agents</th>
              <th scope="col" role="columnheader">Stop-outs on record</th>
              <th scope="col" role="columnheader" className="num">Misconduct</th>
              <th scope="col" role="columnheader">A new grant would be…</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {filed.map((o) => (
              <FiledRow key={o.id} row={o} snapshot={snapshot} maxStopOuts={maxStopOuts} />
            ))}
            {clean.length > 0 && (
              <tr role="row" className="fc-oprec-rest">
                <th scope="row" role="rowheader">
                  <span className="fc-oprec-count">
                    {clean.length} operator{clean.length === 1 ? "" : "s"}
                  </span>
                  <span className="fc-oprec-ids">
                    {clean.map((o) => (
                      <span key={o.id} className={`fc-op${o.agents.length > 1 ? " fc-op-shared" : ""}`}>
                        {o.id}
                      </span>
                    ))}
                  </span>
                </th>
                <td role="cell" className="fc-oprec-agents">
                  {clean.map((o) => o.agents.join(" + ")).join(", ")}
                </td>
                <td role="cell" className="fc-oprec-stopcell is-none">
                  <span className="fc-oprec-none">no stop-outs</span>
                </td>
                <td role="cell" className="num fc-oprec-mis">
                  <span className="fc-oprec-mis-k">misconduct </span>0
                </td>
                <td role="cell" className="fc-oprec-grantcell">
                  <GrantChip refused={false} label="eligible" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}

function FiledRow({ row: o, snapshot, maxStopOuts }: { row: OperatorRecordRow; snapshot: FundSnapshot; maxStopOuts: number }) {
  const status = grantStatus(o, maxStopOuts);
  return (
    <tr role="row" className="fc-oprec-hit">
      <th scope="row" role="rowheader">
        <span className={`fc-op${o.agents.length > 1 ? " fc-op-shared" : ""}`}>{o.id}</span>
      </th>
      <td role="cell" className="fc-oprec-agents">
        {o.agents.join(", ")}
      </td>
      <td role="cell" className="fc-oprec-stopcell">
        <ul className="fc-oprec-stops">
          {o.stopOuts.map((x) => (
            <li key={`${x.agent}-${x.tick}`}>
              <span className="fc-oprec-stop">
                <span className="fc-oprec-day">{day(x.tick)}</span> · {x.label}
              </span>
              <span className="fc-oprec-detail">
                <span className="fc-oprec-dd">
                  <span className="fc-nw">{pct(x.drawdown)} drawdown</span> on its own record (per unit)
                </span>
                <span className="fc-oprec-freed">
                  <span className="fc-oprec-sep"> · </span>
                  {freedLabel(x.freed, x.freed > 0 ? null : unallocatedSince(snapshot, x.agent, x.tick))}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </td>
      <td role="cell" className="num fc-oprec-mis">
        <span className="fc-oprec-mis-k">misconduct </span>
        {o.misconduct}
      </td>
      <td role="cell" className="fc-oprec-grantcell">
        <GrantChip refused={status.refused} label={status.label} />
      </td>
    </tr>
  );
}

function GrantChip({ refused, label }: { refused: boolean; label: string }) {
  return (
    <span className={`fc-grant${refused ? " is-refused" : ""}`}>
      <span aria-hidden="true">{refused ? "⦸" : "✓"}</span>
      <span>
        <span className="fc-grant-k">a new grant would be </span>
        {label}
      </span>
    </span>
  );
}

/**
 * One line: the mandate tree compared with a rebuild from its own event log
 * (DelegationTree.verifyAgainstLog, at the start, the trade and the end of
 * every trading day). It is a self-consistency check, and the line says so
 * up front (the log is not signed); the disclosure explains what is compared.
 * The parser only accepts a finished run's result (0 differences).
 */
export function AuditTrail({ snapshot }: { snapshot: FundSnapshot }) {
  const a = snapshot.audit;
  if (!a) {
    return (
      <p className="fc-note-missing" id="fc-audit">
        This snapshot was written before the log replay check was recorded. Run <code>npm run demo:fund</code> to regenerate it.
      </p>
    );
  }
  return (
    <div className="fc-audit" id="fc-audit">
      <p className="fc-audit-line">
        <span className="fc-audit-mark" aria-hidden="true">
          ✓
        </span>
        <span>
          <strong>Log replay check:</strong> {auditLine(a)}. <span className="fc-vw">virtual world</span>
        </span>
      </p>
      <details className="fc-audit-more">
        <summary>
          <span className="fc-audit-i" aria-hidden="true">
            i
          </span>
          <span>What is compared</span>
        </summary>
        <p>
          At the start, the trade and the end of every trading day ({snapshot.world.ticks} days × 3), the book replays the
          tree's event log ({a.events.toLocaleString("en-US")} events in this run) into a fresh tree and compares it with the
          live one: every budget, spend and revocation must be one the log explains, or the run stops. <strong>Limit:</strong>{" "}
          the log is not signed, so this shows the tree is the one its own log built, not that nobody rewrote the log.
        </p>
      </details>
    </div>
  );
}
