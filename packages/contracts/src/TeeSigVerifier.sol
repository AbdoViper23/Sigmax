// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title TeeSigVerifier
/// @notice Recovers the signer of an FCC TEE `ActionResult`. The FCC TEE node signs
///         keccak256(keccak256(resultData), actionId, keccak256(submissionTag), status)
///         with the EIP-191 personal-sign prefix (the same scheme fce-weather-insurance's
///         settle() verifies). CopyVault reuses this to gate swap execution on the
///         registered TEE identity (`recoverActionSigner(...) == teeAddress`).
contract TeeSigVerifier {
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
    ) external pure returns (address signer) {
        require(signature.length == 65, "bad sig length");
        bytes32 resultHash =
            keccak256(abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes(submissionTag)), status));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", resultHash));
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        signer = ecrecover(ethSigned, v, r, s);
        require(signer != address(0), "invalid signature");
    }
}
