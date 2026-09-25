/**
 * Build a renderable delegation tree from the flat `nodes` array.
 *
 * The snapshot stores nodes flat with a `parent` name pointer. The delegation
 * hierarchy (ENS subname structure) is reconstructed here. We also compute, per
 * node, whether it is *effectively* revoked — i.e. it is itself revoked or any
 * ancestor is revoked — because a revoked ancestor disables the whole subtree.
 */

import type { SnapshotNode } from "./types";

export interface TreeNode {
  node: SnapshotNode;
  /** Depth from the root (root = 0), for indentation. */
  depth: number;
  /** True if this node or any ancestor has mandate.revoked = true. */
  effectivelyRevoked: boolean;
  /** Direct children, in snapshot order. */
  children: TreeNode[];
}

export function buildTree(nodes: SnapshotNode[]): TreeNode[] {
  const byName = new Map<string, SnapshotNode>();
  for (const n of nodes) byName.set(n.name, n);

  // Group children by parent name (null-parent => root bucket).
  const childrenOf = new Map<string | null, SnapshotNode[]>();
  for (const n of nodes) {
    const key = n.parent;
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(n);
    else childrenOf.set(key, [n]);
  }

  const build = (n: SnapshotNode, depth: number, ancestorRevoked: boolean): TreeNode => {
    const effectivelyRevoked = ancestorRevoked || n.mandate.revoked;
    const kids = childrenOf.get(n.name) ?? [];
    return {
      node: n,
      depth,
      effectivelyRevoked,
      children: kids.map((k) => build(k, depth + 1, effectivelyRevoked)),
    };
  };

  // Roots are nodes whose parent is null OR whose parent isn't present in the
  // snapshot (defensive against partial snapshots).
  const roots = nodes.filter((n) => n.parent === null || !byName.has(n.parent));
  return roots.map((r) => build(r, 0, false));
}

/** Flatten a tree (pre-order) for easy list rendering with indentation. */
export function flattenTree(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (t: TreeNode) => {
    out.push(t);
    for (const c of t.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}
