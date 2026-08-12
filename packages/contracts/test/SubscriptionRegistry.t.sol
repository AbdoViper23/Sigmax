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
    string constant USERNAME = "momentum_alpha";
    string constant DISPLAY_NAME = "Momentum Alpha";

    function setUp() public {
        registry = new SubscriptionRegistry(treasury);
        pay = new ERC20Mock();

        vm.prank(leader);
        registry.createPlan(strategyId, address(pay), PRICE, FEE_BPS, USERNAME, DISPLAY_NAME);

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
        registry.createPlan(other, address(pay), PRICE, 3001, USERNAME, DISPLAY_NAME);
    }

    function test_createPlan_duplicate_reverts() public {
        vm.prank(leader);
        vm.expectRevert(SubscriptionRegistry.PlanExists.selector);
        registry.createPlan(strategyId, address(pay), PRICE, FEE_BPS, USERNAME, DISPLAY_NAME);
    }

    function test_createPlan_emitsProfileLabels() public {
        address other = makeAddr("otherStrategy");
        vm.expectEmit(true, true, false, true, address(registry));
        emit SubscriptionRegistry.PlanCreated(
            other, leader, address(pay), PRICE, FEE_BPS, "deep_value", "Deep Value"
        );
        vm.prank(leader);
        registry.createPlan(other, address(pay), PRICE, FEE_BPS, "deep_value", "Deep Value");
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

    function test_cancel_deactivatesImmediately_andEmits() public {
        vm.prank(follower);
        registry.subscribe(strategyId);
        assertTrue(registry.isActive(follower, strategyId), "active after subscribe");

        vm.expectEmit(true, true, false, false, address(registry));
        emit SubscriptionRegistry.SubscriptionCancelled(strategyId, follower);
        vm.prank(follower);
        registry.cancel(strategyId);

        assertFalse(registry.isActive(follower, strategyId), "inactive immediately after cancel");
        assertEq(registry.expiryOf(follower, strategyId), 0, "expiry reset to 0");
    }

    function test_cancel_revertsWhenNeverSubscribed() public {
        vm.prank(stranger);
        vm.expectRevert(SubscriptionRegistry.NotSubscribed.selector);
        registry.cancel(strategyId);
    }

    function test_resubscribe_afterCancel_startsFreshPeriod() public {
        uint256 tStart = block.timestamp;
        vm.prank(follower);
        registry.subscribe(strategyId);

        vm.warp(tStart + 5 days);
        vm.prank(follower);
        registry.cancel(strategyId);
        assertFalse(registry.isActive(follower, strategyId), "inactive after cancel");

        // Re-subscribe a few days later: base is `now` (expiry was 0), so a full fresh PERIOD.
        vm.warp(tStart + 8 days);
        vm.prank(follower);
        registry.subscribe(strategyId);
        assertEq(
            registry.expiryOf(follower, strategyId),
            uint64(tStart + 8 days + 30 days),
            "re-subscribe starts a fresh 30d period from now"
        );
        assertTrue(registry.isActive(follower, strategyId), "active again after re-subscribe");
    }
}

/**
 * Plan enumeration.
 *
 * The leaderboard's load time is the reason this exists. With only `mapping(address => Plan)`, listing
 * leaders means scanning `PlanCreated` from the deploy block — and the public Coston2 RPC caps
 * `eth_getLogs` at 30 blocks, so that is thousands of sequential requests from a browser. These tests
 * pin the array's two load-bearing properties: it never duplicates, and paging never reverts.
 */
contract SubscriptionRegistryEnumerationTest is Test {
    SubscriptionRegistry internal reg;
    ERC20Mock internal pay;
    address internal treasury = makeAddr("treasury");
    address internal leaderA = makeAddr("leaderA");
    address internal leaderB = makeAddr("leaderB");
    address internal stratA = makeAddr("stratA");
    address internal stratB = makeAddr("stratB");

    function setUp() public {
        reg = new SubscriptionRegistry(treasury);
        pay = new ERC20Mock();
    }

    function _create(address leader, address strategyId, uint256 price) internal {
        vm.prank(leader);
        reg.createPlan(strategyId, address(pay), price, 1500, "u", "d");
    }

    function test_countStartsAtZero() public view {
        assertEq(reg.strategyCount(), 0);
    }

    function test_createPlanAppendsInOrder() public {
        _create(leaderA, stratA, 1e6);
        _create(leaderB, stratB, 2e6);

        assertEq(reg.strategyCount(), 2, "both recorded");
        assertEq(reg.strategyIds(0), stratA, "creation order preserved");
        assertEq(reg.strategyIds(1), stratB);
    }

    /// A duplicate would make the leaderboard show the same leader twice.
    function test_cannotAppendTheSameStrategyTwice() public {
        _create(leaderA, stratA, 1e6);

        vm.prank(leaderB);
        vm.expectRevert(SubscriptionRegistry.PlanExists.selector);
        reg.createPlan(stratA, address(pay), 5e6, 1500, "u", "d");

        assertEq(reg.strategyCount(), 1, "no duplicate appended");
    }

    function test_listPlansReturnsIdsWithTheirPlans() public {
        _create(leaderA, stratA, 1e6);
        _create(leaderB, stratB, 2e6);

        (address[] memory ids, SubscriptionRegistry.Plan[] memory found) = reg.listPlans(0, 10);

        assertEq(ids.length, 2, "both returned");
        assertEq(ids[0], stratA);
        assertEq(found[0].leader, leaderA, "plan travels with its id");
        assertEq(found[0].monthlyPrice, 1e6);
        assertEq(ids[1], stratB);
        assertEq(found[1].leader, leaderB);
        assertEq(found[1].monthlyPrice, 2e6);
    }

    function test_listPlansPages() public {
        _create(leaderA, stratA, 1e6);
        _create(leaderB, stratB, 2e6);

        (address[] memory first,) = reg.listPlans(0, 1);
        assertEq(first.length, 1, "limit respected");
        assertEq(first[0], stratA);

        (address[] memory second,) = reg.listPlans(1, 1);
        assertEq(second[0], stratB, "second page continues");
    }

    /// A client pages until it gets a short result; that must not require reading the count first.
    function test_listPlansClampsAndDoesNotRevertPastTheEnd() public {
        _create(leaderA, stratA, 1e6);

        (address[] memory clamped,) = reg.listPlans(0, 100);
        assertEq(clamped.length, 1, "limit clamped to length");

        (address[] memory past, SubscriptionRegistry.Plan[] memory pastPlans) = reg.listPlans(5, 10);
        assertEq(past.length, 0, "past the end is empty, not a revert");
        assertEq(pastPlans.length, 0);
    }
}
