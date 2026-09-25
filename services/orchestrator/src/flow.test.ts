/**
 * First tests for the orchestrator's `AllowanceFlow` (`flow.ts`).
 *
 * The flow is the thin composition layer around core's `pay()`: it mirrors the
 * on-chain Uniswap v4 spend-cap hook, runs the pure pipeline, and re-projects the
 * tree onto ENS. These tests drive `executePayment` through EVERY `PaymentOutcome`
 * and assert the three cross-cutting invariants the flow is responsible for:
 *
 *   1. `hookAgrees` is true in every case — the off-chain pipeline and the on-chain
 *      hook mirror reach the same mandate/cap verdict (mandateVerdictAgrees).
 *   2. `event.seq === record.seq` — requireEvent's O(1) direct-index path finds the
 *      single PAYMENT event pay() appended.
 *   3. After a SETTLED payment the ENS text record `allowance.spentDirect` for the
 *      paying node reflects the new balance — proving the lock-step projection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DelegationTree, parseAmount, type MandateInput } from "@allowance/core";
import { createMockAdapters, MANDATE_KEYS } from "@allowance/adapters";

import { AllowanceFlow, createFlow } from "./flow";

/* Fixed, reproducible timeline. */
const NOW = Math.floor(Date.UTC(2026, 8, 25, 12, 0, 0) / 1000);
const EXPIRY = NOW + 30 * 24 * 60 * 60;
const PAY_AT = { now: NOW } as const;

const ROOT = "alice.eth";

/** Build a funded flow over fresh state (mock adapters, in-memory ENS). */
function newFlow(rootBudget: bigint): AllowanceFlow {
  const tree = new DelegationTree();
  tree.fundRoot({
    principal: "alice",
    rootName: ROOT,
    // root is unrestricted (any merchant/purpose) so the mandate stage never
    // blocks — letting each test isolate the outcome it targets.
    mandate: { budget: rootBudget, expiry: EXPIRY } satisfies MandateInput,
  });
  return createFlow(tree, createMockAdapters(), { settlementToken: "USDC" });
}

/** Assertions common to every outcome. */
function assertInvariants(r: Awaited<ReturnType<AllowanceFlow["executePayment"]>>): void {
  assert.equal(r.hookAgrees, true, "pipeline and hook mirror must agree on the mandate/cap verdict");
  assert.equal(r.event.seq, r.record.seq, "the emitted event's seq must match the record's seq");
}

test("SETTLED: a clean payment settles, agrees with the hook, and updates ENS", async () => {
  const flow = newFlow(parseAmount("100"));
  const r = await flow.executePayment(
    { node: ROOT, merchant: "openai", amount: parseAmount("8"), purpose: "inference" },
    PAY_AT,
  );

  assert.equal(r.record.outcome, "SETTLED");
  assert.equal(r.hook.allowed, true);
  assertInvariants(r);

  // Lock-step ENS projection: the paying node's spentDirect text record moved.
  assert.equal(flow.tree.requireNode(ROOT).mandate.spentDirect, parseAmount("8"));
  assert.equal(flow.ens.getText(ROOT, MANDATE_KEYS.spentDirect), parseAmount("8").toString());
  assert.equal(flow.ens.getMandate(ROOT).spentDirect, parseAmount("8"));
});

test("BLOCKED_MANDATE: an over-budget payment is capped and the hook reverts too", async () => {
  const flow = newFlow(parseAmount("10"));
  const r = await flow.executePayment(
    { node: ROOT, merchant: "openai", amount: parseAmount("15"), purpose: "inference" },
    PAY_AT,
  );

  assert.equal(r.record.outcome, "BLOCKED_MANDATE");
  assert.equal(r.hook.allowed, false);
  assert.equal(r.hook.revert, "SpendCapExceeded");
  assertInvariants(r);
});

test("BLOCKED_SCREENING: sanctioned vendor clears the mandate but live screening blocks it", async () => {
  const flow = newFlow(parseAmount("100"));
  const r = await flow.executePayment(
    { node: ROOT, merchant: "sanctioned-vendor", amount: parseAmount("5"), purpose: "data" },
    PAY_AT,
  );

  assert.equal(r.record.outcome, "BLOCKED_SCREENING");
  // The cap itself was satisfied, so the on-chain hook (which does NOT model
  // screening) correctly allows — and mandateVerdictAgrees classifies that as
  // agreement.
  assert.equal(r.hook.allowed, true);
  assertInvariants(r);
});

test("DENIED_IDENTITY: an expired machine identity is denied before funds move", async () => {
  const flow = newFlow(parseAmount("100"));
  flow.tree.delegate(
    ROOT,
    "ghost",
    { budget: parseAmount("5"), expiry: EXPIRY },
    { identityStatus: "expired" },
  );
  flow.syncEns();

  const r = await flow.executePayment(
    { node: "ghost.alice.eth", merchant: "arxiv", amount: parseAmount("3"), purpose: "scrape" },
    PAY_AT,
  );

  assert.equal(r.record.outcome, "DENIED_IDENTITY");
  // The amount fits the cap and nothing is revoked/expired at the mandate level,
  // so the hook allows; identity is an off-chain-only stage.
  assert.equal(r.hook.allowed, true);
  assertInvariants(r);
});

test("REVOKED: a revoked ancestor disables the descendant and the hook reverts", async () => {
  const flow = newFlow(parseAmount("100"));
  flow.tree.delegate(ROOT, "researcher", {
    budget: parseAmount("30"),
    expiry: EXPIRY,
  });
  flow.tree.revoke(ROOT); // revoke the ANCESTOR
  flow.syncEns();

  const r = await flow.executePayment(
    { node: "researcher.alice.eth", merchant: "arxiv", amount: parseAmount("5"), purpose: "scrape" },
    PAY_AT,
  );

  assert.equal(r.record.outcome, "REVOKED");
  assert.equal(r.hook.allowed, false);
  assert.equal(r.hook.revert, "MandateRevoked");
  assertInvariants(r);
});
