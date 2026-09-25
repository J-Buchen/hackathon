/**
 * Tests for the renderable delegation tree builder in `./tree`.
 *
 * `buildTree` reconstructs the ENS-subname hierarchy from the flat `nodes` array
 * and computes `effectivelyRevoked` (self- or ancestor-revoked). The behaviours
 * that matter for the dashboard — the revocation cascade, orphan-root defense,
 * child ordering, and depth — are pinned here. Pure data, no React/DOM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, flattenTree } from "./tree";
import type { SnapshotNode } from "./types";

/** Minimal node factory; only the fields `buildTree` reads need to be realistic. */
function node(
  name: string,
  parent: string | null,
  revoked = false,
): SnapshotNode {
  return {
    name,
    parent,
    identityStatus: "verified",
    mandate: {
      budget: "0",
      spentDirect: "0",
      reserved: "0",
      available: "0",
      allowedMerchants: null,
      allowedPurposes: null,
      expiry: 4_000_000_000,
      revoked,
    },
  };
}

test("effectivelyRevoked cascades from a revoked ancestor to all descendants", () => {
  // root
  //  ├─ a (revoked)          -> effectivelyRevoked
  //  │   └─ a1               -> effectivelyRevoked (inherited)
  //  │       └─ a2           -> effectivelyRevoked (inherited, 2 levels down)
  //  └─ b                    -> false
  //      └─ b1               -> false (sibling subtree unaffected)
  const nodes = [
    node("root", null),
    node("a.root", "root", true),
    node("a1.a.root", "a.root"),
    node("a2.a1.a.root", "a1.a.root"),
    node("b.root", "root"),
    node("b1.b.root", "b.root"),
  ];

  const flat = flattenTree(buildTree(nodes));
  const revoked = new Map(flat.map((t) => [t.node.name, t.effectivelyRevoked]));

  assert.equal(revoked.get("root"), false);
  assert.equal(revoked.get("a.root"), true);
  assert.equal(revoked.get("a1.a.root"), true);
  assert.equal(revoked.get("a2.a1.a.root"), true);
  // The non-revoked sibling subtree stays entirely false.
  assert.equal(revoked.get("b.root"), false);
  assert.equal(revoked.get("b1.b.root"), false);
});

test("a node whose parent is absent from the snapshot is treated as a root (orphan defense)", () => {
  // "orphan.ghost.eth" points at a parent that isn't in `nodes`, so it must
  // surface as its own root rather than being silently dropped (tree.ts line 48).
  const nodes = [
    node("alice.eth", null),
    node("orphan.ghost.eth", "ghost.eth"),
  ];

  const roots = buildTree(nodes);
  const rootNames = roots.map((r) => r.node.name).sort();
  assert.deepEqual(rootNames, ["alice.eth", "orphan.ghost.eth"]);
  // Orphans are roots: depth 0 and not revoked by any (missing) ancestor.
  const orphan = roots.find((r) => r.node.name === "orphan.ghost.eth");
  assert.equal(orphan?.depth, 0);
  assert.equal(orphan?.effectivelyRevoked, false);
});

test("children preserve snapshot insertion order", () => {
  // Deliberately non-alphabetical to prove order comes from the array, not sort.
  const nodes = [
    node("root", null),
    node("zed.root", "root"),
    node("mid.root", "root"),
    node("abc.root", "root"),
  ];

  const [root] = buildTree(nodes);
  assert.deepEqual(
    root!.children.map((c) => c.node.name),
    ["zed.root", "mid.root", "abc.root"],
  );
});

test("depth increments by one per level of nesting", () => {
  const nodes = [
    node("root", null),
    node("a.root", "root"),
    node("a1.a.root", "a.root"),
    node("a2.a1.a.root", "a1.a.root"),
  ];

  const flat = flattenTree(buildTree(nodes));
  const depth = new Map(flat.map((t) => [t.node.name, t.depth]));
  assert.equal(depth.get("root"), 0);
  assert.equal(depth.get("a.root"), 1);
  assert.equal(depth.get("a1.a.root"), 2);
  assert.equal(depth.get("a2.a1.a.root"), 3);
});

test("flattenTree yields nodes in pre-order DFS", () => {
  // root
  //  ├─ a
  //  │   ├─ a1
  //  │   └─ a2
  //  └─ b
  //      └─ b1
  const nodes = [
    node("root", null),
    node("a.root", "root"),
    node("a1.a.root", "a.root"),
    node("a2.a.root", "a.root"),
    node("b.root", "root"),
    node("b1.b.root", "b.root"),
  ];

  const order = flattenTree(buildTree(nodes)).map((t) => t.node.name);
  assert.deepEqual(order, [
    "root",
    "a.root",
    "a1.a.root",
    "a2.a.root",
    "b.root",
    "b1.b.root",
  ]);
});

test("flattenTree walks multiple roots in order", () => {
  const nodes = [
    node("one.eth", null),
    node("child.one.eth", "one.eth"),
    node("two.eth", null),
  ];

  const order = flattenTree(buildTree(nodes)).map((t) => t.node.name);
  assert.deepEqual(order, ["one.eth", "child.one.eth", "two.eth"]);
});
