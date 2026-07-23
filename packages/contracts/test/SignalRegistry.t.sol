// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {SignalRegistry} from "../src/SignalRegistry.sol";

contract SignalRegistryTest is Test {
    SignalRegistry internal reg;

    // mirror of the contract event for expectEmit
    event SignalPublished(
        address indexed leader,
        address indexed strategyId,
        uint256 indexed index,
        bytes32 ciphertextHash,
        string uri,
        uint256 timestamp
    );

    function setUp() public {
        vm.warp(1_000_000);
        reg = new SignalRegistry();
    }

    function test_publishRecordsAndEmits() public {
        address strat = makeAddr("strategy");
        bytes32 h = keccak256("ciphertext-1");

        vm.expectEmit(true, true, true, true);
        emit SignalPublished(address(this), strat, 0, h, "ipfs://x", block.timestamp);

        uint256 idx = reg.publishSignal(strat, h, "ipfs://x");

        assertEq(idx, 0);
        assertEq(reg.signalCount(strat), 1);
        assertEq(reg.commitOf(strat, 0), h);
    }

    function test_indexIncrementsPerStrategy() public {
        address strat = makeAddr("strategy");
        reg.publishSignal(strat, keccak256("a"), "");
        uint256 idx2 = reg.publishSignal(strat, keccak256("b"), "");
        assertEq(idx2, 1);
        assertEq(reg.signalCount(strat), 2);
        assertEq(reg.commitOf(strat, 1), keccak256("b"));
    }

    function test_strategiesAreIndependent() public {
        address stratA = makeAddr("A");
        address stratB = makeAddr("B");
        reg.publishSignal(stratA, keccak256("a"), "");
        assertEq(reg.signalCount(stratA), 1);
        assertEq(reg.signalCount(stratB), 0);
    }
}
