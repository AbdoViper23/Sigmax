// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SubscriptionRegistry
/// @notice Monthly-subscription source of truth on Story L1. A leader creates a plan for their
///         strategy IP; a follower pays to subscribe; `isActive(follower, strategyId)` is the
///         eligibility gate the agent reads before opening any entry (doc contracts/12, doc 82 §D1).
/// @dev `strategyId` is the Story IP Asset address (ERC-6551), matching `SignalSchema.strategyId`
///      and the CDR read-condition encoding. Payment is split at `subscribe` time: a capped platform
///      fee to the treasury, the remainder to the leader. `subscribe` writes subscription state before
///      any external transfer (checks-effects-interactions) and is `nonReentrant`. The contract holds
///      no balance for a standard ERC-20: `payToken` MUST be a standard, non-fee-on-transfer,
///      non-rebasing token (the intended token is $WIP). Misconfigured tokens are the leader's risk.
contract SubscriptionRegistry is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant PERIOD = 30 days;
    uint64 public constant GRACE = 2 days;
    uint16 public constant MAX_FEE_BPS = 3000; // 30% ceiling guards against misconfiguration
    uint16 public constant BPS_DENOMINATOR = 10000;

    /// @notice The treasury that receives the platform fee portion of every subscription payment.
    address public immutable platformTreasury;

    struct Plan {
        address leader; // strategy owner; receives the non-fee remainder of each payment
        address payToken; // ERC-20 used to pay (e.g. $WIP on Story)
        uint256 monthlyPrice; // price for one PERIOD
        uint16 platformFeeBps; // platform cut in basis points (<= MAX_FEE_BPS)
        bool active; // leader can pause new subscriptions
    }

    struct Sub {
        uint64 expiry; // active iff block.timestamp <= expiry + GRACE
        uint64 startedAt; // first subscription timestamp (analytics)
        uint32 renewals; // number of renewals after the first subscription
    }

    /// @notice strategyId (IP Asset address) => plan.
    mapping(address => Plan) public plans;
    /// @notice strategyId => subscriber => subscription record.
    mapping(address => mapping(address => Sub)) public subs;

    event PlanCreated(
        address indexed strategyId,
        address indexed leader,
        address payToken,
        uint256 monthlyPrice,
        uint16 platformFeeBps
    );
    event PlanActiveSet(address indexed strategyId, bool active);
    event MonthlyPriceSet(address indexed strategyId, uint256 monthlyPrice);
    event Subscribed(address indexed strategyId, address indexed subscriber, uint64 newExpiry, uint256 paid);

    error PlanExists();
    error PlanMissing();
    error PlanInactive();
    error NotLeader();
    error FeeTooHigh();
    error ZeroAddress();

    modifier onlyLeader(address strategyId) {
        if (plans[strategyId].leader != msg.sender) revert NotLeader();
        _;
    }

    /// @param treasury Address that receives the platform fee portion of subscriptions.
    constructor(address treasury) {
        if (treasury == address(0)) revert ZeroAddress();
        platformTreasury = treasury;
    }

    // ----- leader: plan management -----

    /// @notice Create the plan for a strategy. The caller becomes the plan leader.
    /// @param strategyId The strategy's Story IP Asset address (also the subscription key).
    /// @param payToken ERC-20 used to pay (e.g. $WIP).
    /// @param monthlyPrice Price for one 30-day period, in `payToken` smallest units.
    /// @param platformFeeBps Platform cut in basis points; must be <= MAX_FEE_BPS.
    function createPlan(address strategyId, address payToken, uint256 monthlyPrice, uint16 platformFeeBps) external {
        if (strategyId == address(0) || payToken == address(0)) revert ZeroAddress();
        if (platformFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (plans[strategyId].leader != address(0)) revert PlanExists();

        plans[strategyId] = Plan({
            leader: msg.sender,
            payToken: payToken,
            monthlyPrice: monthlyPrice,
            platformFeeBps: platformFeeBps,
            active: true
        });

        emit PlanCreated(strategyId, msg.sender, payToken, monthlyPrice, platformFeeBps);
    }

    /// @notice Pause or resume new subscriptions for a strategy. Does not affect existing subs.
    function setPlanActive(address strategyId, bool active) external onlyLeader(strategyId) {
        plans[strategyId].active = active;
        emit PlanActiveSet(strategyId, active);
    }

    /// @notice Update the monthly price. Applies to future `subscribe` calls only.
    function setMonthlyPrice(address strategyId, uint256 monthlyPrice) external onlyLeader(strategyId) {
        plans[strategyId].monthlyPrice = monthlyPrice;
        emit MonthlyPriceSet(strategyId, monthlyPrice);
    }

    // ----- follower: subscribe / renew -----

    /// @notice Subscribe to (or renew) a strategy for one PERIOD. Pulls `monthlyPrice` in `payToken`
    ///         from the caller, splits the platform fee to the treasury and the remainder to the
    ///         leader, and extends the caller's expiry. Early renewals stack onto the current expiry.
    /// @dev Caller must `approve` this contract for `monthlyPrice` of `payToken` beforehand.
    ///      Follows checks-effects-interactions: subscription state is written before any transfer.
    function subscribe(address strategyId) external nonReentrant {
        Plan memory plan = plans[strategyId];
        if (plan.leader == address(0)) revert PlanMissing();
        if (!plan.active) revert PlanInactive();

        // ----- effects: extend the subscription before touching external tokens -----
        Sub storage s = subs[strategyId][msg.sender];
        // Stack from the later of now or the current expiry so early renewals don't lose remaining time.
        uint64 base = s.expiry > uint64(block.timestamp) ? s.expiry : uint64(block.timestamp);
        uint64 newExpiry = base + PERIOD;
        s.expiry = newExpiry;
        if (s.startedAt == 0) {
            s.startedAt = uint64(block.timestamp);
        } else {
            s.renewals += 1;
        }

        // ----- interactions: pull payment, then split fee/remainder (standard ERC-20 nets to zero) -----
        uint256 price = plan.monthlyPrice;
        if (price > 0) {
            IERC20 token = IERC20(plan.payToken);
            token.safeTransferFrom(msg.sender, address(this), price);
            uint256 fee = (price * plan.platformFeeBps) / BPS_DENOMINATOR;
            uint256 toLeader = price - fee; // rounding dust (≤1 wei) favors the leader; none retained
            if (fee > 0) token.safeTransfer(platformTreasury, fee);
            if (toLeader > 0) token.safeTransfer(plan.leader, toLeader);
        }

        emit Subscribed(strategyId, msg.sender, newExpiry, price);
    }

    // ----- views (trusted by the agent + any read condition) -----

    /// @notice True iff the subscriber is within their paid period plus the grace window.
    function isActive(address subscriber, address strategyId) public view returns (bool) {
        uint64 expiry = subs[strategyId][subscriber].expiry;
        return expiry != 0 && block.timestamp <= uint256(expiry) + GRACE;
    }

    /// @notice The subscriber's current expiry timestamp (0 if never subscribed).
    function expiryOf(address subscriber, address strategyId) external view returns (uint64) {
        return subs[strategyId][subscriber].expiry;
    }
}
