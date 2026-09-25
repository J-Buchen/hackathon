// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Minimal Uniswap v4 hook surface
 * @notice A trimmed-down copy of the pieces of Uniswap v4's `IHooks` /
 *         `IPoolManager` types that our `SpendCapHook` actually needs.
 *
 *         In production you would import these from
 *         `@uniswap/v4-core/src/interfaces/IHooks.sol` and extend
 *         `@uniswap/v4-periphery/src/base/hooks/BaseHook.sol`. The full v4
 *         periphery is heavy (permit2, pool manager, currency library, etc.),
 *         so for the hackathon build we declare the minimal ABI-compatible
 *         subset here and enforce the attenuated spend cap against
 *         `MandateRegistry`. The struct layouts and the `beforeSwap` selector
 *         match v4 so the hook is drop-in against the real base contract.
 *
 * @dev    Real references:
 *         - IHooks:       https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IHooks.sol
 *         - BaseHook:     https://github.com/Uniswap/v4-periphery/blob/main/src/utils/BaseHook.sol
 *         - Hooks perms:  https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol
 */

/// @notice A v4 pool key (Currency is an address-wrapped type in real v4).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice v4 swap parameters.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// @notice The subset of IHooks our cap enforcer implements.
interface IHooks {
    /**
     * @notice Called by the PoolManager before a swap executes. Reverting here
     *         aborts the swap — this is where we enforce the spend cap.
     * @return selector  must equal `IHooks.beforeSwap.selector`.
     * @return delta     BeforeSwapDelta (unused here → 0).
     * @return fee       dynamic LP fee override (unused here → 0).
     */
    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4 selector, int256 delta, uint24 fee);
}
