import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// namehash-like ids — off-chain these are ENS namehashes of the dotted names.
const ALICE = ethers.id("alice.eth");
const RESEARCHER = ethers.id("researcher.alice.eth");
const SCRAPER = ethers.id("scraper.researcher.alice.eth");

const USDC = (n: number) => BigInt(n) * 1_000_000n; // 6 decimals

describe("MandateRegistry — attenuating delegation tree", () => {
  async function deploy() {
    const [owner, arxiv, openai, sanctioned] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("MandateRegistry");
    const registry = await Registry.deploy();
    const expiry = (await time.latest()) + 30 * 24 * 3600;
    return { registry, owner, arxiv, openai, sanctioned, expiry };
  }

  it("funds a root and reports available = budget", async () => {
    const { registry, owner, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []); // any merchant
    expect(await registry.available(ALICE)).to.equal(USDC(100));
    expect(await registry.reserved(ALICE)).to.equal(0n);
  });

  it("ACCEPTS a delegation that narrows budget/expiry/merchants", async () => {
    const { registry, owner, arxiv, openai, sanctioned, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);

    await expect(
      registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
        arxiv.address,
        openai.address,
        sanctioned.address,
      ])
    ).to.emit(registry, "Delegated");

    // parent's available shrinks by the reserved child budget.
    expect(await registry.reserved(ALICE)).to.equal(USDC(30));
    expect(await registry.available(ALICE)).to.equal(USDC(70));
    expect(await registry.available(RESEARCHER)).to.equal(USDC(30));

    // grandchild narrows further to a subset of merchants — accepted.
    await expect(
      registry.delegate(RESEARCHER, SCRAPER, owner.address, USDC(10), expiry, [
        arxiv.address,
      ])
    ).to.emit(registry, "Delegated");
    expect(await registry.available(SCRAPER)).to.equal(USDC(10));
  });

  it("REJECTS a delegation whose budget exceeds parent available", async () => {
    const { registry, owner, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, []);

    // researcher only has 30 available; delegating 40 must revert.
    await expect(
      registry.delegate(RESEARCHER, SCRAPER, owner.address, USDC(40), expiry, [])
    ).to.be.revertedWithCustomError(registry, "BudgetExceedsAvailable");
  });

  it("REJECTS a delegation whose expiry exceeds parent expiry", async () => {
    const { registry, owner, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await expect(
      registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry + 1, [])
    ).to.be.revertedWithCustomError(registry, "ExpiryExceedsParent");
  });

  it("REJECTS a merchant not in the parent's allowlist (no broadening)", async () => {
    const { registry, owner, arxiv, openai, sanctioned, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
      openai.address,
    ]);
    // scraper tries to add `sanctioned`, not allowed by researcher — reject.
    await expect(
      registry.delegate(RESEARCHER, SCRAPER, owner.address, USDC(10), expiry, [
        arxiv.address,
        sanctioned.address,
      ])
    ).to.be.revertedWithCustomError(registry, "MerchantsNotSubset");
  });

  it("REJECTS a restricted parent delegating an 'any-merchant' child", async () => {
    const { registry, owner, arxiv, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, [arxiv.address]);
    // empty merchant list = "any", which broadens the restricted parent — reject.
    await expect(
      registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [])
    ).to.be.revertedWithCustomError(registry, "MerchantsNotSubset");
  });

  it("allows a spend within budget and to an allowed merchant, updating available", async () => {
    const { registry, owner, arxiv, openai, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
      openai.address,
    ]);

    await expect(registry.spend(RESEARCHER, openai.address, USDC(8)))
      .to.emit(registry, "Spent")
      .withArgs(RESEARCHER, openai.address, USDC(8), USDC(8));

    expect(await registry.available(RESEARCHER)).to.equal(USDC(22));
  });

  it("REVERTS an over-budget spend", async () => {
    const { registry, owner, arxiv, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, []);
    await registry.delegate(RESEARCHER, SCRAPER, owner.address, USDC(10), expiry, [
      arxiv.address,
    ]);
    // scraper only has 10 available; spending 15 must revert.
    await expect(
      registry.spend(SCRAPER, arxiv.address, USDC(15))
    ).to.be.revertedWithCustomError(registry, "OverBudget");
  });

  it("REVERTS a spend to a merchant not on the node's allowlist", async () => {
    const { registry, owner, arxiv, sanctioned, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
    ]);
    await expect(
      registry.spend(RESEARCHER, sanctioned.address, USDC(1))
    ).to.be.revertedWithCustomError(registry, "MerchantNotAllowed");
  });

  it("REVERTS a spend after revocation, cascading to descendants", async () => {
    const { registry, owner, arxiv, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, []);
    await registry.delegate(RESEARCHER, SCRAPER, owner.address, USDC(10), expiry, [
      arxiv.address,
    ]);

    // revoke the middle node; the grandchild must now fail via ancestor check.
    await expect(registry.revoke(RESEARCHER)).to.emit(registry, "Revoked");
    await expect(
      registry.spend(SCRAPER, arxiv.address, USDC(1))
    ).to.be.revertedWithCustomError(registry, "RevokedInChain");
    // and the revoked node itself cannot spend either.
    await expect(
      registry.spend(RESEARCHER, arxiv.address, USDC(1))
    ).to.be.revertedWithCustomError(registry, "RevokedInChain");
  });

  it("REVERTS a spend after expiry (self or ancestor)", async () => {
    const { registry, owner, arxiv, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
    ]);
    await time.increaseTo(expiry + 1);
    await expect(
      registry.spend(RESEARCHER, arxiv.address, USDC(1))
    ).to.be.revertedWithCustomError(registry, "ExpiredInChain");
  });

  it("gates fund/delegate/spend by authorization", async () => {
    const { registry, owner, arxiv, expiry } = await deploy();
    const other = arxiv; // reuse a non-owner signer
    // non-owner cannot fund a root.
    await expect(
      registry.connect(other).fund(ALICE, other.address, USDC(100), expiry, [])
    ).to.be.revertedWithCustomError(registry, "NotAuthorized");

    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    // non-controller cannot delegate from ALICE.
    await expect(
      registry.connect(other).delegate(ALICE, RESEARCHER, other.address, USDC(1), expiry, [])
    ).to.be.revertedWithCustomError(registry, "NotAuthorized");
  });
});

// ---------------------------------------------------------------------------
// Non-reverting view surface (canSpend / reserved / available / isMerchantAllowed)
//
// These read-only views are exactly what the off-chain SpendCapHook mirrors
// (packages/hook — see DESIGN.md §4/§5). In particular `canSpend` must NEVER
// revert: it returns a `(bool ok, bytes32 reason)` pair whose reason codes are
// LOAD-BEARING — the hook branches on them to accept/deny a swap and to render
// the human-readable denial. So each code ('UNKNOWN_NODE', 'REVOKED',
// 'EXPIRED', 'OVER_BUDGET', 'MERCHANT_NOT_ALLOWED') is asserted verbatim here.
// ---------------------------------------------------------------------------
describe("MandateRegistry — non-reverting views (SpendCapHook surface)", () => {
  async function deploy() {
    const [owner, arxiv, openai, sanctioned] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("MandateRegistry");
    const registry = await Registry.deploy();
    const expiry = (await time.latest()) + 30 * 24 * 3600;
    return { registry, owner, arxiv, openai, sanctioned, expiry };
  }

  // bytes32(0) — the reason returned alongside ok === true.
  const NO_REASON = ethers.ZeroHash;
  // Solidity `bytes32("STR")` == a right-zero-padded UTF-8 string, which is
  // exactly what ethers' encodeBytes32String produces. Keep these in lock-step
  // with the string literals in MandateRegistry.canSpend / the off-chain hook.
  const reason = (code: string) => ethers.encodeBytes32String(code);

  it("canSpend returns (true, bytes32(0)) for a valid spend", async () => {
    const { registry, owner, arxiv, openai, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
      openai.address,
    ]);

    const [ok, why] = await registry.canSpend(RESEARCHER, openai.address, USDC(8));
    expect(ok).to.equal(true);
    expect(why).to.equal(NO_REASON);
  });

  it("canSpend reports 'UNKNOWN_NODE' for a missing node WITHOUT reverting", async () => {
    const { registry, openai } = await deploy();
    // No fund/delegate at all — the node does not exist.
    const [ok, why] = await registry.canSpend(RESEARCHER, openai.address, USDC(1));
    expect(ok).to.equal(false);
    expect(why).to.equal(reason("UNKNOWN_NODE"));
  });

  it("canSpend reports 'REVOKED' for a self-revoked node and a revoked ancestor", async () => {
    const { registry, owner, arxiv, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, []);
    await registry.delegate(RESEARCHER, SCRAPER, owner.address, USDC(10), expiry, [
      arxiv.address,
    ]);

    // Revoke the middle node: it and its descendant both read as REVOKED.
    await registry.revoke(RESEARCHER);

    const [selfOk, selfWhy] = await registry.canSpend(RESEARCHER, arxiv.address, USDC(1));
    expect(selfOk).to.equal(false);
    expect(selfWhy).to.equal(reason("REVOKED"));

    // Cascading revocation: the grandchild is blocked purely by the ancestor.
    const [descOk, descWhy] = await registry.canSpend(SCRAPER, arxiv.address, USDC(1));
    expect(descOk).to.equal(false);
    expect(descWhy).to.equal(reason("REVOKED"));
  });

  it("canSpend reports 'EXPIRED' once the mandate expiry has passed", async () => {
    const { registry, owner, arxiv, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
    ]);

    // Still valid just before expiry.
    let [ok, why] = await registry.canSpend(RESEARCHER, arxiv.address, USDC(1));
    expect(ok).to.equal(true);
    expect(why).to.equal(NO_REASON);

    // Advance EVM time past expiry; canSpend must now say EXPIRED (not revert).
    await time.increaseTo(expiry + 1);
    [ok, why] = await registry.canSpend(RESEARCHER, arxiv.address, USDC(1));
    expect(ok).to.equal(false);
    expect(why).to.equal(reason("EXPIRED"));
  });

  it("canSpend reports 'OVER_BUDGET' when amount exceeds available", async () => {
    const { registry, owner, arxiv, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
    ]);

    // Exactly at the limit is fine; one unit over is OVER_BUDGET.
    let [ok, why] = await registry.canSpend(RESEARCHER, arxiv.address, USDC(30));
    expect(ok).to.equal(true);
    expect(why).to.equal(NO_REASON);

    [ok, why] = await registry.canSpend(RESEARCHER, arxiv.address, USDC(30) + 1n);
    expect(ok).to.equal(false);
    expect(why).to.equal(reason("OVER_BUDGET"));
  });

  it("canSpend reports 'MERCHANT_NOT_ALLOWED' for a restricted node + off-list merchant", async () => {
    const { registry, owner, arxiv, sanctioned, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    // researcher is restricted to arxiv only.
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
    ]);

    const [ok, why] = await registry.canSpend(RESEARCHER, sanctioned.address, USDC(1));
    expect(ok).to.equal(false);
    expect(why).to.equal(reason("MERCHANT_NOT_ALLOWED"));
  });

  it("checks reason ORDERING: revoked wins over expired, expired over budget", async () => {
    const { registry, owner, arxiv, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
    ]);

    // Over-budget AND expired AND revoked all at once — revoked must surface.
    await registry.revoke(RESEARCHER);
    await time.increaseTo(expiry + 1);
    const [ok, why] = await registry.canSpend(RESEARCHER, arxiv.address, USDC(999));
    expect(ok).to.equal(false);
    expect(why).to.equal(reason("REVOKED"));
  });

  it("reserved(node) == Σ children budgets, and available == budget - spentDirect - reserved", async () => {
    const { registry, owner, arxiv, openai, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);

    // Two sibling delegations off the root: reserved accumulates their budgets.
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
      openai.address,
    ]);
    await registry.delegate(ALICE, SCRAPER, owner.address, USDC(25), expiry, []);

    // reserved(root) is the running sum of both children's budgets.
    expect(await registry.reserved(ALICE)).to.equal(USDC(55));
    // available(root) = 100 - spentDirect(0) - reserved(55).
    expect(await registry.available(ALICE)).to.equal(USDC(45));

    // Spend directly from the root; reserved is unchanged, available drops by
    // the spent amount => available == budget - spentDirect - reserved.
    await registry.spend(ALICE, openai.address, USDC(5));
    expect(await registry.reserved(ALICE)).to.equal(USDC(55));
    expect(await registry.available(ALICE)).to.equal(USDC(40)); // 100 - 5 - 55

    // A child with no delegations of its own reserves nothing.
    expect(await registry.reserved(RESEARCHER)).to.equal(0n);
    // And its available reflects its own spend/reserve accounting.
    await registry.spend(RESEARCHER, arxiv.address, USDC(8));
    expect(await registry.available(RESEARCHER)).to.equal(USDC(22)); // 30 - 8 - 0
  });

  it("isMerchantAllowed: true for an 'any' (unrestricted) node, correct under a restricted allowlist", async () => {
    const { registry, owner, arxiv, openai, sanctioned, expiry } = await deploy();
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []); // any merchant

    // Unrestricted root: every merchant (even a random address) is allowed.
    expect(await registry.isMerchantAllowed(ALICE, arxiv.address)).to.equal(true);
    expect(await registry.isMerchantAllowed(ALICE, sanctioned.address)).to.equal(true);

    // Restricted child: only listed merchants pass, others do not.
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
      openai.address,
    ]);
    expect(await registry.isMerchantAllowed(RESEARCHER, arxiv.address)).to.equal(true);
    expect(await registry.isMerchantAllowed(RESEARCHER, openai.address)).to.equal(true);
    expect(await registry.isMerchantAllowed(RESEARCHER, sanctioned.address)).to.equal(false);

    // Non-existent node returns false (never reverts).
    expect(await registry.isMerchantAllowed(SCRAPER, arxiv.address)).to.equal(false);
  });
});
