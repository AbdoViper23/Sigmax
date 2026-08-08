// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title TeeSigVerifier
/// @notice Recovers the signer of an FCC TEE `ActionResult`, exactly as the tee-node produces it.
///
/// @dev The scheme is three layers, verified against tee-node v0.0.25 source and confirmed against a
///      real signature from a registered Coston2 machine (see TeeSigVerifierFixture.t.sol):
///
///        1. inner  = keccak256(keccak256(data) ‖ actionId ‖ keccak256(submissionTag) ‖ status)
///             — tee-node/pkg/types/actions.go, ActionResult.Hash()
///        2. signed = keccak256(abi.encode(Payload{prefix, chainId, dataHash: inner}))
///             — go-flare-common/pkg/signing, Payload.Hash(); prefix = bytes32("TEE_ACTION_RESULT")
///        3. sig    = ecdsa(EIP-191 personal-sign over `signed`)
///             — tee-node/pkg/utils/crypto.go, Sign() → accounts.TextHash()
///
///      Layer 2 is easy to miss: it domain-separates the signature by chain and by payload kind, so
///      an ActionResult signature cannot be replayed as a vote signature or onto another chain. An
///      earlier version of this contract omitted it and would have rejected every real TEE signature.
///
///      `abi.encode` of the all-static Payload tuple is the 3 words laid out inline, which is what
///      Go's abicoder produces for the same struct — so `abi.encode(PREFIX, chainId, inner)` matches
///      byte for byte.
contract TeeSigVerifier {
    /// @notice Payload-kind domain separator: bytes32("TEE_ACTION_RESULT"), right-zero-padded.
    bytes32 public constant TEE_ACTION_RESULT_PREFIX = bytes32("TEE_ACTION_RESULT");

    /// @notice Recover the address that signed an FCC ActionResult.
    /// @param resultData    The raw ActionResult data bytes the TEE returned.
    /// @param actionId      The FCC action id for this instruction.
    /// @param submissionTag The FCC submission tag.
    /// @param status        The ActionResult status (1 == success).
    /// @param signature     65-byte (r,s,v) ECDSA signature produced by the TEE.
    /// @return signer       The recovered signer address; compare against the registered teeAddress.
    function recoverActionSigner(
        bytes calldata resultData,
        bytes32 actionId,
        string calldata submissionTag,
        uint8 status,
        bytes calldata signature
    ) external view returns (address signer) {
        return recoverActionSignerForChain(resultData, actionId, submissionTag, status, signature, block.chainid);
    }

    /// @notice Same as `recoverActionSigner`, with the signing chain id supplied explicitly.
    /// @dev The TEE signs with the chain id it is configured for. That is `block.chainid` whenever the
    ///      verifying contract lives on the same chain as the TEE — the deployed topology — so the
    ///      convenience overload above covers production. This variant exists for tests and for a
    ///      future cross-chain deployment where the two differ.
    /// @param signingChainId The chain id bound into the signed payload.
    function recoverActionSignerForChain(
        bytes calldata resultData,
        bytes32 actionId,
        string calldata submissionTag,
        uint8 status,
        bytes calldata signature,
        uint256 signingChainId
    ) public pure returns (address signer) {
        require(signature.length == 65, "bad sig length");

        // Layer 1 — the ActionResult's own hash.
        bytes32 inner =
            keccak256(abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes(submissionTag)), status));

        // Layer 2 — domain-separate by payload kind and chain.
        bytes32 signed = keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, signingChainId, inner));

        // Layer 3 — EIP-191 personal-sign.
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", signed));

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        // tee-node returns v as 0/1 (go-ethereum convention); ecrecover wants 27/28.
        if (v < 27) v += 27;

        signer = ecrecover(ethSigned, v, r, s);
        require(signer != address(0), "invalid signature");
    }
}
