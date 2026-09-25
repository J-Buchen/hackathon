// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks, PoolKey, SwapParams} from "./interfaces/IHooks.sol";
import {MandateRegistry} from "./MandateRegistry.sol";

/**
 * @title SpendCapHook
 * @notice Uniswap v4-style hook that enforces the Allowance attenuated spend
 *         cap ON-CHAIN, at swap time. This is the Uniswap track: the exact same
 *         attenuation rules enforced by the "allowance/core" package and `MandateRegistry`
 *         are also enforced inside the AMM, so an agent literally cannot swap
 *         (i.e. pay a merchant in a different token) beyond its remaining,
 *         un-revoked, un-expired, merchant-scoped budget.
 *
 *         `beforeSwap` decodes `hookData` into the paying agent node, the
 *         merchant (recipient), and the spend amount, then asks the registry
 *         `canSpend(...)`. If the mandate would be violated the hook REVERTS,
 *         which aborts the swap in the PoolManager.
 *
 * @dev    Against real v4 you would extend `BaseHook` and return the correct
 *         `Hooks.Permissions` (beforeSwap = true). Here we implement the minimal
 *         `IHooks` surface from ./interfaces/IHooks.sol. The `beforeSwap`
 *         selector and struct layout match v4, so this is drop-in.
 *
 *         Note: `beforeSwap` is a view-style check (it does not mutate the
 *         registry). Actual settlement / `spend()` accounting is performed by
 *         the settlement path (off-chain 1inch Aqua adapter or `Escrow`), which
 *         holds the registry controller role. Keeping the hook read-only avoids
 *         granting the PoolManager write access to every agent's mandate.
 */
contract SpendCapHook is IHooks {
    /// @notice The mandate registry this hook enforces against.
    MandateRegistry public immutable registry;

    /// @notice Emitted when a swap is allowed through the cap check.
    event SpendCapChecked(
        bytes32 indexed node,
        address indexed merchant,
        uint256 amount
    );

    /// @notice Reverted from `beforeSwap` when the mandate check fails.
    error SpendCapExceeded(bytes32 node, address merchant, uint256 amount, bytes32 reason);

    /// @notice Reverted when a caller other than the intended manager calls in.
    error OnlyPoolManager();

    /// @notice The (mock) Uniswap v4 PoolManager permitted to invoke callbacks.
    address public immutable poolManager;

    /**
     * @param _registry    the MandateRegistry to enforce against.
     * @param _poolManager the v4 PoolManager address (use the deployer/mock in
     *                      tests). Only this address may call `beforeSwap`.
     */
    constructor(MandateRegistry _registry, address _poolManager) {
        registry = _registry;
        poolManager = _poolManager;
    }

    /// @dev Encodes the payload the swapper must pass as `hookData`.
    function encodeHookData(
        bytes32 node,
        address merchant,
        uint256 amount
    ) external pure returns (bytes memory) {
        return abi.encode(node, merchant, amount);
    }

    /// @inheritdoc IHooks
    function beforeSwap(
        address /* sender */,
        PoolKey calldata /* key */,
        SwapParams calldata /* params */,
        bytes calldata hookData
    ) external override returns (bytes4, int256, uint24) {
        if (msg.sender != poolManager) revert OnlyPoolManager();

        (bytes32 node, address merchant, uint256 amount) = abi.decode(
            hookData,
            (bytes32, address, uint256)
        );

        (bool ok, bytes32 reason) = registry.canSpend(node, merchant, amount);
        if (!ok) revert SpendCapExceeded(node, merchant, amount, reason);

        emit SpendCapChecked(node, merchant, amount);

        // selector, zero BeforeSwapDelta, zero dynamic-fee override.
        return (IHooks.beforeSwap.selector, int256(0), uint24(0));
    }
}
