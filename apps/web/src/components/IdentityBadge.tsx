import type { IdentityStatus } from "../types";

/**
 * World-ID identity badge. Green = verified, amber = expired, grey = none.
 * The `expired`/`none` states are part of the demo punchline (denied path).
 */
export function IdentityBadge({ status }: { status: IdentityStatus }) {
  const label =
    status === "verified" ? "verified" : status === "expired" ? "expired" : "no id";
  const icon = status === "verified" ? "✓" : status === "expired" ? "⏱" : "∅";
  return (
    <span className={`badge badge-identity id-${status}`} title={`World ID: ${status}`}>
      <span aria-hidden="true">{icon}</span> {label}
    </span>
  );
}
