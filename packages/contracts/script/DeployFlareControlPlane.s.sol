// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TeeSigVerifier} from "../src/TeeSigVerifier.sol";
import {CopyVaultFlareFactory} from "../src/CopyVaultFlareFactory.sol";
import {SignalRegistry} from "../src/SignalRegistry.sol";
import {SubscriptionRegistry} from "../src/SubscriptionRegistry.sol";

/// @notice Deploys the Sigmax Flare control plane to Coston2 (chain 114).
/// @dev Reads from env: PRIVATE_KEY (funded Coston2 deployer), TEE_ADDRESS (the attested TEE identity
///      recorded by the Phase 0a spike), PLATFORM_TREASURY. Coston2 supports EIP-1559 (no --legacy):
///        forge script script/DeployFlareControlPlane.s.sol \
///          --rpc-url https://coston2-api.flare.network/ext/C/rpc --broadcast
///      Record the printed addresses in docs/flare/reference/phase-0-findings.md.
contract DeployFlareControlPlane is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address teeAddress = vm.envAddress("TEE_ADDRESS");
        address treasury = vm.envAddress("PLATFORM_TREASURY");

        vm.startBroadcast(deployerKey);
        TeeSigVerifier verifier = new TeeSigVerifier();
        CopyVaultFlareFactory factory = new CopyVaultFlareFactory(address(verifier), teeAddress);
        SignalRegistry signals = new SignalRegistry();
        SubscriptionRegistry subs = new SubscriptionRegistry(treasury);
        vm.stopBroadcast();

        console2.log("TeeSigVerifier:       ", address(verifier));
        console2.log("CopyVaultFlareFactory:", address(factory));
        console2.log("SignalRegistry:       ", address(signals));
        console2.log("SubscriptionRegistry: ", address(subs));
        console2.log("teeAddress:           ", teeAddress);
        console2.log("platformTreasury:     ", treasury);
    }
}
