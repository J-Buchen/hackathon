/**
 * The deferred-mount queue (section-gate.ts): idle time opens one gate per
 * call in page order, an in-page jump opens every gate at once, and a gate
 * registered after that opens immediately.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateQueue } from "./section-gate";

test("idle time opens gates one at a time, in registration (page) order", () => {
  const q = createGateQueue();
  const opened: string[] = [];
  q.add(() => opened.push("console"));
  q.add(() => opened.push("worked example"));
  q.add(() => opened.push("payments"));
  assert.equal(q.openNext(), true);
  assert.deepEqual(opened, ["console"]);
  assert.equal(q.openNext(), true);
  assert.equal(q.openNext(), true);
  assert.equal(q.openNext(), false);
  assert.deepEqual(opened, ["console", "worked example", "payments"]);
});

test("a gate that opened on its own (in view) leaves the queue", () => {
  const q = createGateQueue();
  const opened: string[] = [];
  q.add(() => opened.push("a"));
  const removeB = q.add(() => opened.push("b"));
  removeB();
  assert.equal(q.size, 1);
  q.openNext();
  assert.equal(q.openNext(), false);
  assert.deepEqual(opened, ["a"]);
});

test("an in-page jump opens every gate at once, and later gates open on registration", () => {
  const q = createGateQueue();
  const opened: string[] = [];
  q.add(() => opened.push("a"));
  q.add(() => opened.push("b"));
  q.openAll();
  assert.deepEqual(opened, ["a", "b"]);
  assert.equal(q.allOpen, true);
  q.add(() => opened.push("c"));
  assert.deepEqual(opened, ["a", "b", "c"]);
  assert.equal(q.size, 0);
});
