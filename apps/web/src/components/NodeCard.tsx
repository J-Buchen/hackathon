import { memo } from "react";
import type { TreeNode } from "../tree";
import { formatAmount, shortLabel, usageFraction } from "../format";
import { IdentityBadge } from "./IdentityBadge";
import { Allowlist } from "./Allowlist";

/**
 * A single agent node in the delegation tree. Shows the ENS name, identity
 * badge, the budget breakdown (budget / spent / reserved / AVAILABLE), the
 * allowlists, and revoked state. Indentation encodes depth (one fixed step
 * per level, narrower on a narrow panel); a connector rail on the left makes
 * the parent→child hierarchy legible.
 *
 * Memoized: this recursive, purely prop-driven component would otherwise
 * re-walk the entire subtree whenever an unrelated parent state change (e.g. a
 * Reveal animation) triggers a re-render under React.StrictMode.
 */
export const NodeCard = memo(function NodeCardInner({
  tree,
  currency,
  decimals,
  identitySource,
}: {
  tree: TreeNode;
  currency: string;
  decimals: number;
  /** Who issued the identity badges, e.g. "World ID (mock)". */
  identitySource?: string;
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

  // Depth is otherwise encoded only visually (indentation), so summarize the node
  // and its revoked state in one accessible label for the treeitem row.
  const revokedSuffix = selfRevoked
    ? ", revoked"
    : effectivelyRevoked
      ? ", ancestor revoked"
      : "";
  const rowLabel = `${shortLabel(node.name)}, available ${formatAmount(
    m.available,
    decimals,
  )} ${currency}${revokedSuffix}`;

  return (
    // Indentation: each child row nests inside its parent's row and steps in
    // by one --tree-indent (styles.css), so depth adds up without growing.
    <div
      className="node-row"
      data-depth={depth}
      role="treeitem"
      aria-level={depth + 1}
      aria-label={rowLabel}
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
            <IdentityBadge status={node.identityStatus} source={identitySource} />
            {selfRevoked && <span className="badge badge-revoked">revoked</span>}
            {effectivelyRevoked && !selfRevoked && (
              <span className="badge badge-revoked-inherited" title="An ancestor is revoked">
                ancestor revoked
              </span>
            )}
            {depth === 0 && <span className="badge badge-root">root</span>}
          </div>
        </div>

        {/* Budget usage bar: spent (solid) + reserved (hatched) + available (rest).
            The aria-label carries the actual proportions so the purely-visual bar
            is meaningful to a screen reader. */}
        <div
          className="usage-bar"
          role="img"
          aria-label={`Budget usage: ${usage.spent.toFixed(0)}% spent, ${usage.reserved.toFixed(
            0,
          )}% reserved, ${availablePct.toFixed(0)}% available`}
        >
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
        <div className="node-children" role="group">
          {children.map((c) => (
            <NodeCard key={c.node.name} tree={c} currency={currency} decimals={decimals} identitySource={identitySource} />
          ))}
        </div>
      )}
    </div>
  );
});

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
        <span className="stat-num">{value}</span> <span className="stat-unit">{unit}</span>
      </span>
    </div>
  );
}
