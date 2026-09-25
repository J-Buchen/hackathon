// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title Escrow
 * @notice Settlement escrow with a post-screening clawback window.
 *
 *         This is the on-chain half of the Intercepta screening story (DESIGN.md
 *         §2 step 3 + §9): funds for a payment are DEPOSITED into escrow rather
 *         than sent straight to the merchant. During the clawback window the
 *         designated `screener` (Intercepta) can pull the funds back if live
 *         screening flags the payment. Once the window elapses with no clawback,
 *         anyone can `release()` the funds to the merchant.
 *
 *         Lifecycle:  deposit  ──window──▶  release()  (funds → merchant)
 *                        │
 *                        └── clawback() by screener (funds → depositor)  [before release]
 *
 * @dev    ERC-20 based. The depositor must `approve` this contract for `amount`
 *         before calling `deposit`. A tiny non-reentrant guard protects the
 *         transfer paths.
 */
contract Escrow {
    enum Status {
        None,
        Pending,
        Released,
        Clawed
    }

    struct Deposit {
        address depositor;
        address merchant;
        address screener;
        IERC20 token;
        uint256 amount;
        uint64 releaseTime; // block.timestamp at/after which release() is allowed
        Status status;
    }

    /// @notice Auto-incrementing deposit id.
    uint256 public nextId = 1;

    /// @notice id => deposit record.
    mapping(uint256 => Deposit) public deposits;

    // Simple reentrancy guard.
    uint256 private _locked = 1;

    event Deposited(
        uint256 indexed id,
        address indexed depositor,
        address indexed merchant,
        address screener,
        address token,
        uint256 amount,
        uint64 releaseTime
    );
    event Released(uint256 indexed id, address indexed merchant, uint256 amount);
    event Clawed(uint256 indexed id, address indexed screener, uint256 amount);

    error Reentrancy();
    error UnknownDeposit(uint256 id);
    error NotPending(uint256 id);
    error TooEarly(uint64 nowTs, uint64 releaseTime);
    error NotScreener();
    error WindowClosed();
    error TransferFailed();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    /**
     * @notice Escrow `amount` of `token` for `merchant`, screenable by
     *         `screener` for `windowSeconds`.
     * @dev    Caller must have approved this contract for `amount`.
     * @return id the new deposit id.
     */
    function deposit(
        IERC20 token,
        address merchant,
        address screener,
        uint256 amount,
        uint64 windowSeconds
    ) external nonReentrant returns (uint256 id) {
        if (!token.transferFrom(msg.sender, address(this), amount)) {
            revert TransferFailed();
        }

        id = nextId++;
        deposits[id] = Deposit({
            depositor: msg.sender,
            merchant: merchant,
            screener: screener,
            token: token,
            amount: amount,
            releaseTime: uint64(block.timestamp) + windowSeconds,
            status: Status.Pending
        });

        emit Deposited(
            id,
            msg.sender,
            merchant,
            screener,
            address(token),
            amount,
            deposits[id].releaseTime
        );
    }

    /**
     * @notice Release escrowed funds to the merchant once the clawback window
     *         has elapsed. Callable by anyone (permissionless settlement).
     */
    function release(uint256 id) external nonReentrant {
        Deposit storage d = deposits[id];
        if (d.status == Status.None) revert UnknownDeposit(id);
        if (d.status != Status.Pending) revert NotPending(id);
        if (block.timestamp < d.releaseTime) {
            revert TooEarly(uint64(block.timestamp), d.releaseTime);
        }

        d.status = Status.Released;
        if (!d.token.transfer(d.merchant, d.amount)) revert TransferFailed();
        emit Released(id, d.merchant, d.amount);
    }

    /**
     * @notice Claw funds back to the depositor. Only the `screener` may call,
     *         and only before the deposit has been released.
     */
    function clawback(uint256 id) external nonReentrant {
        Deposit storage d = deposits[id];
        if (d.status == Status.None) revert UnknownDeposit(id);
        if (d.status != Status.Pending) revert NotPending(id);
        if (msg.sender != d.screener) revert NotScreener();
        // The screener may claw back at any point while the deposit is still
        // Pending (i.e. before someone calls release()).

        d.status = Status.Clawed;
        if (!d.token.transfer(d.depositor, d.amount)) revert TransferFailed();
        emit Clawed(id, d.screener, d.amount);
    }

    /// @notice Convenience view for the deposit status.
    function statusOf(uint256 id) external view returns (Status) {
        return deposits[id].status;
    }
}
