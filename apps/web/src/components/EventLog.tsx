import type { SnapshotEvent, EventResult } from "../types";
import { formatAmount, shortLabel } from "../format";

/** Result → chip color class. Blocked/denied are made visually loud. */
const RESULT_CLASS: Record<EventResult, string> = {
  OK: "res-ok",
  SETTLED: "res-settled",
  BLOCKED_MANDATE: "res-blocked",
  BLOCKED_SCREENING: "res-blocked",
  DENIED_IDENTITY: "res-denied",
  REVOKED: "res-revoked",
  ATTENUATION_REJECTED: "res-blocked",
};

/** Result → the sponsor/stage that produced it (shown as a small tag). */
const RESULT_STAGE: Partial<Record<EventResult, string>> = {
  BLOCKED_MANDATE: "attenuation",
  BLOCKED_SCREENING: "Intercepta",
  DENIED_IDENTITY: "World ID",
  ATTENUATION_REJECTED: "attenuation",
  SETTLED: "1inch Aqua",
};

const TYPE_ICON: Record<string, string> = {
  FUND: "＋",
  DELEGATE: "→",
  PAYMENT: "$",
  REVOKE: "⦸",
};

function isLoud(result: EventResult): boolean {
  return (
    result === "BLOCKED_MANDATE" ||
    result === "BLOCKED_SCREENING" ||
    result === "DENIED_IDENTITY" ||
    result === "ATTENUATION_REJECTED"
  );
}

export function EventLog({
  events,
  currency,
  decimals,
}: {
  events: SnapshotEvent[];
  currency: string;
  decimals: number;
}) {
  return (
    <ol className="event-log">
      {events.map((e) => (
        <li
          key={e.seq}
          className={`event ${isLoud(e.result) ? "event-loud" : ""} ${
            e.result === "REVOKED" ? "event-revoked" : ""
          }`}
        >
          <span className="event-seq">#{e.seq}</span>
          <span className={`event-type type-${e.type.toLowerCase()}`}>
            <span aria-hidden="true">{TYPE_ICON[e.type] ?? "•"}</span> {e.type}
          </span>
          <div className="event-body">
            <div className="event-line">
              <span className="event-node" title={e.node}>
                {shortLabel(e.node)}
              </span>
              {e.amount && (
                <span className="event-amount">
                  {formatAmount(e.amount, decimals)} {currency}
                </span>
              )}
              {e.merchant && <span className="event-merchant">→ {e.merchant}</span>}
            </div>
            <div className="event-detail">{e.detail}</div>
          </div>
          <div className="event-result">
            <span className={`chip result-chip ${RESULT_CLASS[e.result]}`}>
              {e.result}
            </span>
            {RESULT_STAGE[e.result] && (
              <span className="result-stage">{RESULT_STAGE[e.result]}</span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
