// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {TeeSigVerifier} from "../src/TeeSigVerifier.sol";

/// @dev Proves the on-chain recovery of an FCC TEE `ActionResult` signature.
/// The FCC node signs `ActionResult.Hash()` = keccak256(keccak256(resultData),
/// actionId, keccak256(submissionTag), status) with the EIP-191 personal-sign
/// prefix (same scheme fce-weather-insurance's settle() verifies). CopyVault
/// reuses this exact recovery to gate executeSwapWithTeeSig on the TEE identity.
contract TeeSigVerifierTest is Test {
    TeeSigVerifier internal verifier;

    function setUp() public {
        verifier = new TeeSigVerifier();
    }

    function test_recoversKnownSigner() public view {
        uint256 pk = 0xA11CE;
        address expected = vm.addr(pk);

        bytes memory resultData = hex"deadbeef";
        bytes32 actionId = keccak256("action-1");
        string memory tag = "sigmax";
        uint8 status = 1;

        bytes32 inner = keccak256(abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes(tag)), status));
        bytes32 signed = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), block.chainid, inner));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", signed));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethSigned);

        address recovered =
            verifier.recoverActionSigner(resultData, actionId, tag, status, abi.encodePacked(r, s, v));

        assertEq(recovered, expected);
    }
}
