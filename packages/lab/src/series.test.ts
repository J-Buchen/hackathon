import { test } from "node:test";
import assert from "node:assert/strict";
import { alignPanel, alignRiskFree, mapEvents, parseEventsCsv, parseFredCsv, parsePriceCsv, DataError } from "./series";

test("parses Yahoo CSVs, preferring Adj Close and skipping null rows", () => {
  const bars = parsePriceCsv(
    "Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-03,1,1,1,10,9,100\n2024-01-02,1,1,1,11,10,100\n2024-01-04,null,null,null,null,null,null\n",
    "X",
  );
  assert.deepEqual(bars.map((b) => [b.date, b.close]), [["2024-01-02", 10], ["2024-01-03", 9]]);
});

test("parses Stooq CSVs (no Adj Close) and US-style dates", () => {
  const s = parsePriceCsv("Date,Open,High,Low,Close,Volume\n2024-01-02,1,1,1,5,7\n2024-01-03,1,1,1,6,8\n", "Y");
  assert.equal(s[1]!.close, 6);
  const us = parsePriceCsv("date,close\n01/02/2024,5\n01/03/2024,6\n", "Z");
  assert.equal(us[0]!.date, "2024-01-02");
  assert.throws(() => parsePriceCsv("Foo,Bar\n1,2\n3,4\n", "W"), DataError);
});

test("alignment keeps only common days, and a dropped day folds into the next return", () => {
  const mk = (rows: [string, number][]) => rows.map(([date, close]) => ({ date, close, volume: null }));
  const days = Array.from({ length: 40 }, (_, i) => `2024-02-${String(i + 1).padStart(2, "0")}`.replace(/-(3\d|4\d)$/, (m) => m));
  const a = mk(days.map((d, i) => [d, 100 + i]));
  const b = mk(days.filter((_, i) => i !== 5).map((d, i) => [d, 50 + i]));
  const { panel, report } = alignPanel({ A: a, B: b }, "A");
  assert.equal(report.dropped, 1);
  assert.equal(panel.dates.length, 39);
  assert.ok(Math.abs(panel.ret.A![5]! - (106 / 104 - 1)) < 1e-12, "return spans the missing day");
});

test("FRED rates carry forward and convert percent-annual to daily", () => {
  const pts = parseFredCsv("DATE,DTB3\n2024-01-02,5.04\n2024-01-03,.\n2024-01-05,4.8\n");
  assert.equal(pts.length, 2);
  const rf = alignRiskFree(["2024-01-01", "2024-01-02", "2024-01-04", "2024-01-05"], pts);
  assert.deepEqual(rf, [0, 5.04 / 100 / 252, 5.04 / 100 / 252, 4.8 / 100 / 252]);
});

test("events map to the reaction day: BMO same day, AMC next trading day", () => {
  const ev = parseEventsCsv("date,timing,label\n2024-01-03,BMO,q1\n2024-01-03,AMC,q1b\n2024-01-06,BMO,weekend\n");
  const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-08"];
  const m = mapEvents(ev, dates);
  assert.deepEqual(m.map((e) => e.t), [1, 2, 3]);
});
