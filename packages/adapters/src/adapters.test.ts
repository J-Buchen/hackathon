/**
 * Focused adapter tests (offline, deterministic). Run: `npm -w @allowance/adapters test`.
 * Covers the two behaviors called out in the brief — Intercepta screening block
 * and 1inch Aqua swap math — plus a few high-value guards.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AgentNode, IdentityCheckContext, SettlementRequest } from "@allowance/core";

import {
  MockScreeningService,
  MockSettlementService,
  MockIdentityGate,
  MockPrincipalVerifier,
  EnsRegistry,
  SpendCapHook,
  MockSuiEscrow,
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
