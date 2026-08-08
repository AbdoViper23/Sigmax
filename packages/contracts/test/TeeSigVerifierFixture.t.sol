// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TeeSigVerifier} from "../src/TeeSigVerifier.sol";

/// @title TeeSigVerifierFixture
/// @notice Pins `TeeSigVerifier` to a REAL signature produced by a registered Coston2 TEE machine.
///
/// @dev This is the Phase 0a gate: the design spec required proving that an on-chain `ecrecover` of a
///      genuine FCC `ActionResult` signature returns the registered `teeAddress`, before trusting the
///      vault's swap gate. Everything below was captured from a live run on 2026-08-08:
///
///        extension id   0x…101e1  (66017)
///        TEE machine    0xBe8E238d68c6AA58EfDE1Ef08F843ed75eDe1BaB  (status 2 = PRODUCTION)
///        instruction    KEY/UPDATE, fetched from the proxy at /action/result/<id>
///
///      Capturing this caught a real bug. The first implementation hashed only
///      `keccak256(keccak256(data), actionId, keccak256(tag), status)` and personal-signed that,
///      copying the fce-weather-insurance example. The tee-node actually wraps that hash in a
///      `Payload{prefix, chainId, dataHash}` before signing, which domain-separates by chain and by
///      payload kind. Without that layer every genuine TEE signature would have been rejected and no
///      follower swap could ever have executed. This test fails if that regresses.
contract TeeSigVerifierFixtureTest is Test {
    TeeSigVerifier internal verifier;

    /// The TEE machine's signing identity — the same address registered on the FlareTeeManager.
    /// NOTE: this is the *signing* key. The `publicKey` in the proxy's /info is the enclave's ECIES
    /// *encryption* key and derives to a different address — do not use that one as `teeAddress`.
    address internal constant TEE_ADDRESS = 0xBe8E238d68c6AA58EfDE1Ef08F843ed75eDe1BaB;

    uint256 internal constant COSTON2_CHAIN_ID = 114;

    bytes internal constant RESULT_DATA = hex"";
    bytes32 internal constant ACTION_ID = 0x819fbe01b97a5f59ab55c2f1b25428ffc9c7db04967600497c5a1a888e57a314;
    string internal constant SUBMISSION_TAG = "threshold";
    uint8 internal constant STATUS = 1;
    bytes internal constant SIGNATURE =
        hex"4db1b9000141a178b2225750368fcb95742ca2fba667f34bed983e303cd4694d787ccd006b4d1774944ea743421b136dfe461b97cac4ae9e502a12947923b75500";

    function setUp() public {
        verifier = new TeeSigVerifier();
    }

    /// The whole point: a real TEE signature recovers the registered machine address.
    function test_recoversRegisteredTeeAddress() public view {
        address signer = verifier.recoverActionSignerForChain(
            RESULT_DATA, ACTION_ID, SUBMISSION_TAG, STATUS, SIGNATURE, COSTON2_CHAIN_ID
        );
        assertEq(signer, TEE_ADDRESS, "real TEE signature must recover the registered machine");
    }

    /// On Coston2 the convenience overload (which reads block.chainid) must agree with the explicit one.
    function test_chainIdOverloadAgreesOnCoston2() public {
        vm.chainId(COSTON2_CHAIN_ID);
        address signer = verifier.recoverActionSigner(RESULT_DATA, ACTION_ID, SUBMISSION_TAG, STATUS, SIGNATURE);
        assertEq(signer, TEE_ADDRESS);
    }

    /// The chain id is bound into the signature, so the same result signed for one chain must not
    /// verify on another. This is the replay protection the Payload layer buys us.
    function test_wrongChainIdDoesNotRecover() public view {
        address signer = verifier.recoverActionSignerForChain(
            RESULT_DATA, ACTION_ID, SUBMISSION_TAG, STATUS, SIGNATURE, 1 // Ethereum mainnet
        );
        assertTrue(signer != TEE_ADDRESS, "a signature for chain 114 must not verify as chain 1");
    }

    /// Tampering with any signed field must break recovery — otherwise the authorization is malleable.
    function test_tamperedFieldsDoNotRecover() public view {
        address a = verifier.recoverActionSignerForChain(
            RESULT_DATA, bytes32(uint256(ACTION_ID) + 1), SUBMISSION_TAG, STATUS, SIGNATURE, COSTON2_CHAIN_ID
        );
        assertTrue(a != TEE_ADDRESS, "tampered actionId must not recover");

        address b = verifier.recoverActionSignerForChain(
            RESULT_DATA, ACTION_ID, "threshold2", STATUS, SIGNATURE, COSTON2_CHAIN_ID
        );
        assertTrue(b != TEE_ADDRESS, "tampered submissionTag must not recover");

        address c =
            verifier.recoverActionSignerForChain(RESULT_DATA, ACTION_ID, SUBMISSION_TAG, 2, SIGNATURE, COSTON2_CHAIN_ID);
        assertTrue(c != TEE_ADDRESS, "tampered status must not recover");

        address d = verifier.recoverActionSignerForChain(
            hex"deadbeef", ACTION_ID, SUBMISSION_TAG, STATUS, SIGNATURE, COSTON2_CHAIN_ID
        );
        assertTrue(d != TEE_ADDRESS, "tampered resultData must not recover");
    }

    /// The prefix is what separates an ActionResult signature from a vote signature.
    function test_prefixIsTheDocumentedConstant() public view {
        assertEq(verifier.TEE_ACTION_RESULT_PREFIX(), bytes32("TEE_ACTION_RESULT"));
    }
}
