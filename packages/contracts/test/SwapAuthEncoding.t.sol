// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {CopyVaultFlare} from "../src/CopyVaultFlare.sol";

/// @dev Pins that Solidity's abi.encode(SwapAuth[]) equals the TS `encodeSwapAuths` output for a fixed
///      vector. This is the byte string the TEE node signs (ActionResult) and each vault recomputes to
///      verify the signature, so TS<->Solidity ABI equality is load-bearing. The expected hex is the
///      output of the matching TS test (packages/agent flare-encoding-vector).
contract SwapAuthEncodingTest is Test {
    function _fixedAuths() internal pure returns (CopyVaultFlare.SwapAuth[] memory auths) {
        auths = new CopyVaultFlare.SwapAuth[](1);
        auths[0] = CopyVaultFlare.SwapAuth({
            vault: address(0x1),
            tokenIn: address(0x2),
            tokenOut: address(0x3),
            amountIn: 5_000000,
            minOut: 9_500000,
            router: address(0x4),
            swapData: hex"deadbeef",
            signalId: bytes32(uint256(255)),
            deadline: 1784900000,
            chainId: 114
        });
    }

    /// @dev Run with -vvv to read the encoding; used to lock the expected hex in test_matchesTsVector.
    function test_logEncoding() public pure {
        console2.logBytes(abi.encode(_fixedAuths()));
    }

    /// @dev Locks parity with the TS `encodeSwapAuths` vector (packages/agent flare-encoding-vector).
    function test_matchesTsVector() public pure {
        bytes memory expected = hex"0000000000000000000000000000000000000000000000000000000000000020"
            hex"0000000000000000000000000000000000000000000000000000000000000001"
            hex"0000000000000000000000000000000000000000000000000000000000000020"
            hex"0000000000000000000000000000000000000000000000000000000000000001"
            hex"0000000000000000000000000000000000000000000000000000000000000002"
            hex"0000000000000000000000000000000000000000000000000000000000000003"
            hex"00000000000000000000000000000000000000000000000000000000004c4b40"
            hex"000000000000000000000000000000000000000000000000000000000090f560"
            hex"0000000000000000000000000000000000000000000000000000000000000004"
            hex"0000000000000000000000000000000000000000000000000000000000000140"
            hex"00000000000000000000000000000000000000000000000000000000000000ff"
            hex"000000000000000000000000000000000000000000000000000000006a6369a0"
            hex"0000000000000000000000000000000000000000000000000000000000000072"
            hex"0000000000000000000000000000000000000000000000000000000000000004"
            hex"deadbeef00000000000000000000000000000000000000000000000000000000";
        assertEq(abi.encode(_fixedAuths()), expected);
    }
}
