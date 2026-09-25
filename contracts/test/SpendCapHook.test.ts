import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ALICE = ethers.id("alice.eth");
const RESEARCHER = ethers.id("researcher.alice.eth");
const USDC = (n: number) => BigInt(n) * 1_000_000n;

// A zeroed PoolKey / SwapParams is fine — the hook only reads hookData.
const KEY = {
  currency0: ethers.ZeroAddress,
  currency1: ethers.ZeroAddress,
  fee: 0,
  tickSpacing: 1,
  hooks: ethers.ZeroAddress,
};
const PARAMS = {
  zeroForOne: true,
  amountSpecified: 0,
  sqrtPriceLimitX96: 0,
};

describe("SpendCapHook — Uniswap v4 on-chain cap enforcement", () => {
  async function deploy() {
    // `owner` doubles as the mock PoolManager so it may call beforeSwap.
    const [owner, arxiv, merchant] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("MandateRegistry");
    const registry = await Registry.deploy();
    const Hook = await ethers.getContractFactory("SpendCapHook");
    const hook = await Hook.deploy(await registry.getAddress(), owner.address);

    const expiry = (await time.latest()) + 30 * 24 * 3600;
    await registry.fund(ALICE, owner.address, USDC(100), expiry, []);
    await registry.delegate(ALICE, RESEARCHER, owner.address, USDC(30), expiry, [
      arxiv.address,
      merchant.address,
    ]);
    return { registry, hook, owner, arxiv, merchant, expiry };
  }

  it("allows a swap within the node's remaining cap", async () => {
    const { hook, merchant } = await deploy();
    const data = await hook.encodeHookData(RESEARCHER, merchant.address, USDC(8));
    await expect(hook.beforeSwap(ethers.ZeroAddress, KEY, PARAMS, data)).to.emit(
      hook,
      "SpendCapChecked"
    );
  });

  it("REVERTS a swap that exceeds the node's remaining cap", async () => {
    const { hook, merchant } = await deploy();
    // researcher has 30 available; 40 exceeds it.
    const data = await hook.encodeHookData(RESEARCHER, merchant.address, USDC(40));
    await expect(
      hook.beforeSwap(ethers.ZeroAddress, KEY, PARAMS, data)
    ).to.be.revertedWithCustomError(hook, "SpendCapExceeded");
  });

  it("REVERTS a swap to a non-allowlisted merchant", async () => {
    const { hook, owner } = await deploy();
    // owner is not on researcher's merchant allowlist.
    const data = await hook.encodeHookData(RESEARCHER, owner.address, USDC(1));
    await expect(
      hook.beforeSwap(ethers.ZeroAddress, KEY, PARAMS, data)
    ).to.be.revertedWithCustomError(hook, "SpendCapExceeded");
  });

  it("REVERTS when a swap is attempted after revocation", async () => {
    const { registry, hook, merchant } = await deploy();
    await registry.revoke(RESEARCHER);
    const data = await hook.encodeHookData(RESEARCHER, merchant.address, USDC(1));
    await expect(
      hook.beforeSwap(ethers.ZeroAddress, KEY, PARAMS, data)
    ).to.be.revertedWithCustomError(hook, "SpendCapExceeded");
  });

  it("only the PoolManager may invoke beforeSwap", async () => {
    const { hook, arxiv, merchant } = await deploy();
    const data = await hook.encodeHookData(RESEARCHER, merchant.address, USDC(1));
    await expect(
      hook.connect(arxiv).beforeSwap(ethers.ZeroAddress, KEY, PARAMS, data)
    ).to.be.revertedWithCustomError(hook, "OnlyPoolManager");
  });
});
