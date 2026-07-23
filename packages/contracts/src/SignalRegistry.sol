// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title SignalRegistry
/// @notice On-chain commit-before-outcome ledger. A leader publishes the keccak256 commitment of an
///         encrypted signal BEFORE its outcome is known; the event + stored hash make the leader's
///         track record auditable without revealing the strategy. The event's `leader` is always
///         `msg.sender`, so a record cannot be forged for another leader.
/// @dev The plaintext strategy is NEVER placed on-chain — only the ciphertext commitment.
contract SignalRegistry {
    /// @notice strategyId => number of signals published.
    mapping(address => uint256) public signalCount;
    /// @notice strategyId => index => ciphertext commitment (keccak256 of the encrypted signal).
    mapping(address => mapping(uint256 => bytes32)) public commitOf;

    event SignalPublished(
        address indexed leader,
        address indexed strategyId,
        uint256 indexed index,
        bytes32 ciphertextHash,
        string uri,
        uint256 timestamp
    );

    /// @notice Record a signal commitment for `strategyId`; emits the canonical publish event/timestamp.
    /// @param strategyId     The strategy/plan identifier followers subscribe to.
    /// @param ciphertextHash keccak256 of the encrypted signal (the commitment).
    /// @param uri            Optional off-chain pointer to the ciphertext (may be empty).
    /// @return index         The monotonic index of this signal for the strategy.
    function publishSignal(address strategyId, bytes32 ciphertextHash, string calldata uri)
        external
        returns (uint256 index)
    {
        index = signalCount[strategyId]++;
        commitOf[strategyId][index] = ciphertextHash;
        emit SignalPublished(msg.sender, strategyId, index, ciphertextHash, uri, block.timestamp);
    }
}
