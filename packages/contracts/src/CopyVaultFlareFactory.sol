// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CopyVaultFlare} from "./CopyVaultFlare.sol";

/// @title CopyVaultFlareFactory
/// @notice Deploys one deterministic (CREATE2) CopyVaultFlare per follower. Configured once with the
///         platform's TEE verifier + attested TEE address; each follower gets a vault they own.
contract CopyVaultFlareFactory {
    using SafeERC20 for IERC20;

    address public immutable teeVerifier;
    address public immutable teeAddress;

    /// @notice follower => their vault (address(0) if none yet).
    mapping(address => address) public vaultOf;

    event VaultCreated(address indexed owner, address vault);
    event VaultFunded(address indexed owner, address indexed vault, address indexed token, uint256 amount);

    error VaultExists();
    error TokenNotWhitelisted();
    error NothingToDeposit();

    constructor(address _teeVerifier, address _teeAddress) {
        teeVerifier = _teeVerifier;
        teeAddress = _teeAddress;
    }

    /// @notice Create the caller's non-custodial vault (one per address). Reverts if it already exists.
    function createVault(address[] calldata tokens, address[] calldata routers, uint256 cap)
        public
        returns (address vault)
    {
        if (vaultOf[msg.sender] != address(0)) revert VaultExists();
        vault = address(
            new CopyVaultFlare{salt: _salt(msg.sender)}(msg.sender, teeVerifier, teeAddress, tokens, routers, cap)
        );
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault);
    }

    /// @notice Create the caller's vault and fund it in the same transaction.
    /// @dev Onboarding is the point: `createVault` then `deposit` costs the follower two signatures
    ///      and surfaces "create a vault" as a step they have to understand before they can do the
    ///      thing they came to do. Here they approve this factory once and fund in a single action.
    ///
    ///      The tokens move straight from the caller to the new vault — the factory never holds a
    ///      balance, so there is nothing here to drain and no approval left sitting on it afterwards
    ///      beyond what the caller granted. The whitelist is re-checked against the *vault* rather
    ///      than trusted from `tokens`, so a token that failed to register cannot be funded into a
    ///      vault that would then refuse to trade it.
    /// @param token The token to fund. Must be whitelisted on the freshly created vault.
    /// @param amount Amount to pull from the caller. Must be non-zero.
    function createVaultAndDeposit(
        address[] calldata tokens,
        address[] calldata routers,
        uint256 cap,
        address token,
        uint256 amount
    ) external returns (address vault) {
        if (amount == 0) revert NothingToDeposit();
        vault = createVault(tokens, routers, cap);
        if (!CopyVaultFlare(vault).tokenWhitelisted(token)) revert TokenNotWhitelisted();
        IERC20(token).safeTransferFrom(msg.sender, vault, amount);
        emit VaultFunded(msg.sender, vault, token, amount);
    }

    /// @notice Predict the deterministic vault address for `ownerAddr` given the same creation args.
    function predictVault(address ownerAddr, address[] calldata tokens, address[] calldata routers, uint256 cap)
        external
        view
        returns (address)
    {
        bytes memory initCode = abi.encodePacked(
            type(CopyVaultFlare).creationCode, abi.encode(ownerAddr, teeVerifier, teeAddress, tokens, routers, cap)
        );
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(ownerAddr), keccak256(initCode)));
        return address(uint160(uint256(hash)));
    }

    function _salt(address ownerAddr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(ownerAddr)));
    }
}
