// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {CopyVaultFlareFactory} from "../src/CopyVaultFlareFactory.sol";
import {CopyVaultFlare} from "../src/CopyVaultFlare.sol";
import {TeeSigVerifier} from "../src/TeeSigVerifier.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract CopyVaultFlareFactoryTest is Test {
    CopyVaultFlareFactory internal factory;
    TeeSigVerifier internal verifier;
    address internal teeAddr = makeAddr("tee");
    address internal router = makeAddr("router");
    address internal follower = makeAddr("follower");
    MockERC20 internal fxrp;
    MockERC20 internal usdt0;

    function setUp() public {
        verifier = new TeeSigVerifier();
        factory = new CopyVaultFlareFactory(address(verifier), teeAddr);
        fxrp = new MockERC20("FXRP", "FXRP");
        usdt0 = new MockERC20("USDT0", "USDT0");
    }

    function _tokens() internal view returns (address[] memory t) {
        t = new address[](2);
        t[0] = address(fxrp);
        t[1] = address(usdt0);
    }

    function _routers() internal view returns (address[] memory r) {
        r = new address[](1);
        r[0] = router;
    }

    function test_createsVaultOwnedByCallerWithConfig() public {
        vm.prank(follower);
        address vaultAddr = factory.createVault(_tokens(), _routers(), 500e18);

        assertEq(factory.vaultOf(follower), vaultAddr);
        CopyVaultFlare vault = CopyVaultFlare(vaultAddr);
        assertEq(vault.owner(), follower);
        assertEq(vault.teeAddress(), teeAddr);
        assertEq(address(vault.teeVerifier()), address(verifier));
        assertTrue(vault.tokenWhitelisted(address(fxrp)));
        assertTrue(vault.tokenWhitelisted(address(usdt0)));
        assertTrue(vault.routerWhitelisted(router));
        assertEq(vault.perTradeCap(), 500e18);
    }

    function test_revertsOnSecondVaultForSameOwner() public {
        vm.startPrank(follower);
        factory.createVault(_tokens(), _routers(), 500e18);
        vm.expectRevert(CopyVaultFlareFactory.VaultExists.selector);
        factory.createVault(_tokens(), _routers(), 500e18);
        vm.stopPrank();
    }

    function test_vaultAddressIsDeterministic() public {
        address predicted = factory.predictVault(follower, _tokens(), _routers(), 500e18);
        vm.prank(follower);
        address vaultAddr = factory.createVault(_tokens(), _routers(), 500e18);
        assertEq(vaultAddr, predicted);
    }
}
