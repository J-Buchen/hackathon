/**
 * Tests for the snapshot serializer (`toSnapshot` in `serialize.ts`).
 *
 * The snapshot is the FROZEN contract between the backend and the web dashboard
 * (DESIGN §7): every bigint amount must cross the boundary as a decimal STRING of
 * smallest units, `reserved`/`available` must be derived from the tree, and
 * `undefined` allowlists must become `null`. These tests pin all of that, plus
 * the empty-tree principal fallback and every `opts.*` override.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DelegationTree } from "./tree";
import { toSnapshot } from "./serialize";
import type { AllowanceEvent } from "./types";

const FAR = 4_000_000_000;

/** A small tree: funded root + one nested delegate. */
function seed(): DelegationTree {
  const tree = new DelegationTree();
  tree.fundRoot({
    principal: "alice",
    rootName: "alice.eth",
    // root has NO merchant/purpose restrictions -> allowlists are undefined.
    mandate: { budget: 100_000000n, expiry: FAR },
  });
  tree.delegate("alice.eth", "researcher", {
    budget: 30_000000n,
    allowedMerchants: ["arxiv", "openai"],
    allowedPurposes: ["research"],
    expiry: FAR,
  });
  return tree;
}

test("per-node reserved/available strings equal the tree's own computation", () => {
  const tree = seed();
  const snap = toSnapshot(tree);
  for (const n of snap.nodes) {
    assert.equal(n.mandate.reserved, tree.reserved(n.name).toString(), `reserved for ${n.name}`);
    assert.equal(n.mandate.available, tree.available(n.name).toString(), `available for ${n.name}`);
  }
  // And the concrete values, to catch a silently-wrong-but-consistent formula.
  const root = snap.nodes.find((n) => n.name === "alice.eth")!;
  assert.equal(root.mandate.reserved, "30000000"); // researcher's budget is reserved
  assert.equal(root.mandate.available, "70000000"); // 100 - 0 - 30
});

test("every bigint mandate field serializes to a decimal string", () => {
  const tree = seed();
  const snap = toSnapshot(tree);
  for (const n of snap.nodes) {
    for (const field of ["budget", "spentDirect", "reserved", "available"] as const) {
      const v = n.mandate[field];
      assert.equal(typeof v, "string", `${n.name}.${field} must be a string`);
      assert.match(v, /^-?\d+$/, `${n.name}.${field} must be a decimal integer string`);
    }
  }
});

test("undefined allowlists serialize to null; defined ones survive as arrays", () => {
  const tree = seed();
  const snap = toSnapshot(tree);
  const root = snap.nodes.find((n) => n.name === "alice.eth")!;
  assert.equal(root.mandate.allowedMerchants, null);
  assert.equal(root.mandate.allowedPurposes, null);

  const researcher = snap.nodes.find((n) => n.name === "researcher.alice.eth")!;
  assert.deepEqual(researcher.mandate.allowedMerchants, ["arxiv", "openai"]);
  assert.deepEqual(researcher.mandate.allowedPurposes, ["research"]);
});

test("event amounts: null stays null, non-null becomes its .toString()", () => {
  const tree = seed();
  tree.revoke("researcher.alice.eth"); // REVOKE events carry amount === null
  const snap = toSnapshot(tree);

  const fund = snap.events.find((e) => e.type === "FUND")!;
  assert.equal(fund.amount, "100000000"); // budget, as a smallest-unit string

  const revoke = snap.events.find((e) => e.type === "REVOKE")!;
  assert.equal(revoke.amount, null);
});

test("an empty tree yields the principal fallback and no nodes", () => {
  const tree = new DelegationTree();
  const snap = toSnapshot(tree);
  assert.deepEqual(snap.principal, { name: "", verified: false });
  assert.deepEqual(snap.nodes, []);
  assert.deepEqual(snap.events, []);
  assert.equal(snap.currency, "USDC");
});

test("opts.asOf, opts.decimals and opts.events overrides are honored", () => {
  const tree = seed();

  const customEvents: AllowanceEvent[] = [
    { seq: 0, type: "FUND", node: "alice.eth", detail: "custom", result: "OK", amount: 7n, merchant: null },
  ];

  const snap = toSnapshot(tree, { asOf: 1234567890, decimals: 2, events: customEvents });

  assert.equal(snap.asOf, 1234567890);
  assert.equal(snap.decimals, 2);
  // The override list is serialized instead of the tree's own log.
  assert.equal(snap.events.length, 1);
  assert.equal(snap.events[0]!.detail, "custom");
  assert.equal(snap.events[0]!.amount, "7"); // still stringified from the bigint
});
