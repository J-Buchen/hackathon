/**
 * The AgentHire demo's committed outputs must load in the dashboard:
 * `agenthire-snapshot.json` against the frozen Snapshot schema, and the
 * receipts sidecar through its own boundary parser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSnapshot } from "./snapshot";
import { AgentHireSidecarError, parseAgentHireSummary } from "./agenthire";

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"));

test("agenthire-snapshot.json is a valid core Snapshot with the closed PM subtree", () => {
  const snap = parseSnapshot(load("agenthire-snapshot.json"));
  const byName = new Map(snap.nodes.map((n) => [n.name, n]));
  assert.equal(snap.nodes.find((n) => n.parent === null)?.name, "fund.eth");
  assert.equal(byName.get("luckin-pm.fund.eth")?.mandate.revoked, true);
  for (const n of ["luckin-pm.fund.eth", "scraper.luckin-pm.fund.eth", "a6-via-a5.scraper.luckin-pm.fund.eth"]) {
    assert.equal(byName.get(n)?.mandate.available, "0", n);
  }
  // The second buyer's BLOCKED_SCREENING happens in its own tree, so it is in the
  // receipts sidecar, not in this snapshot.
  const results = new Set(snap.events.map((e) => e.result));
  for (const r of ["SETTLED", "BLOCKED_MANDATE", "REVOKED"] as const) assert.ok(results.has(r), r);
  assert.ok(snap.events.some((e) => e.type === "REVOKE" && e.node === "luckin-pm.fund.eth"));
});

test("agenthire-receipts.json yields the audit headline, the incident and the honesty notes", () => {
  const s = parseAgentHireSummary(load("agenthire-receipts.json"));
  assert.equal(s.simulated, true);
  assert.match(s.auditHeadline, /^\d+ of \d+ sub-agent payments would have been blocked even under AgentHire's own displayed Hard Spend Cap .*by definition.*assumption: /);
  assert.equal(s.incidents.length, 1);
  assert.match(
    s.incidents[0]!,
    /^ALW-INC-1 · agent 5 · operator 0x1ce3b4044124714daa6a68b95441963679eea6ec · AgentHire dispute route: pending_review \(logged only\)$/,
  );
  assert.match(s.freed ?? "", /^\d+$/);
  assert.ok(s.honesty.some((h) => /escrow/.test(h)));
  assert.ok(s.honesty.some((h) => /synthetic arena world/.test(h)), "the PM's return path is labelled synthetic");
  assert.ok(s.honesty.some((h) => /acting for agent 5/.test(h)), "the scripted overspend is labelled");
});

test("parseAgentHireSummary rejects a malformed sidecar with the path", () => {
  assert.throws(() => parseAgentHireSummary(null), AgentHireSidecarError);
  assert.throws(
    () => parseAgentHireSummary({ simulated: true, agenthire: { mode: "mock" }, audit: { headline: 3 }, incidents: [], honesty: [] }),
    /sidecar\.audit\.headline: expected string/,
  );
});
