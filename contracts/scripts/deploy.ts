import { ethers } from "hardhat";

/**
 * Deploys the Allowance on-chain enforcement stack and wires it into the demo
 * delegation tree from DESIGN.md §8. Run with:
 *
 *   npm -w @allowance/contracts run deploy                 (in-memory hardhat)
 *   npx hardhat run scripts/deploy.ts --network <name>     (a real network)
 *
 * It prints every deployed address plus the seeded tree so the Curvegrid
 * MultiBaas-style dashboard / AI agent can read chain state immediately.
 */

const USDC = (n: number) => BigInt(n) * 1_000_000n; // USDC has 6 decimals

// namehash-like ids — off-chain these are ENS namehashes of the dotted names.
const NAMES = {
  alice: "alice.eth",
  researcher: "researcher.alice.eth",
  scraper: "scraper.researcher.alice.eth",
} as const;
const id = (name: string) => ethers.id(name);

async function main() {
  const [deployer, arxiv, openai, sanctioned] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // 1) Deploy the delegation-tree registry.
  const Registry = await ethers.getContractFactory("MandateRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  console.log("MandateRegistry:", await registry.getAddress());

  // 2) Deploy the Uniswap v4 spend-cap hook (deployer stands in as PoolManager).
  const Hook = await ethers.getContractFactory("SpendCapHook");
  const hook = await Hook.deploy(await registry.getAddress(), deployer.address);
  await hook.waitForDeployment();
  console.log("SpendCapHook:", await hook.getAddress());

  // 3) Deploy the screening escrow + a mock USDC for the settlement rail.
  const Escrow = await ethers.getContractFactory("Escrow");
  const escrow = await Escrow.deploy();
  await escrow.waitForDeployment();
  console.log("Escrow:", await escrow.getAddress());

  const Token = await ethers.getContractFactory("MockERC20");
  const usdc = await Token.deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  console.log("MockERC20 (USDC):", await usdc.getAddress());

  // 4) Seed the demo tree (mirror of DESIGN.md §8 steps a–c).
  // getBlock can return null (e.g. a transient provider hiccup); guard explicitly
  // rather than hiding it behind a non-null bang — the whole seeded expiry math
  // below depends on this timestamp being real.
  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("deploy: could not fetch latest block");
  const now = latest.timestamp;
  const expiry = now + 30 * 24 * 3600;

  await (await registry.fund(id(NAMES.alice), deployer.address, USDC(100), expiry, [])).wait();
  await (
    await registry.delegate(
      id(NAMES.alice),
      id(NAMES.researcher),
      deployer.address,
      USDC(30),
      expiry,
      [arxiv.address, openai.address, sanctioned.address]
    )
  ).wait();
  await (
    await registry.delegate(
      id(NAMES.researcher),
      id(NAMES.scraper),
      deployer.address,
      USDC(10),
      expiry,
      [arxiv.address]
    )
  ).wait();

  console.log("\nSeeded delegation tree:");
  for (const [label, name] of Object.entries(NAMES)) {
    const avail = await registry.available(id(name));
    const reserved = await registry.reserved(id(name));
    console.log(
      `  ${label.padEnd(11)} ${name.padEnd(32)} available=${avail} reserved=${reserved}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
