import { test } from "node:test";
import assert from "node:assert/strict";
import { DelegationTree } from "./tree";
import { pay, type PaymentAdapters } from "./payment";
import type {
  IdentityCheckContext,
  ScreeningRequest,
  SettlementRequest,
} from "./types";

const FAR = 4_000_000_000;

/** Deterministic, offline adapters used only by these unit tests. */
function testAdapters(): PaymentAdapters {
  return {
    identity: {
      async verify(ctx: IdentityCheckContext) {
        const chainVerified =
          ctx.node.identityStatus === "verified" &&
          ctx.ancestors.every((a) => a.identityStatus === "verified");
        return chainVerified
          ? { ok: true }
          : { ok: false, reason: `identity ${ctx.node.identityStatus}` };
      },
    },
    screening: {
      async screen(req: ScreeningRequest) {
        const blocked = req.merchant.startsWith("sanctioned");
        return blocked
          ? { approved: false, reason: "on sanctions list", reference: "SCR-TEST" }
          : { approved: true, reference: "SCR-TEST" };
      },
    },
    settlement: {
      async settle(req: SettlementRequest) {
        return {
          settled: true,
          swapped: req.payerToken !== req.merchantToken,
          fromToken: req.payerToken,
          toToken: req.merchantToken,
          amountIn: req.amount,
          amountOut: req.amount,
          reference: "TX-TEST",
        };
      },
    },
  };
}

function tree(): DelegationTree {
  const t = new DelegationTree();
  t.fundRoot({ principal: "alice", rootName: "alice.eth", mandate: { budget: 100_000000n, expiry: FAR } });
  t.delegate("alice.eth", "researcher", {
    budget: 30_000000n,
    allowedMerchants: ["arxiv", "openai"],
    expiry: FAR,
  });
  t.delegate("researcher.alice.eth", "scraper", {
    budget: 10_000000n,
    allowedMerchants: ["arxiv"],
    expiry: FAR,
  });
  return t;
}

test("SETTLED happy path increments spentDirect and propagates to parent available", async () => {
  const t = tree();
  const before = t.available("researcher.alice.eth");
  const rec = await pay(
    t,
    { node: "researcher.alice.eth", merchant: "openai", amount: 8_000000n, payerToken: "USDC", merchantToken: "OPENAI" },
    testAdapters(),
    { now: 1000 },
  );
  assert.equal(rec.outcome, "SETTLED");
  assert.equal(rec.settlement?.swapped, true);
  assert.equal(t.getNode("researcher.alice.eth")?.mandate.spentDirect, 8_000000n);
  assert.equal(t.available("researcher.alice.eth"), before - 8_000000n);
});

test("over-budget payment is BLOCKED_MANDATE", async () => {
  const t = tree();
  const rec = await pay(
    t,
    { node: "scraper.researcher.alice.eth", merchant: "arxiv", amount: 15_000000n },
    testAdapters(),
    { now: 1000 },
  );
  assert.equal(rec.outcome, "BLOCKED_MANDATE");
});

test("merchant outside allowlist is BLOCKED_MANDATE", async () => {
  const t = tree();
  const rec = await pay(
    t,
    { node: "scraper.researcher.alice.eth", merchant: "openai", amount: 1_000000n },
    testAdapters(),
    { now: 1000 },
  );
  assert.equal(rec.outcome, "BLOCKED_MANDATE");
});

test("sanctioned merchant that passes the mandate is BLOCKED_SCREENING", async () => {
  // The paying node must first PASS the mandate stage (merchant allowlist) for
  // the payment to reach live screening. Root allows any merchant, so this
  // isolates the screening stage. In the demo the researcher's allowlist
  // deliberately includes "sanctioned-vendor" for the same reason.
  const t = tree();
  const rec = await pay(
    t,
    { node: "alice.eth", merchant: "sanctioned-vendor", amount: 5_000000n },
    testAdapters(),
    { now: 1000 },
  );
  assert.equal(rec.outcome, "BLOCKED_SCREENING");
});

test("unverified identity is DENIED_IDENTITY", async () => {
  const t = tree();
  t.delegate("alice.eth", "ghost", { budget: 5_000000n, expiry: FAR }, { identityStatus: "expired" });
  const rec = await pay(
    t,
    { node: "ghost.alice.eth", merchant: "arxiv", amount: 1_000000n },
    testAdapters(),
    { now: 1000 },
  );
  assert.equal(rec.outcome, "DENIED_IDENTITY");
});

test("ancestor revocation makes descendant payments REVOKED", async () => {
  const t = tree();
  t.revoke("researcher.alice.eth");
  const rec = await pay(
    t,
    { node: "scraper.researcher.alice.eth", merchant: "arxiv", amount: 1_000000n },
    testAdapters(),
    { now: 1000 },
  );
  assert.equal(rec.outcome, "REVOKED");
});

test("expired mandate is BLOCKED_MANDATE", async () => {
  const t = new DelegationTree();
  t.fundRoot({ principal: "alice", rootName: "alice.eth", mandate: { budget: 100_000000n, expiry: 1500 } });
  const rec = await pay(
    t,
    { node: "alice.eth", merchant: "arxiv", amount: 1_000000n },
    testAdapters(),
    { now: 2000 }, // now > expiry
  );
  assert.equal(rec.outcome, "BLOCKED_MANDATE");
});
