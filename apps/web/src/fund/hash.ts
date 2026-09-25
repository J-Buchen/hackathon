/**
 * In-page links into the fund console. Plain ids (#fund-console, #fc-log, …)
 * scroll natively; the aliases below also set the console's state, so a link
 * such as "See the rebalances" lands on a log that shows rebalances.
 *
 * Kept free of React and of the console's chunk: App.tsx (entry chunk) uses it
 * to scroll, FundConsole.tsx to set the filter or replay.
 */

import type { LogFilter } from "./model";

export interface ConsoleHash {
  /** Element id to scroll to. */
  id: string;
  /** Decision-log filter to select, if any. */
  filter?: LogFilter;
  /** Tree replay position to select, if any. */
  replay?: "grant" | "end";
}

const ALIASES: Record<string, ConsoleHash> = {
  "fc-tree-grant": { id: "fc-tree", replay: "grant" },
  "fc-log-rebalance": { id: "fc-log", filter: "rebalance" },
  "fc-log-group": { id: "fc-log", filter: "group" },
  "fc-log-operator": { id: "fc-log", filter: "operator" },
  "fc-log-stopout": { id: "fc-log", filter: "stopout" },
};

/** "#fc-log-rebalance" → { id: "fc-log", filter: "rebalance" }; "#fc-nav" → { id: "fc-nav" }; "" → null. */
export function parseConsoleHash(hash: string): ConsoleHash | null {
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep the raw text
  }
  if (!raw) return null;
  return ALIASES[raw] ?? { id: raw };
}

/** True for a hash that only exists as an alias (no element carries it). */
export function isConsoleAlias(hash: string): boolean {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return raw in ALIASES;
}
