// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TeeSigVerifier} from "./TeeSigVerifier.sol";

/// @title CopyVaultFlare
/// @notice Per-follower, non-custodial spot vault for the Flare venue. The follower (owner) holds the
///         funds; a swap can ONLY be triggered by a valid TEE-signed authorization (`SwapAuth`), within
///         a token + router whitelist and a per-trade cap. Only the owner can withdraw. There is no
///         bypassable executor role — the TEE signature IS the authorization (CLAUDE.md rules 1 & 2).
/// @dev SWAP-ONLY: `executeSwapWithTeeSig` is the single trading primitive; no borrow/leverage/short path.
contract CopyVaultFlare is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice One follower's authorized swap. The TEE signs a `SwapAuth[]` batch (one entry per
    ///         follower for a signal); each vault verifies the signature over the whole batch and acts
    ///         only on its own entry.
    struct SwapAuth {
        address vault; // must equal this vault (rejects cross-vault reuse)
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        address router;
        bytes swapData;
        bytes32 signalId;
        uint256 deadline; // unix seconds; execution must be <= this
        uint256 chainId; // must equal block.chainid
    }

    address public immutable owner;
    TeeSigVerifier public immutable teeVerifier;
    /// @notice The attested TEE identity whose signature authorizes swaps. Owner-settable because it
    ///         changes across TEE re-registration (e.g. simulated machine → real attested VM).
    address public teeAddress;

    mapping(address => bool) public tokenWhitelisted;
    mapping(address => bool) public routerWhitelisted;
    uint256 public perTradeCap;
    bool public paused;
    /// @notice keccak256(actionId, index) => consumed, to prevent replay of a signed authorization.
    mapping(bytes32 => bool) public consumedAuth;

    event TeeAddressSet(address indexed teeAddress);
    event TokenWhitelisted(address indexed token, bool allowed);
    event RouterWhitelisted(address indexed router, bool allowed);
    event PerTradeCapSet(uint256 cap);
    event PausedSet(bool paused);
    event Swapped(
        bytes32 indexed signalId, address indexed tokenIn, uint256 amountIn, address indexed tokenOut, uint256 received
    );
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error Paused();
    error TokenNotWhitelisted();
    error RouterNotWhitelisted();
    error CapExceeded();
    error MinOut();
    error SwapFailed();
    error BadStatus();
    error TeeAddressUnset();
    error BadTeeSignature();
    error WrongVault();
    error WrongChain();
    error AuthExpired();
    error AuthAlreadyUsed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address _owner,
        address _teeVerifier,
        address _teeAddress,
        address[] memory tokens,
        address[] memory routers,
        uint256 cap
    ) {
        owner = _owner;
        teeVerifier = TeeSigVerifier(_teeVerifier);
        teeAddress = _teeAddress;
        emit TeeAddressSet(_teeAddress);
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

    /// @notice Update the attested TEE identity (after a TEE re-registration).
    function setTeeAddress(address _teeAddress) external onlyOwner {
        teeAddress = _teeAddress;
        emit TeeAddressSet(_teeAddress);
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

    // ----- the single trading primitive: TEE-signature-gated swap -----

    /// @notice Execute the swap authorized for THIS vault within a TEE-signed batch. Anyone may relay,
    ///         but only a valid TEE signature over the `SwapAuth[]` authorizes it; the authorization can
    ///         never withdraw or exceed the whitelist/cap.
    /// @param auths         The signed batch (one entry per follower for a signal).
    /// @param index         This vault's entry in `auths`.
    /// @param actionId      FCC action id (part of the signed ActionResult).
    /// @param submissionTag FCC submission tag (part of the signed ActionResult).
    /// @param status        FCC ActionResult status; must be 1 (success).
    /// @param signature     The TEE's 65-byte signature over the ActionResult.
    /// @return received     tokenOut received (measured on-chain), guaranteed >= minOut.
    function executeSwapWithTeeSig(
        SwapAuth[] calldata auths,
        uint256 index,
        bytes32 actionId,
        string calldata submissionTag,
        uint8 status,
        bytes calldata signature
    ) external nonReentrant returns (uint256 received) {
        if (status != 1) revert BadStatus();
        if (teeAddress == address(0)) revert TeeAddressUnset();

        // The TEE signs the whole batch: resultData == abi.encode(auths).
        address signer =
            teeVerifier.recoverActionSigner(abi.encode(auths), actionId, submissionTag, status, signature);
        if (signer != teeAddress) revert BadTeeSignature();

        SwapAuth calldata a = auths[index];
        if (a.vault != address(this)) revert WrongVault();
        if (a.chainId != block.chainid) revert WrongChain();
        if (block.timestamp > a.deadline) revert AuthExpired();

        bytes32 authId = keccak256(abi.encode(actionId, index));
        if (consumedAuth[authId]) revert AuthAlreadyUsed();
        consumedAuth[authId] = true;

        if (paused) revert Paused();
        if (!tokenWhitelisted[a.tokenIn] || !tokenWhitelisted[a.tokenOut]) revert TokenNotWhitelisted();
        if (!routerWhitelisted[a.router]) revert RouterNotWhitelisted();
        if (a.amountIn > perTradeCap) revert CapExceeded();

        uint256 balBefore = IERC20(a.tokenOut).balanceOf(address(this));
        IERC20(a.tokenIn).forceApprove(a.router, a.amountIn);
        (bool ok,) = a.router.call(a.swapData);
        IERC20(a.tokenIn).forceApprove(a.router, 0);
        if (!ok) revert SwapFailed();

        received = IERC20(a.tokenOut).balanceOf(address(this)) - balBefore;
        if (received < a.minOut) revert MinOut();

        emit Swapped(a.signalId, a.tokenIn, a.amountIn, a.tokenOut, received);
    }
}
