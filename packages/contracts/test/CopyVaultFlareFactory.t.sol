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

/**
 * `createVaultAndDeposit` exists to collapse onboarding from two signatures to one. These tests pin
 * the properties that make that safe: the factory must never end up holding the follower's tokens,
 * and it must not fund a token the vault would then refuse to trade.
 */
contract CreateVaultAndDepositTest is Test {
    CopyVaultFlareFactory internal factory;
    TeeSigVerifier internal verifier;
    address internal teeAddr = makeAddr("tee");
    address internal router = makeAddr("router");
    address internal follower = makeAddr("follower");
    MockERC20 internal fxrp;
    MockERC20 internal stray;

    function setUp() public {
        verifier = new TeeSigVerifier();
        factory = new CopyVaultFlareFactory(address(verifier), teeAddr);
        fxrp = new MockERC20("FXRP", "FXRP");
        stray = new MockERC20("STRAY", "STRAY");
        fxrp.mint(follower, 100e18);
        stray.mint(follower, 100e18);
    }

    function _tokens() internal view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(fxrp);
    }

    function _routers() internal view returns (address[] memory r) {
        r = new address[](1);
        r[0] = router;
    }

    function test_createsAndFundsInOneCall() public {
        vm.startPrank(follower);
        fxrp.approve(address(factory), 10e18);
        address vault = factory.createVaultAndDeposit(_tokens(), _routers(), 500e18, address(fxrp), 10e18);
        vm.stopPrank();

        assertEq(factory.vaultOf(follower), vault, "vault registered to the follower");
        assertEq(CopyVaultFlare(vault).owner(), follower, "follower owns it");
        assertEq(fxrp.balanceOf(vault), 10e18, "funds landed in the vault");
        assertEq(fxrp.balanceOf(follower), 90e18, "pulled from the follower");
    }

    /// The factory is a deployer, not a custodian. If it ever held a balance mid-call, a reentrant
    /// token could take it — so assert the funds never route through the factory at all.
    function test_factoryNeverHoldsTheTokens() public {
        vm.startPrank(follower);
        fxrp.approve(address(factory), 10e18);
        factory.createVaultAndDeposit(_tokens(), _routers(), 500e18, address(fxrp), 10e18);
        vm.stopPrank();

        assertEq(fxrp.balanceOf(address(factory)), 0, "factory holds nothing");
    }

    /// Funding a token the vault will not trade would strand it: only `withdraw` could get it back.
    function test_revertsWhenTokenIsNotWhitelistedOnTheVault() public {
        vm.startPrank(follower);
        stray.approve(address(factory), 10e18);
        vm.expectRevert(CopyVaultFlareFactory.TokenNotWhitelisted.selector);
        factory.createVaultAndDeposit(_tokens(), _routers(), 500e18, address(stray), 10e18);
        vm.stopPrank();
    }

    function test_revertsOnZeroAmount() public {
        vm.prank(follower);
        vm.expectRevert(CopyVaultFlareFactory.NothingToDeposit.selector);
        factory.createVaultAndDeposit(_tokens(), _routers(), 500e18, address(fxrp), 0);
    }

    function test_revertsIfTheCallerAlreadyHasAVault() public {
        vm.startPrank(follower);
        factory.createVault(_tokens(), _routers(), 500e18);
        fxrp.approve(address(factory), 10e18);
        vm.expectRevert(CopyVaultFlareFactory.VaultExists.selector);
        factory.createVaultAndDeposit(_tokens(), _routers(), 500e18, address(fxrp), 10e18);
        vm.stopPrank();
    }

    /// Without an approval the pull must fail and take the whole call with it — no orphan vault
    /// recorded against an owner whose deposit never happened.
    function test_revertsWithoutApprovalAndLeavesNoVault() public {
        vm.prank(follower);
        vm.expectRevert();
        factory.createVaultAndDeposit(_tokens(), _routers(), 500e18, address(fxrp), 10e18);

        assertEq(factory.vaultOf(follower), address(0), "no vault recorded");
    }

    /// The one-signature path must produce exactly the vault the two-step path would have.
    function test_matchesTheAddressPredictedForTheTwoStepPath() public {
        address predicted = factory.predictVault(follower, _tokens(), _routers(), 500e18);

        vm.startPrank(follower);
        fxrp.approve(address(factory), 10e18);
        address vault = factory.createVaultAndDeposit(_tokens(), _routers(), 500e18, address(fxrp), 10e18);
        vm.stopPrank();

        assertEq(vault, predicted, "deterministic address is unchanged");
    }
}
