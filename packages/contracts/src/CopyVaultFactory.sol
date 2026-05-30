// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CopyVault} from "./CopyVault.sol";

/// @title CopyVaultFactory
/// @notice Deploys one deterministic CopyVault per follower (CREATE2, follower address as salt) and
///         wires the executor + token/router whitelist + cap in a single transaction. (doc contracts/10 §7)
contract CopyVaultFactory {
    mapping(address => address) public vaultOf;

    event VaultCreated(address indexed owner, address vault);

    /// @notice Create (or return) the caller's CopyVault, fully configured.
    function createVault(address executor, address[] calldata tokens, address[] calldata routers, uint256 cap)
        external
        returns (address vault)
    {
        require(vaultOf[msg.sender] == address(0), "VAULT_EXISTS");
        vault = address(
            new CopyVault{salt: bytes32(uint256(uint160(msg.sender)))}(msg.sender, executor, tokens, routers, cap)
        );
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault);
    }
}
