// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CopyVaultFlare} from "./CopyVaultFlare.sol";

/// @title CopyVaultFlareFactory
/// @notice Deploys one deterministic (CREATE2) CopyVaultFlare per follower. Configured once with the
///         platform's TEE verifier + attested TEE address; each follower gets a vault they own.
contract CopyVaultFlareFactory {
    address public immutable teeVerifier;
    address public immutable teeAddress;

    /// @notice follower => their vault (address(0) if none yet).
    mapping(address => address) public vaultOf;

    event VaultCreated(address indexed owner, address vault);

    error VaultExists();

    constructor(address _teeVerifier, address _teeAddress) {
        teeVerifier = _teeVerifier;
        teeAddress = _teeAddress;
    }

    /// @notice Create the caller's non-custodial vault (one per address). Reverts if it already exists.
    function createVault(address[] calldata tokens, address[] calldata routers, uint256 cap)
        external
        returns (address vault)
    {
        if (vaultOf[msg.sender] != address(0)) revert VaultExists();
        vault = address(
            new CopyVaultFlare{salt: _salt(msg.sender)}(msg.sender, teeVerifier, teeAddress, tokens, routers, cap)
        );
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault);
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
        bytes32 hash =
            keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(ownerAddr), keccak256(initCode)));
        return address(uint160(uint256(hash)));
    }

    function _salt(address ownerAddr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(ownerAddr)));
    }
}
