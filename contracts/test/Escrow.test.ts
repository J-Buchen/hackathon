import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const WINDOW = 3600; // 1 hour clawback window

describe("Escrow — settlement with post-screening clawback window", () => {
  async function deploy() {
    const [depositor, merchant, screener, stranger] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("USD Coin", "USDC", 6);
    const Escrow = await ethers.getContractFactory("Escrow");
    const escrow = await Escrow.deploy();

    await token.mint(depositor.address, USDC(1000));
    await token
      .connect(depositor)
      .approve(await escrow.getAddress(), USDC(1000));

    return { token, escrow, depositor, merchant, screener, stranger };
  }

  async function makeDeposit() {
    const ctx = await deploy();
    const { token, escrow, depositor, merchant, screener } = ctx;
    const tx = await escrow
      .connect(depositor)
      .deposit(
        await token.getAddress(),
        merchant.address,
        screener.address,
        USDC(8),
        WINDOW
      );
    await expect(tx).to.emit(escrow, "Deposited");
    return { ...ctx, id: 1n };
  }

  it("holds funds in escrow on deposit", async () => {
    const { token, escrow } = await makeDeposit();
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(USDC(8));
  });

  it("releases to the merchant after the window elapses", async () => {
    const { token, escrow, merchant, id } = await makeDeposit();
    // too early to release.
    await expect(escrow.release(id)).to.be.revertedWithCustomError(
      escrow,
      "TooEarly"
    );

    await time.increase(WINDOW + 1);
    await expect(escrow.release(id))
      .to.emit(escrow, "Released")
      .withArgs(id, merchant.address, USDC(8));
    expect(await token.balanceOf(merchant.address)).to.equal(USDC(8));
    expect(await escrow.statusOf(id)).to.equal(2); // Released
  });

  it("lets the screener claw funds back before release", async () => {
    const { token, escrow, screener, depositor, merchant, id } =
      await makeDeposit();
    await expect(escrow.connect(screener).clawback(id))
      .to.emit(escrow, "Clawed")
      .withArgs(id, screener.address, USDC(8));
    // funds returned to depositor, merchant gets nothing.
    expect(await token.balanceOf(merchant.address)).to.equal(0n);
    expect(await token.balanceOf(depositor.address)).to.equal(USDC(1000));
    expect(await escrow.statusOf(id)).to.equal(3); // Clawed
  });

  it("rejects clawback from a non-screener", async () => {
    const { escrow, stranger, id } = await makeDeposit();
    await expect(
      escrow.connect(stranger).clawback(id)
    ).to.be.revertedWithCustomError(escrow, "NotScreener");
  });

  it("cannot clawback after release, nor release twice", async () => {
    const { escrow, screener, id } = await makeDeposit();
    await time.increase(WINDOW + 1);
    await escrow.release(id);
    await expect(
      escrow.connect(screener).clawback(id)
    ).to.be.revertedWithCustomError(escrow, "NotPending");
    await expect(escrow.release(id)).to.be.revertedWithCustomError(
      escrow,
      "NotPending"
    );
  });
});
