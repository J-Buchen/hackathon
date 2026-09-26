import type { IdentityStatus } from "../types";

/**
 * World-ID identity badge. Green = verified, amber = expired, grey = none.
 * The `expired`/`none` states are part of the demo punchline (denied path).
 * `source` names who issued it: the demos use a deterministic World ID mock.
 */
export function IdentityBadge({ status, source = "World ID (mock)" }: { status: IdentityStatus; source?: string }) {
  const label =
    status === "verified" ? "verified" : status === "expired" ? "expired" : "no id";
  const icon = status === "verified" ? "✓" : status === "expired" ? "⏱" : "∅";
  return (
    <span className={`badge badge-identity id-${status}`} title={`${source}: ${status}`}>
      <span aria-hidden="true">{icon}</span> {label}
    </span>
  );
}
