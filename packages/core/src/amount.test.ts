/**
 * Tests for the smallest-unit <-> human-decimal helpers (`amount.ts`).
 *
 * These are the numeric foundation of the whole project: every bigint amount
 * crosses the JSON boundary via `formatAmount`, and every human string the demo
 * writes comes back through `parseAmount`. A regression here silently corrupts
 * balances, so we cover the exact round-trips, the sign/zero/decimals edge
 * branches, the throwing paths, AND a seeded property/fuzz loop that asserts the
 * two functions are mutual inverses across a wide range of inputs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAmount, formatAmount, USDC_DECIMALS } from "./amount";

/* ------------------------------------------------------------------ */
/* Exact, hand-picked round-trips                                     */
/* ------------------------------------------------------------------ */

test("parseAmount: exact smallest-unit conversions", () => {
  assert.equal(parseAmount("100.000000"), 100_000000n);
  assert.equal(parseAmount("0.5"), 500000n);
  assert.equal(parseAmount("100"), 100_000000n);
  assert.equal(parseAmount("0"), 0n);
  assert.equal(parseAmount("0.000001"), 1n);
  // numeric input goes through the same path as its string form.
  assert.equal(parseAmount(100), 100_000000n);
});

test("formatAmount: fixed-precision decimal strings", () => {
  assert.equal(formatAmount(100_000000n), "100.000000");
  assert.equal(formatAmount(500000n), "0.500000");
  assert.equal(formatAmount(0n), "0.000000");
  assert.equal(formatAmount(1n), "0.000001");
});

/* ------------------------------------------------------------------ */
/* Negatives                                                          */
/* ------------------------------------------------------------------ */

test("negatives round-trip through both directions", () => {
  assert.equal(parseAmount("-0.5"), -500000n);
  assert.equal(formatAmount(-500000n), "-0.500000");
  assert.equal(parseAmount("-100"), -100_000000n);
  assert.equal(formatAmount(-100_000000n), "-100.000000");
  // "-0" is a valid decimal and normalizes to 0n (bigint has no negative zero).
  assert.equal(parseAmount("-0"), 0n);
});

/* ------------------------------------------------------------------ */
/* Zero / empty-fractional / leading-zero stripping                  */
/* ------------------------------------------------------------------ */

test("'0' and empty fractional parts are handled", () => {
  // No fractional part at all (the `frac = ""` default branch).
  assert.equal(parseAmount("42"), 42_000000n);
  // A whole part of "0" with a fractional part.
  assert.equal(parseAmount("0.250000"), 250000n);
});

test("leading zeros in the whole part are stripped, not misread as octal etc.", () => {
  assert.equal(parseAmount("0100.5"), 100_500000n);
  assert.equal(parseAmount("00000.000001"), 1n);
  // All-zero input collapses to 0n even after padding/stripping.
  assert.equal(parseAmount("000"), 0n);
  assert.equal(parseAmount("0.000000"), 0n);
});

/* ------------------------------------------------------------------ */
/* decimals=0 branch                                                  */
/* ------------------------------------------------------------------ */

test("decimals=0: integers only, no decimal point emitted", () => {
  assert.equal(parseAmount("100", 0), 100n);
  assert.equal(formatAmount(100n, 0), "100");
  assert.equal(formatAmount(0n, 0), "0");
  assert.equal(formatAmount(-7n, 0), "-7");
  // A fractional part is now "too many digits" for 0 decimals.
  assert.throws(() => parseAmount("1.5", 0), /too many fractional digits/);
});

test("custom decimals other than the USDC default", () => {
  assert.equal(USDC_DECIMALS, 6);
  assert.equal(parseAmount("1.23", 2), 123n);
  assert.equal(formatAmount(123n, 2), "1.23");
  assert.equal(parseAmount("1.000000000000000000", 18), 1_000000000000000000n);
});

/* ------------------------------------------------------------------ */
/* Throwing paths                                                     */
/* ------------------------------------------------------------------ */

test("too many fractional digits throws", () => {
  assert.throws(() => parseAmount("0.1234567"), /too many fractional digits/);
  assert.throws(() => parseAmount("1.123", 2), /too many fractional digits/);
});

test("non-decimal input throws", () => {
  assert.throws(() => parseAmount("abc"), /not a decimal number/);
  assert.throws(() => parseAmount("1.2.3"), /not a decimal number/);
  assert.throws(() => parseAmount(""), /not a decimal number/);
  assert.throws(() => parseAmount("1e6"), /not a decimal number/);
  assert.throws(() => parseAmount("0x10"), /not a decimal number/);
  assert.throws(() => parseAmount(" "), /not a decimal number/);
  assert.throws(() => parseAmount("."), /not a decimal number/);
  assert.throws(() => parseAmount("+1"), /not a decimal number/);
});

/* ------------------------------------------------------------------ */
/* Property / fuzz loop (seeded, deterministic)                      */
/* ------------------------------------------------------------------ */

/** mulberry32 — a tiny, deterministic PRNG so the fuzz run is reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ITERATIONS = 500;

test("property: parseAmount(formatAmount(n)) === n for random bigints & decimals", () => {
  const rnd = mulberry32(0x1234abcd);
  for (let i = 0; i < ITERATIONS; i++) {
    // Random token precision (covers the decimals=0 branch too).
    const decimals = Math.floor(rnd() * 9); // 0..8
    // Random magnitude: 1..24 decimal digits.
    const digitCount = 1 + Math.floor(rnd() * 24);
    let digits = "";
    for (let d = 0; d < digitCount; d++) digits += Math.floor(rnd() * 10).toString();
    const negative = rnd() < 0.5;
    const n = (negative ? -1n : 1n) * BigInt(digits);

    const formatted = formatAmount(n, decimals);
    const reparsed = parseAmount(formatted, decimals);
    assert.equal(reparsed, n, `round-trip failed for n=${n} decimals=${decimals} formatted=${formatted}`);

    // formatAmount output must always match the fixed-precision shape.
    const shape = decimals > 0 ? new RegExp(`^-?\\d+\\.\\d{${decimals}}$`) : /^-?\d+$/;
    assert.match(formatted, shape, `bad shape for n=${n} decimals=${decimals}`);
  }
});

test("property: formatAmount(parseAmount(s)) is fixed-precision & idempotent", () => {
  const rnd = mulberry32(0x0badf00d);
  for (let i = 0; i < ITERATIONS; i++) {
    const decimals = Math.floor(rnd() * 9); // 0..8
    // Build a random VALID decimal string within `decimals` fractional digits.
    const wholeLen = 1 + Math.floor(rnd() * 6);
    let whole = "";
    for (let d = 0; d < wholeLen; d++) whole += Math.floor(rnd() * 10).toString();
    const fracLen = decimals === 0 ? 0 : Math.floor(rnd() * (decimals + 1)); // 0..decimals
    let frac = "";
    for (let d = 0; d < fracLen; d++) frac += Math.floor(rnd() * 10).toString();
    const sign = rnd() < 0.5 ? "-" : "";
    const s = fracLen > 0 ? `${sign}${whole}.${frac}` : `${sign}${whole}`;

    const n = parseAmount(s, decimals);
    const formatted = formatAmount(n, decimals);

    // Fixed precision: exactly `decimals` fractional digits (or none at 0).
    const shape = decimals > 0 ? new RegExp(`^-?\\d+\\.\\d{${decimals}}$`) : /^-?\d+$/;
    assert.match(formatted, shape, `bad shape for s="${s}" decimals=${decimals}`);

    // Idempotence: parsing the canonical form yields the identical bigint, and
    // formatting again is a perfect fixed point.
    assert.equal(parseAmount(formatted, decimals), n, `not idempotent for s="${s}"`);
    assert.equal(formatAmount(parseAmount(formatted, decimals), decimals), formatted);
  }
});
