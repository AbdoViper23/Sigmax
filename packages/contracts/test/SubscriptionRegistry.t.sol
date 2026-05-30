// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {SubscriptionRegistry} from "../src/SubscriptionRegistry.sol";

/// No fork needed.  forge test --match-contract SubscriptionRegistryTest -vv
contract SubscriptionRegistryTest is Test {
    SubscriptionRegistry registry;
    ERC20Mock pay;

    address leader = makeAddr("leader");
    address treasury = makeAddr("treasury");
    address follower = makeAddr("follower");
    address stranger = makeAddr("stranger");
    // strategyId is a Story IP Asset address; any address works for unit tests.
    address strategyId = makeAddr("strategyId");

    uint256 constant PRICE = 100e18; // 100 $WIP
    uint16 constant FEE_BPS = 1500; // 15% platform cut

    function setUp() public {
        registry = new SubscriptionRegistry(treasury);
        pay = new ERC20Mock();

        vm.prank(leader);
        registry.createPlan(strategyId, address(pay), PRICE, FEE_BPS);

        // Fund the follower and approve the registry generously for multiple subscriptions.
        pay.mint(follower, 1000e18);
        vm.prank(follower);
        pay.approve(address(registry), type(uint256).max);
    }

    function test_subscribe_pullsPayment_splits85_15_andSets30d() public {
        uint256 tStart = block.timestamp;

        vm.prank(follower);
        registry.subscribe(strategyId);

        // 15% to treasury, 85% to leader.
        assertEq(pay.balanceOf(treasury), (PRICE * FEE_BPS) / 10000, "treasury gets 15%");
        assertEq(pay.balanceOf(leader), PRICE - (PRICE * FEE_BPS) / 10000, "leader gets 85%");
        assertEq(pay.balanceOf(address(registry)), 0, "registry custodies nothing");

        assertEq(registry.expiryOf(follower, strategyId), uint64(tStart + 30 days), "expiry = now + 30d");
        assertTrue(registry.isActive(follower, strategyId), "active right after subscribing");
    }

    function test_earlyRenewal_stacks_andCountsRenewal() public {
        uint256 tStart = block.timestamp;

        vm.prank(follower);
        registry.subscribe(strategyId);

        // Renew 10 days in — should stack onto the existing expiry, not reset to now+30d.
        vm.warp(tStart + 10 days);
        vm.prank(follower);
        registry.subscribe(strategyId);

        assertEq(
            registry.expiryOf(follower, strategyId),
            uint64(tStart + 60 days),
            "early renewal stacks: 30d + 30d from original expiry"
        );

        (,, uint32 renewals) = registry.subs(strategyId, follower);
        assertEq(renewals, 1, "one renewal recorded");
    }

    function test_lateRenewal_extendsFromNow() public {
        uint256 tStart = block.timestamp;

        vm.prank(follower);
        registry.subscribe(strategyId);

        // Renew well after expiry — base is now, not the stale expiry.
        vm.warp(tStart + 100 days);
        vm.prank(follower);
        registry.subscribe(strategyId);

        assertEq(
            registry.expiryOf(follower, strategyId),
            uint64(tStart + 100 days + 30 days),
            "late renewal extends from now"
        );
    }

    function test_isActive_trueWithinGrace_falseAfter() public {
        uint256 tStart = block.timestamp;

        vm.prank(follower);
        registry.subscribe(strategyId);

        // Just before expiry+grace boundary → active.
        vm.warp(tStart + 30 days + 2 days);
        assertTrue(registry.isActive(follower, strategyId), "active within grace");

        // One second past expiry+grace → inactive.
        vm.warp(tStart + 30 days + 2 days + 1);
        assertFalse(registry.isActive(follower, strategyId), "inactive after grace");
    }

    function test_isActive_falseForNeverSubscribed() public view {
        assertFalse(registry.isActive(stranger, strategyId), "never-subscribed is inactive");
    }

    function test_createPlan_feeCap_enforced() public {
        address other = makeAddr("otherStrategy");
        vm.prank(leader);
        vm.expectRevert(SubscriptionRegistry.FeeTooHigh.selector);
        registry.createPlan(other, address(pay), PRICE, 3001);
    }

    function test_createPlan_duplicate_reverts() public {
        vm.prank(leader);
        vm.expectRevert(SubscriptionRegistry.PlanExists.selector);
        registry.createPlan(strategyId, address(pay), PRICE, FEE_BPS);
    }

    function test_subscribe_revertsWhenInactive() public {
        vm.prank(leader);
        registry.setPlanActive(strategyId, false);

        vm.prank(follower);
        vm.expectRevert(SubscriptionRegistry.PlanInactive.selector);
        registry.subscribe(strategyId);
    }

    function test_subscribe_revertsWhenPlanMissing() public {
        vm.prank(follower);
        vm.expectRevert(SubscriptionRegistry.PlanMissing.selector);
        registry.subscribe(makeAddr("noPlan"));
    }

    function test_onlyLeader_setPriceAndActive() public {
        vm.prank(stranger);
        vm.expectRevert(SubscriptionRegistry.NotLeader.selector);
        registry.setMonthlyPrice(strategyId, 1);

        vm.prank(stranger);
        vm.expectRevert(SubscriptionRegistry.NotLeader.selector);
        registry.setPlanActive(strategyId, false);

        // Leader can update price; applies to next subscribe.
        vm.prank(leader);
        registry.setMonthlyPrice(strategyId, 50e18);
        (,, uint256 price,,) = registry.plans(strategyId);
        assertEq(price, 50e18, "leader updated price");
    }

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(SubscriptionRegistry.ZeroAddress.selector);
        new SubscriptionRegistry(address(0));
    }
}
