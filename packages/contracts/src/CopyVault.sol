// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CopyVault
/// @notice Per-follower, non-custodial spot vault. The follower (owner) holds funds; the agent gets
///         only a scoped executor right that can call `executeSwap` within a token+router whitelist
///         and a per-trade cap. Only the owner can withdraw. (CLAUDE.md rules 1 & 2; doc contracts/10.)
/// @dev SPOT ONLY: `executeSwap` is the single trading primitive — no borrow/leverage/short path exists.
contract CopyVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable owner;

    mapping(address => bool) public isExecutor;
    mapping(address => bool) public tokenWhitelisted;
    mapping(address => bool) public routerWhitelisted;
    uint256 public perTradeCap; // max amountIn (in tokenIn smallest units) per swap
    bool public paused;

    event ExecutorSet(address indexed executor, bool allowed);
    event TokenWhitelisted(address indexed token, bool allowed);
    event RouterWhitelisted(address indexed router, bool allowed);
    event PerTradeCapSet(uint256 cap);
    event PausedSet(bool paused);
    event Swapped(address indexed tokenIn, uint256 amountIn, address indexed tokenOut, uint256 received);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotExecutor();
    error Paused();
    error TokenNotWhitelisted();
    error RouterNotWhitelisted();
    error CapExceeded();
    error MinOut();
    error SwapFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutor() {
        if (!isExecutor[msg.sender]) revert NotExecutor();
        _;
    }

    constructor(
        address _owner,
        address executor,
        address[] memory tokens,
        address[] memory routers,
        uint256 cap
    ) {
        owner = _owner;
        if (executor != address(0)) {
            isExecutor[executor] = true;
            emit ExecutorSet(executor, true);
        }
        for (uint256 i; i < tokens.length; ++i) {
            tokenWhitelisted[tokens[i]] = true;
            emit TokenWhitelisted(tokens[i], true);
        }
        for (uint256 i; i < routers.length; ++i) {
            routerWhitelisted[routers[i]] = true;
            emit RouterWhitelisted(routers[i], true);
        }
        perTradeCap = cap;
        emit PerTradeCapSet(cap);
    }

    // ----- owner-only configuration -----

    function setExecutor(address executor, bool allowed) external onlyOwner {
        isExecutor[executor] = allowed;
        emit ExecutorSet(executor, allowed);
    }

    function setTokenWhitelist(address token, bool allowed) external onlyOwner {
        tokenWhitelisted[token] = allowed;
        emit TokenWhitelisted(token, allowed);
    }

    function setRouterWhitelist(address router, bool allowed) external onlyOwner {
        routerWhitelisted[router] = allowed;
        emit RouterWhitelisted(router, allowed);
    }

    function setPerTradeCap(uint256 cap) external onlyOwner {
        perTradeCap = cap;
        emit PerTradeCapSet(cap);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    // ----- funds -----

    /// @notice Deposit a whitelisted token into the vault.
    function deposit(address token, uint256 amount) external {
        if (!tokenWhitelisted[token]) revert TokenNotWhitelisted();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Only the owner can ever move funds out of the vault.
    function withdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner, amount);
        emit Withdrawn(token, owner, amount);
    }

    // ----- the single trading primitive -----

    /// @notice Execute a bounded spot swap via a whitelisted router. The agent (executor) calls this;
    ///         it can never exceed caps, touch non-whitelisted tokens/routers, or withdraw.
    /// @dev `minOut` is enforced on-chain via the measured tokenOut balance delta, independent of the
    ///      off-chain quote. Approval is set to exactly `amountIn` and reset to 0 after the call.
    function executeSwap(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minOut,
        address router,
        bytes calldata swapData
    ) external onlyExecutor nonReentrant returns (uint256 received) {
        if (paused) revert Paused();
        if (!tokenWhitelisted[tokenIn] || !tokenWhitelisted[tokenOut]) revert TokenNotWhitelisted();
        if (!routerWhitelisted[router]) revert RouterNotWhitelisted();
        if (amountIn > perTradeCap) revert CapExceeded();

        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(router, amountIn);
        (bool ok,) = router.call(swapData);
        IERC20(tokenIn).forceApprove(router, 0);
        if (!ok) revert SwapFailed();

        received = IERC20(tokenOut).balanceOf(address(this)) - balBefore;
        if (received < minOut) revert MinOut();

        emit Swapped(tokenIn, amountIn, tokenOut, received);
    }
}
