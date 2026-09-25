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
