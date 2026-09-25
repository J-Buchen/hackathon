/**
 * Tests for the presentation helpers in `./format`.
 *
 * These are pure BigInt/string functions (no React, no DOM), so they run under
 * `node:test` directly. The critical property is that smallest-unit integer
 * strings render as human amounts without any floating-point precision loss, and
 * that malformed input degrades gracefully instead of throwing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount, formatMoney, usageFraction, shortLabel } from "./format";

const DECIMALS = 6; // USDC

test("formatAmount renders a whole amount with no fractional part", () => {
  assert.equal(formatAmount("8000000", DECIMALS), "8");
});

test("formatAmount trims trailing zeros in the fractional part", () => {
  assert.equal(formatAmount("8500000", DECIMALS), "8.5");
});

test("formatAmount inserts a thousands separator in the whole part", () => {
  assert.equal(formatAmount("1000000000", DECIMALS), "1,000");
});

test("formatAmount handles negative amounts", () => {
  assert.equal(formatAmount("-8500000", DECIMALS), "-8.5");
});

test("formatAmount preserves fractional precision that Number would lose", () => {
  // 9_007_199_254_740_993 exceeds Number.MAX_SAFE_INTEGER; BigInt keeps it exact.
  assert.equal(formatAmount("9007199254740993", 0), "9,007,199,254,740,993");
});

test("formatAmount returns a non-integer raw string verbatim (defensive path)", () => {
  // BigInt("1.5") throws; the catch returns the raw string unchanged.
  assert.equal(formatAmount("1.5", DECIMALS), "1.5");
  assert.equal(formatAmount("not-a-number", DECIMALS), "not-a-number");
});

test("formatMoney appends the currency ticker", () => {
  assert.equal(formatMoney("8000000", DECIMALS, "USDC"), "8 USDC");
  assert.equal(formatMoney("8500000", DECIMALS, "USDC"), "8.5 USDC");
});

test("usageFraction returns zeros when the budget is zero", () => {
  assert.deepEqual(usageFraction("0", "0", "0"), { spent: 0, reserved: 0 });
});

test("usageFraction computes spent/reserved percentages of the budget", () => {
  // budget 100, spent 25, reserved 30 -> 25% spent, 30% reserved.
  assert.deepEqual(usageFraction("100000000", "25000000", "30000000"), {
    spent: 25,
    reserved: 30,
  });
});

test("usageFraction handles a fully-consumed budget", () => {
  assert.deepEqual(usageFraction("100000000", "70000000", "30000000"), {
    spent: 70,
    reserved: 30,
  });
});

test("usageFraction returns zeros on malformed BigInt input (defensive path)", () => {
  assert.deepEqual(usageFraction("1.5", "0", "0"), { spent: 0, reserved: 0 });
  assert.deepEqual(usageFraction("100000000", "oops", "0"), { spent: 0, reserved: 0 });
});

test("usageFraction returns zeros for a non-positive (negative) budget", () => {
  assert.deepEqual(usageFraction("-1", "0", "0"), { spent: 0, reserved: 0 });
});

test("shortLabel returns the left-most label of a dotted name", () => {
  assert.equal(shortLabel("scraper.researcher.alice.eth"), "scraper");
  assert.equal(shortLabel("alice.eth"), "alice");
});

test("shortLabel returns a label with no dots unchanged", () => {
  assert.equal(shortLabel("alice"), "alice");
});
