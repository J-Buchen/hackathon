import type { TreeNode } from "../tree";
import { formatAmount, shortLabel, usageFraction } from "../format";
import { IdentityBadge } from "./IdentityBadge";
import { Allowlist } from "./Allowlist";

/**
 * A single agent node in the delegation tree. Shows the ENS name, identity
 * badge, the budget breakdown (budget / spent / reserved / AVAILABLE), the
 * allowlists, and revoked state. Indentation encodes depth; a connector rail
 * on the left makes the parent→child hierarchy legible.
 */
export function NodeCard({
  tree,
  currency,
  decimals,
}: {
  tree: TreeNode;
  currency: string;
  decimals: number;
}) {
  const { node, depth, effectivelyRevoked, children } = tree;
  const m = node.mandate;
  const usage = usageFraction(m.budget, m.spentDirect, m.reserved);
  const availablePct = Math.max(0, 100 - usage.spent - usage.reserved);

  const selfRevoked = m.revoked;
  const cls = [
    "node-card",
    effectivelyRevoked ? "is-revoked" : "",
    selfRevoked ? "self-revoked" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="node-row"
      style={{ marginLeft: depth * 28 }}
      data-depth={depth}
    >
      <div className={cls}>
        <div className="node-head">
          <div className="node-title">
            <span className="node-label">{shortLabel(node.name)}</span>
            <span className="node-fqn" title={node.name}>
              {node.name}
            </span>
          </div>
          <div className="node-badges">
            <IdentityBadge status={node.identityStatus} />
            {selfRevoked && <span className="badge badge-revoked">revoked</span>}
            {effectivelyRevoked && !selfRevoked && (
              <span className="badge badge-revoked-inherited" title="An ancestor is revoked">
                ancestor revoked
              </span>
            )}
            {depth === 0 && <span className="badge badge-root">root</span>}
          </div>
        </div>

        {/* Budget usage bar: spent (solid) + reserved (hatched) + available (rest). */}
        <div className="usage-bar" role="img" aria-label="budget usage">
          <div className="usage-spent" style={{ width: `${usage.spent}%` }} />
          <div className="usage-reserved" style={{ width: `${usage.reserved}%` }} />
        </div>

        <div className="node-stats">
          <Stat label="Budget" value={formatAmount(m.budget, decimals)} unit={currency} />
          <Stat label="Spent" value={formatAmount(m.spentDirect, decimals)} unit={currency} />
          <Stat
            label="Reserved"
            value={formatAmount(m.reserved, decimals)}
            unit={currency}
            hint="Σ children budgets"
          />
          <Stat
            label="Available"
            value={formatAmount(m.available, decimals)}
            unit={currency}
            highlight
            hint={`${availablePct.toFixed(0)}% of budget free to attenuate`}
          />
        </div>

        <div className="node-scope">
          <Allowlist label="merchants" items={m.allowedMerchants} />
          <Allowlist label="purposes" items={m.allowedPurposes} />
        </div>
      </div>

      {children.length > 0 && (
        <div className="node-children">
          {children.map((c) => (
            <NodeCard key={c.node.name} tree={c} currency={currency} decimals={decimals} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  highlight,
  hint,
}: {
  label: string;
  value: string;
  unit: string;
  highlight?: boolean;
  hint?: string;
}) {
  return (
    <div className={`stat ${highlight ? "stat-highlight" : ""}`} title={hint}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value} <span className="stat-unit">{unit}</span>
      </span>
    </div>
  );
}
