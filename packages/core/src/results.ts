/**
 * EventResult failure classification — the single source of truth.
 *
 * "Is this event result a terminal failure/blocked outcome?" is a question the
 * dashboard adapters (and anything else rendering the event log) repeatedly ask.
 * Keeping the answer here — as a `Record<EventResult, boolean>` — means the union
 * and its classification can never drift: the mapped-record type forces EVERY
 * `EventResult` member to be assigned a boolean at compile time, so adding a new
 * result variant is a compile error until it is classified here.
 */

import type { EventResult } from "./types";

/**
 * Exhaustive classification of every `EventResult` as a failure (`true`) or a
 * success/informational result (`false`). Because the index type is the full
 * `EventResult` union, omitting or misspelling a member fails to type-check.
 */
export const RESULT_IS_FAILURE: Record<EventResult, boolean> = {
  OK: false,
  SETTLED: false,
  BLOCKED_MANDATE: true,
  BLOCKED_SCREENING: true,
  DENIED_IDENTITY: true,
  REVOKED: true,
  ATTENUATION_REJECTED: true,
};

/** True for a terminal-failure result (denied/blocked/revoked/rejected). */
export function isFailureResult(r: EventResult): boolean {
  return RESULT_IS_FAILURE[r];
}
