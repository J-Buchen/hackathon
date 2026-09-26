/**
 * End labels on the line charts (swarm/labels.ts): two ends close together
 * are labelled apart, never dropped (loop 3: the 390 px "Net exposure to
 * SBUX" chart lost both labels when its ends were within 16 px).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spreadLabels } from "./swarm/labels";

const gapOk = (ys: number[], gap: number) => {
  const s = [...ys].sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) assert.ok(s[i]! - s[i - 1]! >= gap - 1e-9, `gap ${s[i]! - s[i - 1]!} < ${gap}`);
};

test("labels far apart stay on their points", () => {
  assert.deepEqual(spreadLabels([40, 120], 15), [40, 120]);
  assert.deepEqual(spreadLabels([80], 15), [80]);
});

test("two close labels move apart symmetrically, keeping their order", () => {
  const out = spreadLabels([100, 104], 15);
  gapOk(out, 15);
  assert.ok(out[0]! < out[1]!, "the upper point keeps the upper label");
  assert.ok(Math.abs((out[0]! + out[1]!) / 2 - 102) < 1e-9, "centred on the two points");
  // Same y: still two labels, in series order.
  const same = spreadLabels([50, 50], 15);
  gapOk(same, 15);
  assert.ok(same[0]! < same[1]!);
  // Reversed input order: the label follows its own point.
  const rev = spreadLabels([104, 100], 15);
  assert.ok(rev[0]! > rev[1]!);
});

test("labels stay inside the plot", () => {
  const top = spreadLabels([2, 5], 15, 10, 200);
  gapOk(top, 15);
  assert.ok(Math.min(...top) >= 10);
  const bottom = spreadLabels([198, 199], 15, 10, 200);
  gapOk(bottom, 15);
  assert.ok(Math.max(...bottom) <= 200);
});

test("a chain of collisions resolves as one group", () => {
  const out = spreadLabels([100, 105, 110, 300], 15);
  gapOk(out, 15);
  assert.equal(out[3], 300);
  assert.ok(Math.abs((out[0]! + out[1]! + out[2]!) / 3 - 105) < 1e-9);
});
