// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SubscriptionRegistry} from "../src/SubscriptionRegistry.sol";

/// @notice Deploys SubscriptionRegistry to Story Aeneid.
/// @dev Reads STORY_IP_KEY (funded Aeneid deployer) and PLATFORM_TREASURY from env.
///      Run with `--legacy` (Story RPC rejects EIP-1559 typed txs):
///        forge script script/DeploySubscriptionRegistry.s.sol \
///          --rpc-url $STORY_RPC_URL --broadcast --legacy
contract DeploySubscriptionRegistry is Script {
    function run() external returns (SubscriptionRegistry registry) {
        uint256 deployerKey = vm.envUint("STORY_IP_KEY");
        address treasury = vm.envAddress("PLATFORM_TREASURY");

        vm.startBroadcast(deployerKey);
        registry = new SubscriptionRegistry(treasury);
        vm.stopBroadcast();

        console2.log("SubscriptionRegistry:", address(registry));
        console2.log("treasury:", treasury);
    }
}
