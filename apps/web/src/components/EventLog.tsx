import { memo } from "react";
import type { SnapshotEvent, EventResult, EventType } from "../types";
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

/**
 * Result → plain-language label for assistive tech. The visible chip keeps the
 * raw enum (which reads out awkwardly, e.g. "BLOCKED_MANDATE"); this map feeds
 * the chip's aria-label so a screen reader announces a human phrase instead.
 * Keyed by the frozen EventResult union so a new member is a compile error here,
 * mirroring the RESULT_CLASS pattern above.
 */
const RESULT_LABEL: Record<EventResult, string> = {
  OK: "OK",
  SETTLED: "Settled",
  BLOCKED_MANDATE: "Blocked by mandate",
  BLOCKED_SCREENING: "Blocked by screening",
  DENIED_IDENTITY: "Identity denied",
  REVOKED: "Revoked",
  ATTENUATION_REJECTED: "Attenuation rejected",
};

/** Result → the sponsor/stage that produced it (shown as a small tag). */
const RESULT_STAGE: Partial<Record<EventResult, string>> = {
  BLOCKED_MANDATE: "attenuation",
  BLOCKED_SCREENING: "Intercepta",
  DENIED_IDENTITY: "World ID",
  ATTENUATION_REJECTED: "attenuation",
  SETTLED: "1inch Aqua",
};

// Keyed by EventType (not string) so a new event type added to the frozen union
// is a compile error here; the `?? '•'` at the call site stays as a defensive
// runtime fallback for malformed input.
const TYPE_ICON: Record<EventType, string> = {
  FUND: "＋",
  DELEGATE: "→",
  PAYMENT: "$",
  REVOKE: "⦸",
  RESIZE: "⇅",
};

// The "loud" results are exactly the ones RESULT_CLASS paints as blocked/denied.
// Expressed as a single ReadonlySet<EventResult> so loudness and result handling
// stay in lockstep and a new EventResult member is a compile-time decision.
const LOUD_RESULTS: ReadonlySet<EventResult> = new Set<EventResult>([
  "BLOCKED_MANDATE",
  "BLOCKED_SCREENING",
  "DENIED_IDENTITY",
  "ATTENUATION_REJECTED",
]);

function isLoud(result: EventResult): boolean {
  return LOUD_RESULTS.has(result);
}

/** Memoized: pure, prop-driven list that shouldn't re-render on unrelated
 *  parent state changes (e.g. Reveal animations) under React.StrictMode. */
export const EventLog = memo(function EventLog({
  events,
  currency,
  decimals,
  stageLabels,
}: {
  events: SnapshotEvent[];
  currency: string;
  decimals: number;
  /** Overrides the stage tag per result (e.g. a snapshot that did not settle through 1inch Aqua). */
  stageLabels?: Partial<Record<EventResult, string>>;
}) {
  const stages = stageLabels ? { ...RESULT_STAGE, ...stageLabels } : RESULT_STAGE;
  // A snapshot with zero events (malformed/partial file that still passes shape
  // validation, or a future minimal demo) would otherwise render an empty <ol> —
  // a blank void inside the panel. Show a real empty state instead.
  if (events.length === 0) {
    return (
      <div className="panel-empty" role="status">
        <span className="panel-empty-icon" aria-hidden="true">⦿</span>
        <p className="panel-empty-text">No events recorded yet</p>
      </div>
    );
  }
  return (
    <ol className="event-log" aria-label="Event log, newest first">
      {events.map((e) => {
        // Compose the disconnected visual fragments into one sentence for AT so
        // the row is announced coherently (seq, type, node, amount, merchant,
        // result) instead of as scattered pieces.
        const parts: string[] = [
          `Event ${e.seq}`,
          e.type.toLowerCase(),
          shortLabel(e.node),
        ];
        if (e.amount) parts.push(`${formatAmount(e.amount, decimals)} ${currency}`);
        if (e.merchant) parts.push(`to ${e.merchant}`);
        const rowLabel = `${parts.join(", ")}. ${RESULT_LABEL[e.result]}.`;
        return (
        <li
          key={e.seq}
          aria-label={rowLabel}
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
            {/* Visible text stays the raw enum; aria-label swaps in the plain-
                language phrase so AT doesn't read out "BLOCKED_MANDATE". */}
            <span
              className={`chip result-chip ${RESULT_CLASS[e.result]}`}
              aria-label={RESULT_LABEL[e.result]}
            >
              {e.result}
            </span>
            {stages[e.result] && (
              <span className="result-stage">{stages[e.result]}</span>
            )}
          </div>
        </li>
        );
      })}
    </ol>
  );
});
