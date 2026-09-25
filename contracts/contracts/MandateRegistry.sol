// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MandateRegistry
 * @notice On-chain delegation tree for the Allowance protocol.
 *
 *         This is the on-chain mirror of the "allowance/core" package (see DESIGN.md §2/§4).
 *         Each node in the tree is an agent, keyed by a namehash-like `bytes32`
 *         (the caller supplies the id — off-chain we use ENS namehash of names
 *         like `scraper.researcher.alice.eth`, so the *hierarchy of ENS names
 *         is literally the delegation/authority tree*, which is the ENS track).
 *
 *         Authority ATTENUATES down the chain: a child mandate can only ever
 *         NARROW its parent's remaining budget/scope. The exact rules are the
 *         same ones enforced in `packages/core/src/attenuation.ts`:
 *
 *           1. child.budget  <= available(parent)
 *           2. child.expiry  <= parent.expiry
 *           3. child.merchants ⊆ parent.merchants (a restricted parent forces a
 *              restricted — never broader — child)
 *           4. parent not revoked
 *
 *         where  available(node) = budget - spentDirect - reserved  and
 *                reserved(node)  = Σ children.budget.
 *
 *         `spend()` re-checks the whole ancestor chain at settlement time, so a
 *         `revoke()` anywhere above a node instantly disables all of its
 *         descendants' spending (cascading revocation without touching storage
 *         of the descendants).
 *
 * @dev    Merchants are represented on-chain as `address` (the payment
 *         recipient). Off-chain the core uses string merchant handles; the
 *         mapping is: on-chain merchant address == the address the string handle
 *         resolves to. An EMPTY merchant list means "any merchant allowed".
 */
contract MandateRegistry {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Node {
        bool exists;
        bytes32 parent; // bytes32(0) for the root
        uint256 budget; // total mandate budget (smallest unit, e.g. USDC 1e6)
        uint256 spentDirect; // amount this node has spent itself
        uint256 reserved; // Σ of this node's children budgets (delegated away)
        uint64 expiry; // unix seconds; spend fails once block.timestamp > expiry
        bool revoked; // if true, this node and all descendants cannot spend
        bool merchantsRestricted; // true => only merchants in the allowlist are allowed
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Deployer / protocol owner. May act on any node (break-glass).
    address public immutable owner;

    /// @notice node id => node data.
    mapping(bytes32 => Node) private _nodes;

    /// @notice node id => merchant address => allowed?
    mapping(bytes32 => mapping(address => bool)) private _merchantAllowed;

    /// @notice node id => the address permitted to delegate/spend for that node.
    mapping(bytes32 => address) public controllerOf;

    // ---------------------------------------------------------------------
    // Events (one per mutating action — the audit log, mirrors core events)
    // ---------------------------------------------------------------------

    event RootFunded(
        bytes32 indexed node,
        address indexed controller,
        uint256 budget,
        uint64 expiry,
        bool merchantsRestricted
    );

    event Delegated(
        bytes32 indexed parent,
        bytes32 indexed child,
        address indexed controller,
        uint256 budget,
        uint64 expiry,
        bool merchantsRestricted
    );

    event Spent(
        bytes32 indexed node,
        address indexed merchant,
        uint256 amount,
        uint256 spentDirectAfter
    );

    event Revoked(bytes32 indexed node, address indexed by);

    // ---------------------------------------------------------------------
    // Errors (typed rejections — mirror core's AttenuationRejectionReason etc.)
    // ---------------------------------------------------------------------

    error NotAuthorized();
    error UnknownNode(bytes32 node);
    error UnknownParent(bytes32 parent);
    error DuplicateNode(bytes32 node);
    error ParentRevoked();
    error BudgetExceedsAvailable(uint256 requested, uint256 available);
    error ExpiryExceedsParent(uint64 requested, uint64 parentExpiry);
    error MerchantsNotSubset(address merchant);
    error RevokedInChain();
    error ExpiredInChain();
    error OverBudget(uint256 requested, uint256 available);
    error MerchantNotAllowed(address merchant);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor() {
        owner = msg.sender;
    }

    // ---------------------------------------------------------------------
    // Mutating API
    // ---------------------------------------------------------------------

    /**
     * @notice Fund the root agent node (the human principal grants a budget).
     * @dev    Callable only by `owner` (the principal's account in the demo).
     *         An empty `merchants` array => the root may pay any merchant.
     * @param  node       namehash-like id of the root (e.g. namehash("alice.eth")).
     * @param  controller address allowed to delegate/spend for this node.
     * @param  budget     total root budget in smallest units.
     * @param  expiry     unix-seconds expiry of the mandate.
     * @param  merchants  optional merchant allowlist (empty = any).
     */
    function fund(
        bytes32 node,
        address controller,
        uint256 budget,
        uint64 expiry,
        address[] calldata merchants
    ) external {
        if (msg.sender != owner) revert NotAuthorized();
        if (_nodes[node].exists) revert DuplicateNode(node);

        bool restricted = merchants.length > 0;
        Node storage n = _nodes[node];
        n.exists = true;
        n.parent = bytes32(0);
        n.budget = budget;
        n.expiry = expiry;
        n.merchantsRestricted = restricted;

        for (uint256 i = 0; i < merchants.length; i++) {
            _merchantAllowed[node][merchants[i]] = true;
        }

        controllerOf[node] = controller == address(0) ? msg.sender : controller;
        emit RootFunded(node, controllerOf[node], budget, expiry, restricted);
    }

    /**
     * @notice Delegate a NARROWED mandate from `parent` to a new `child` node.
     * @dev    Enforces the full attenuation rule set on-chain. Reverts with a
     *         typed error on any violation. Callable by the parent's controller
     *         (or `owner`).
     * @param  parent          existing parent node id.
     * @param  child           new child node id (must not already exist).
     * @param  childController address allowed to delegate/spend for the child.
     * @param  budget          child budget (must fit within parent's available).
     * @param  expiry          child expiry (must be <= parent's expiry).
     * @param  merchants       child merchant allowlist (empty = any; not allowed
     *                          to be empty if the parent is restricted).
     */
    function delegate(
        bytes32 parent,
        bytes32 child,
        address childController,
        uint256 budget,
        uint64 expiry,
        address[] calldata merchants
    ) external {
        Node storage p = _nodes[parent];
        if (!p.exists) revert UnknownParent(parent);
        if (msg.sender != controllerOf[parent] && msg.sender != owner) {
            revert NotAuthorized();
        }
        if (_nodes[child].exists) revert DuplicateNode(child);

        // (guard) parent must not be revoked anywhere up the chain.
        if (_revokedInChain(parent)) revert ParentRevoked();

        // (1) budget attenuation.
        uint256 avail = _available(parent);
        if (budget > avail) revert BudgetExceedsAvailable(budget, avail);

        // (4) expiry attenuation.
        if (expiry > p.expiry) revert ExpiryExceedsParent(expiry, p.expiry);

        // (2/3) merchant subset. A restricted parent forces a restricted child
        //       (an empty child list would mean "any" — a broadening — rejected).
        bool childRestricted = merchants.length > 0;
        if (p.merchantsRestricted && !childRestricted) {
            revert MerchantsNotSubset(address(0));
        }

        Node storage c = _nodes[child];
        c.exists = true;
        c.parent = parent;
        c.budget = budget;
        c.expiry = expiry;
        c.merchantsRestricted = childRestricted;

        for (uint256 i = 0; i < merchants.length; i++) {
            address m = merchants[i];
            if (p.merchantsRestricted && !_merchantAllowed[parent][m]) {
                revert MerchantsNotSubset(m);
            }
            _merchantAllowed[child][m] = true;
        }

        // Reserve the child's budget against the parent's available balance.
        p.reserved += budget;

        controllerOf[child] = childController == address(0)
            ? msg.sender
            : childController;

        emit Delegated(
            parent,
            child,
            controllerOf[child],
            budget,
            expiry,
            childRestricted
        );
    }

    /**
     * @notice Spend from a node to a merchant. This is the on-chain enforcement
     *         point that `SpendCapHook` and off-chain settlement gate against.
     * @dev    Re-checks the ENTIRE ancestor chain (revoked + expired) so a
     *         revocation above the node cascades instantly. Callable by the
     *         node's controller (or `owner`).
     */
    function spend(bytes32 node, address merchant, uint256 amount) external {
        Node storage n = _nodes[node];
        if (!n.exists) revert UnknownNode(node);
        if (msg.sender != controllerOf[node] && msg.sender != owner) {
            revert NotAuthorized();
        }
        if (_revokedInChain(node)) revert RevokedInChain();
        if (_expiredInChain(node)) revert ExpiredInChain();

        uint256 avail = _available(node);
        if (amount > avail) revert OverBudget(amount, avail);

        if (n.merchantsRestricted && !_merchantAllowed[node][merchant]) {
            revert MerchantNotAllowed(merchant);
        }

        n.spentDirect += amount;
        emit Spent(node, merchant, amount, n.spentDirect);
    }

    /**
     * @notice Revoke a node. Cascades to all descendants via the ancestor check
     *         performed inside `spend()` / `delegate()`.
     * @dev    Callable by the node's own controller, its parent's controller, or
     *         `owner` (a boss can revoke a subordinate).
     */
    function revoke(bytes32 node) external {
        Node storage n = _nodes[node];
        if (!n.exists) revert UnknownNode(node);

        bool authorized = msg.sender == owner ||
            msg.sender == controllerOf[node] ||
            (n.parent != bytes32(0) && msg.sender == controllerOf[n.parent]);
        if (!authorized) revert NotAuthorized();

        n.revoked = true;
        emit Revoked(node, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Full node record.
    function getNode(bytes32 node) external view returns (Node memory) {
        Node memory n = _nodes[node];
        if (!n.exists) revert UnknownNode(node);
        return n;
    }

    /// @notice available(node) = budget - spentDirect - reserved.
    function available(bytes32 node) external view returns (uint256) {
        if (!_nodes[node].exists) revert UnknownNode(node);
        return _available(node);
    }

    /// @notice reserved(node) = Σ children budgets (tracked incrementally).
    function reserved(bytes32 node) external view returns (uint256) {
        if (!_nodes[node].exists) revert UnknownNode(node);
        return _nodes[node].reserved;
    }

    /// @notice True if `node` or any ancestor is revoked.
    function isRevokedInChain(bytes32 node) external view returns (bool) {
        return _revokedInChain(node);
    }

    /// @notice True if `node` or any ancestor is past its expiry.
    function isExpiredInChain(bytes32 node) external view returns (bool) {
        return _expiredInChain(node);
    }

    /// @notice Whether `merchant` is allowed for `node` (accounts for "any").
    function isMerchantAllowed(
        bytes32 node,
        address merchant
    ) external view returns (bool) {
        Node storage n = _nodes[node];
        if (!n.exists) return false;
        if (!n.merchantsRestricted) return true;
        return _merchantAllowed[node][merchant];
    }

    /**
     * @notice Non-reverting spend pre-check used by `SpendCapHook.beforeSwap`.
     * @return ok      true iff a `spend(node, merchant, amount)` would succeed.
     * @return reason  a short machine code describing the first failure.
     */
    function canSpend(
        bytes32 node,
        address merchant,
        uint256 amount
    ) public view returns (bool ok, bytes32 reason) {
        Node storage n = _nodes[node];
        if (!n.exists) return (false, "UNKNOWN_NODE");
        if (_revokedInChain(node)) return (false, "REVOKED");
        if (_expiredInChain(node)) return (false, "EXPIRED");
        if (amount > _available(node)) return (false, "OVER_BUDGET");
        if (n.merchantsRestricted && !_merchantAllowed[node][merchant]) {
            return (false, "MERCHANT_NOT_ALLOWED");
        }
        return (true, bytes32(0));
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _available(bytes32 node) internal view returns (uint256) {
        Node storage n = _nodes[node];
        // Invariant: budget >= spentDirect + reserved (enforced by spend/delegate).
        return n.budget - n.spentDirect - n.reserved;
    }

    function _revokedInChain(bytes32 node) internal view returns (bool) {
        bytes32 cursor = node;
        // Walk parent pointers to the root. Depth is bounded by tree height.
        while (cursor != bytes32(0)) {
            Node storage n = _nodes[cursor];
            if (!n.exists) break;
            if (n.revoked) return true;
            cursor = n.parent;
        }
        return false;
    }

    function _expiredInChain(bytes32 node) internal view returns (bool) {
        bytes32 cursor = node;
        while (cursor != bytes32(0)) {
            Node storage n = _nodes[cursor];
            if (!n.exists) break;
            if (block.timestamp > n.expiry) return true;
            cursor = n.parent;
        }
        return false;
    }
}
