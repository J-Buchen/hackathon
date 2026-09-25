/**
 * Focused adapter tests (offline, deterministic). Run: `npm -w @allowance/adapters test`.
 * Covers the two behaviors called out in the brief — Intercepta screening block
 * and 1inch Aqua swap math — plus a few high-value guards.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AgentNode, IdentityCheckContext, SettlementRequest, Snapshot } from "@allowance/core";
import { DelegationTree, pay, toSnapshot, parseAmount } from "@allowance/core";

import {
  MockScreeningService,
  MockSettlementService,
  MockIdentityGate,
  MockPrincipalVerifier,
  EnsRegistry,
  SpendCapHook,
  MockSuiEscrow,
  MultiBaasDashboard,
  applySwapRate,
  createMockAdapters,
} from "./index";

function node(name: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    name,
    parent: over.parent ?? null,
    identityStatus: over.identityStatus ?? "verified",
    mandate: over.mandate ?? {
      budget: 10_000000n,
      spentDirect: 0n,
      expiry: 9_999_999_999,
      revoked: false,
    },
  };
}

/* ---- Intercepta screening ---- */

test("screening BLOCKS the sanctioned vendor and returns a reference", async () => {
  const svc = new MockScreeningService();
  const r = await svc.screen({ node: "researcher.alice.eth", merchant: "sanctioned-vendor", amount: 5_000000n });
  assert.equal(r.approved, false);
  assert.ok(r.reference, "a case reference is present on the blocked path");
});

test("screening blocks any 'sanctioned*' prefix and approves normal merchants", async () => {
  const svc = new MockScreeningService();
  assert.equal((await svc.screen({ node: "n", merchant: "sanctioned-xyz", amount: 1n })).approved, false);
  const ok = await svc.screen({ node: "n", merchant: "openai", amount: 1n });
  assert.equal(ok.approved, true);
  assert.ok(ok.reference);
});

/* ---- 1inch Aqua swap math ---- */

test("aqua swap math: 1:1 rate echoes the amount, no swap when tokens match", async () => {
  const svc = new MockSettlementService();
  const req: SettlementRequest = {
    node: "researcher.alice.eth",
    merchant: "openai",
    amount: 8_000000n,
    payerToken: "USDC",
    merchantToken: "USDC",
  };
  const r = await svc.settle(req);
  assert.equal(r.settled, true);
  assert.equal(r.swapped, false);
  assert.equal(r.amountIn, 8_000000n);
  assert.equal(r.amountOut, 8_000000n);
  assert.ok(r.reference?.startsWith("0x"));
});

test("aqua swap math: cross-token settlement swaps and applies the quoted rate", async () => {
  const svc = new MockSettlementService({ swapRate: 1.02 });
  const r = await svc.settle({
    node: "researcher.alice.eth",
    merchant: "openai",
    amount: 8_000000n,
    payerToken: "USDC",
    merchantToken: "DAI",
  });
  assert.equal(r.swapped, true);
  assert.equal(r.amountIn, 8_000000n);
  assert.equal(r.amountOut, applySwapRate(8_000000n, 1.02));
  assert.equal(r.amountOut, 8_160000n);
});

/* ---- World ID for Agents ---- */

test("identity gate denies an expired node and denies ghost.* impersonators", async () => {
  const gate = new MockIdentityGate();
  const expired: IdentityCheckContext = { node: node("ghost.alice.eth", { identityStatus: "expired", parent: "alice.eth" }), ancestors: [node("alice.eth")] };
  assert.equal((await gate.verify(expired)).ok, false);

  const good: IdentityCheckContext = { node: node("researcher.alice.eth", { parent: "alice.eth" }), ancestors: [node("alice.eth")] };
  assert.equal((await gate.verify(good)).ok, true);
});

test("identity gate fails a node whose ancestor is not verified", async () => {
  const gate = new MockIdentityGate();
  const ctx: IdentityCheckContext = {
    node: node("scraper.researcher.alice.eth", { parent: "researcher.alice.eth" }),
    ancestors: [node("researcher.alice.eth", { identityStatus: "none" }), node("alice.eth")],
  };
  const r = await gate.verify(ctx);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /ancestor/);
});

/* ---- World IDKit ---- */

test("principal verifier passes normal proof, fails on the fail signal", async () => {
  const v = new MockPrincipalVerifier();
  assert.equal((await v.verify({ action: "fund-root", signal: "alice.eth" })).verified, true);
  assert.equal((await v.verify({ action: "fund-root", signal: "fail" })).verified, false);
});

/* ---- ENSv2 registry roundtrip ---- */

test("ens registry stores and decodes a mandate via text records", () => {
  const ens = new EnsRegistry();
  ens.register("alice.eth", "alice");
  const child = ens.registerSubname("alice.eth", "researcher");
  assert.equal(child, "researcher.alice.eth");
  assert.equal(ens.resolveParent(child), "alice.eth");
  ens.setMandate(child, {
    budget: 30_000000n,
    allowedMerchants: ["arxiv", "openai"],
    expiry: 1792929600,
  });
  const m = ens.getMandate(child);
  assert.equal(m.budget, 30_000000n);
  assert.deepEqual(m.allowedMerchants, ["arxiv", "openai"]);
  assert.equal(m.allowedPurposes, undefined); // unrestricted -> "*"
  assert.equal(m.revoked, false);
});

/* ---- Uniswap v4 hook mirror ---- */

test("spend-cap hook reverts SpendCapExceeded and allows within cap", () => {
  const hook = new SpendCapHook();
  assert.deepEqual(
    hook.beforeSwap({ node: "scraper.x", amount: 15_000000n, available: 10_000000n, revoked: false, expired: false }),
    { allowed: false, revert: "SpendCapExceeded", reason: 'amount 15000000 exceeds spend cap 10000000 for "scraper.x"' },
  );
  assert.equal(hook.beforeSwap({ node: "n", amount: 5n, available: 10n, revoked: false, expired: false }).allowed, true);
  assert.equal(hook.beforeSwap({ node: "n", amount: 1n, available: 10n, revoked: true, expired: false }).revert, "MandateRevoked");
});

/* ---- Sui escrow clawback window ---- */

test("sui escrow allows clawback in-window and rejects it after the window", () => {
  const esc = new MockSuiEscrow();
  const lock = esc.lock({ node: "n", merchant: "m", amount: 5n, token: "USDC", now: 1000, windowSeconds: 100 });
  assert.equal(lock.status, "LOCKED");
  const clawed = esc.clawback(lock.id, 1050);
  assert.equal(clawed.status, "CLAWED_BACK");

  const lock2 = esc.lock({ node: "n", merchant: "m", amount: 5n, token: "USDC", now: 1000, windowSeconds: 100 });
  assert.throws(() => esc.clawback(lock2.id, 2000), /window closed/);
});

/* ---- bundle factory ---- */

test("createMockAdapters returns a usable PaymentAdapters bundle", async () => {
  const a = createMockAdapters();
  assert.ok(a.identity && a.screening && a.settlement);
  const r = await a.screening.screen({ node: "n", merchant: "sanctioned-vendor", amount: 1n });
  assert.equal(r.approved, false);
});

/* ---- Curvegrid MultiBaas dashboard over a real Snapshot ---- */

const FAR = 4_000_000_000;
const NOW = 1_700_000_000;

/**
 * Build a representative snapshot the way the demo does: fund a root, delegate,
 * settle one payment and get one screening-blocked payment, then revoke the
 * delegate. Exercises FUND / DELEGATE / PAYMENT(SETTLED) / PAYMENT(BLOCKED) /
 * REVOKE events plus non-zero spentDirect and reserved balances.
 */
async function buildDemoSnapshot(): Promise<Snapshot> {
  const tree = new DelegationTree();
  const adapters = createMockAdapters();
  tree.fundRoot({
    principal: "alice",
    rootName: "alice.eth",
    mandate: { budget: parseAmount("100"), expiry: FAR },
  });
  tree.delegate("alice.eth", "researcher", {
    budget: parseAmount("30"),
    allowedMerchants: ["arxiv", "openai", "sanctioned-vendor"],
    expiry: FAR,
  });
  // SETTLED: researcher pays openai 8.
  await pay(tree, { node: "researcher.alice.eth", merchant: "openai", amount: parseAmount("8") }, adapters, { now: NOW });
  // BLOCKED_SCREENING: researcher pays a sanctioned vendor 5 (mandate allows it).
  await pay(tree, { node: "researcher.alice.eth", merchant: "sanctioned-vendor", amount: parseAmount("5") }, adapters, { now: NOW });
  tree.revoke("researcher.alice.eth");
  return toSnapshot(tree, { asOf: NOW });
}

test("dashboard totals: root budget, Σ spentDirect, and settled vs blocked counts", async () => {
  const snap = await buildDemoSnapshot();
  const t = new MultiBaasDashboard(snap.decimals).totals(snap);

  assert.equal(t.nodeCount, 2);
  assert.equal(t.rootBudget, parseAmount("100").toString());
  assert.equal(t.rootBudgetHuman, "100.000000");
  // Σ spentDirect across the tree = researcher's 8 (root spent nothing directly).
  assert.equal(t.totalSpent, parseAmount("8").toString());
  assert.equal(t.totalSpentHuman, "8.000000");
  assert.equal(t.paymentCount, 2);
  assert.equal(t.settledCount, 1);
  assert.equal(t.blockedCount, 1);
});

test("dashboard spend tree: depth, utilization, and child names", async () => {
  const snap = await buildDemoSnapshot();
  const tree = new MultiBaasDashboard(snap.decimals).toSpendTree(snap);

  const root = tree.find((n) => n.name === "alice.eth")!;
  const researcher = tree.find((n) => n.name === "researcher.alice.eth")!;

  assert.equal(root.depth, 0);
  assert.equal(researcher.depth, 1);
  assert.deepEqual(root.childNames, ["researcher.alice.eth"]);
  assert.deepEqual(researcher.childNames, []);

  // root utilization = (spent 0 + reserved 30) / budget 100 = 0.3
  assert.equal(root.utilization, 0.3);
  // researcher utilization = (spent 8 + reserved 0) / budget 30, rounded 4dp.
  assert.equal(researcher.utilization, Math.round((8 / 30) * 10000) / 10000);
  assert.equal(researcher.utilization, 0.2667);
});

test("dashboard spend tree: budget=0 yields utilization 0 (no divide-by-zero)", () => {
  // A hand-built snapshot with a zero-budget node — the guard branch.
  const snap: Snapshot = {
    asOf: NOW,
    currency: "USDC",
    decimals: 6,
    principal: { name: "alice", verified: true },
    nodes: [
      {
        name: "alice.eth",
        parent: null,
        identityStatus: "verified",
        mandate: {
          budget: "0",
          spentDirect: "0",
          reserved: "0",
          available: "0",
          allowedMerchants: null,
          allowedPurposes: null,
          expiry: FAR,
          revoked: false,
        },
      },
    ],
    events: [],
  };
  const [vm] = new MultiBaasDashboard(6).toSpendTree(snap);
  assert.equal(vm!.utilization, 0);
});

test("dashboard chain reader: settled->Settled, blocked->Blocked, monotonic blocks", async () => {
  const snap = await buildDemoSnapshot();
  const activity = new MultiBaasDashboard(snap.decimals).readChainActivity(snap);

  assert.equal(activity.length, snap.events.length);

  // Both PAYMENT events map by result: settled -> Settled, failed -> Blocked.
  const payments = activity.filter((a) => a.event === "Settled" || a.event === "Blocked");
  assert.equal(payments.filter((a) => a.event === "Settled").length, 1);
  assert.equal(payments.filter((a) => a.event === "Blocked").length, 1);

  // FUND/DELEGATE/REVOKE map to their contract-event names.
  assert.equal(activity[0]!.event, "Funded");
  assert.ok(activity.some((a) => a.event === "Delegated"));
  assert.ok(activity.some((a) => a.event === "Revoked"));

  // Block numbers are strictly monotonic.
  for (let i = 1; i < activity.length; i++) {
    assert.ok(activity[i]!.blockNumber > activity[i - 1]!.blockNumber, "block numbers must increase");
  }
});

test("dashboard summarize lists revoked node names", async () => {
  const snap = await buildDemoSnapshot();
  const summary = new MultiBaasDashboard(snap.decimals).summarize(snap);
  assert.match(summary, /Revoked node\(s\): researcher\.alice\.eth\./);
});

/* ---- 1inch Aqua swap-rate rounding edge cases ---- */

test("applySwapRate: rate 1 is the identity; rate 0.999999 truncates toward zero", () => {
  // Identity.
  assert.equal(applySwapRate(8_000000n, 1), 8_000000n);
  assert.equal(applySwapRate(0n, 1), 0n);

  // rate 0.999999 -> scaled 999999/1e6. Fixed-point bigint division truncates.
  assert.equal(applySwapRate(1_000000n, 0.999999), 999999n);
  // 1 * 999999 / 1_000000 = 0 (floor), proving truncation toward zero.
  assert.equal(applySwapRate(1n, 0.999999), 0n);
});

/* ---- ENSv2 empty-allowlist roundtrip ---- */

test("ens roundtrip: an empty allowedPurposes [] survives as [] (not undefined)", () => {
  const ens = new EnsRegistry();
  ens.register("alice.eth", "alice");
  ens.setMandate("alice.eth", {
    budget: parseAmount("10"),
    allowedPurposes: [], // explicitly empty -> encodes as "" (not the "*" sentinel)
    expiry: FAR,
  });
  const m = ens.getMandate("alice.eth");
  // Empty list is meaningfully different from "any": it must decode back to [].
  assert.deepEqual(m.allowedPurposes, []);
  // allowedMerchants was undefined -> "*" -> undefined ("any merchant").
  assert.equal(m.allowedMerchants, undefined);
});
