import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAttenuation, isAllowlistSubset } from "./attenuation";
import type { AgentNode, MandateInput } from "./types";

const FAR = 4_000_000_000; // year ~2096

function parent(overrides: Partial<AgentNode["mandate"]> = {}): AgentNode {
  return {
    name: "alice.eth",
    parent: null,
    identityStatus: "verified",
    mandate: {
      budget: 100_000000n,
      spentDirect: 0n,
      allowedMerchants: undefined,
      allowedPurposes: undefined,
      expiry: FAR,
      revoked: false,
      ...overrides,
    },
  };
}

test("accepts a valid narrowing delegation", () => {
  const proposed: MandateInput = {
    budget: 30_000000n,
    allowedMerchants: ["arxiv", "openai"],
    expiry: FAR - 100,
  };
  const decision = checkAttenuation(parent(), proposed, 100_000000n);
  assert.deepEqual(decision, { ok: true });
});

test("rejects budget exceeding parent available", () => {
  const proposed: MandateInput = { budget: 60_000000n, expiry: FAR };
  // parent available is only 50 here
  const decision = checkAttenuation(parent(), proposed, 50_000000n);
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "BUDGET_EXCEEDS_AVAILABLE");
});

test("rejects merchants that are not a subset of parent", () => {
  const p = parent({ allowedMerchants: ["arxiv", "openai"] });
  const proposed: MandateInput = {
    budget: 10_000000n,
    allowedMerchants: ["arxiv", "evilcorp"],
    expiry: FAR,
  };
  const decision = checkAttenuation(p, proposed, 100_000000n);
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "MERCHANTS_NOT_SUBSET");
});

test("rejects an undefined (any) child allowlist under a restricted parent", () => {
  const p = parent({ allowedMerchants: ["arxiv"] });
  const proposed: MandateInput = { budget: 10_000000n, expiry: FAR };
  const decision = checkAttenuation(p, proposed, 100_000000n);
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "MERCHANTS_NOT_SUBSET");
});

test("rejects expiry later than parent expiry", () => {
  const proposed: MandateInput = { budget: 10_000000n, expiry: FAR + 1 };
  const decision = checkAttenuation(parent(), proposed, 100_000000n);
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "EXPIRY_EXCEEDS_PARENT");
});

test("rejects delegation from a revoked parent", () => {
  const p = parent({ revoked: true });
  const proposed: MandateInput = { budget: 1_000000n, expiry: FAR };
  const decision = checkAttenuation(p, proposed, 100_000000n);
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "PARENT_REVOKED");
});

test("isAllowlistSubset semantics", () => {
  assert.equal(isAllowlistSubset(["a"], undefined), true); // parent any
  assert.equal(isAllowlistSubset(undefined, undefined), true); // both any
  assert.equal(isAllowlistSubset(undefined, ["a"]), false); // child any under restricted
  assert.equal(isAllowlistSubset(["a"], ["a", "b"]), true);
  assert.equal(isAllowlistSubset(["a", "c"], ["a", "b"]), false);
});
