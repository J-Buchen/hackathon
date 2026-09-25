import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

/**
 * Hardhat configuration for the Allowance on-chain enforcement package.
 *
 * This workspace is intentionally CommonJS (no "type":"module" in its
 * package.json) to stay compatible with Hardhat 2 + ts-node, even though the
 * rest of the monorepo is ESM. It is NOT part of the root `tsc -b` typecheck.
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    sources: "contracts",
    tests: "test",
    cache: "cache",
    artifacts: "artifacts",
  },
};

export default config;
