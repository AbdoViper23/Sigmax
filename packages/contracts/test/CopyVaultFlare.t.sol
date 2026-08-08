// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {CopyVaultFlare} from "../src/CopyVaultFlare.sol";
import {TeeSigVerifier} from "../src/TeeSigVerifier.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockRouter} from "./mocks/MockRouter.sol";

/// @dev CopyVaultFlare is the sig-gated Flare vault: a TEE-signed SwapAuth is the ONLY authorization
///      to swap. These tests run offline (mock ERC20 + mock router). Guard tests assert the specific
///      custom error so each pass confirms the exact guard fired.
contract CopyVaultFlareTest is Test {
    CopyVaultFlare internal vault;
    TeeSigVerifier internal verifier;
    MockERC20 internal fxrp;
    MockERC20 internal usdt0;
    MockRouter internal router;

    address internal owner = address(0xF0110E12); // the follower
    uint256 internal teeKey = 0x7EE;
    address internal teeAddr;
    uint256 internal cap = 1000e18;

    function setUp() public {
        vm.warp(1_000_000); // a nonzero baseline so past/future deadlines are unambiguous
        teeAddr = vm.addr(teeKey);
        verifier = new TeeSigVerifier();
        fxrp = new MockERC20("FXRP", "FXRP");
        usdt0 = new MockERC20("USDT0", "USDT0");
        router = new MockRouter();

        address[] memory tokens = new address[](2);
        tokens[0] = address(fxrp);
        tokens[1] = address(usdt0);
        address[] memory routers = new address[](1);
        routers[0] = address(router);

        vault = new CopyVaultFlare(owner, address(verifier), teeAddr, tokens, routers, cap);

        fxrp.mint(address(vault), 100e18); // follower's funds sit in their own vault
        usdt0.mint(address(router), 1000e18); // router liquidity
    }

    // ----- helpers -----

    function _auth(uint256 amountIn, uint256 amountOut, uint256 minOut, uint256 deadline, uint256 chainId, address vaultAddr)
        internal
        view
        returns (CopyVaultFlare.SwapAuth memory a)
    {
        a = CopyVaultFlare.SwapAuth({
            vault: vaultAddr,
            tokenIn: address(fxrp),
            tokenOut: address(usdt0),
            amountIn: amountIn,
            minOut: minOut,
            router: address(router),
            swapData: abi.encodeCall(MockRouter.swap, (address(fxrp), amountIn, address(usdt0), amountOut)),
            signalId: keccak256("sig-1"),
            deadline: deadline,
            chainId: chainId
        });
    }

    /// @dev a "good" auth for this vault (all guards satisfied) — vary one field per test.
    function _goodAuth() internal view returns (CopyVaultFlare.SwapAuth[] memory auths) {
        auths = new CopyVaultFlare.SwapAuth[](1);
        auths[0] = _auth(10e18, 28e18, 25e18, block.timestamp + 1 hours, block.chainid, address(vault));
    }

    function _signKey(uint256 key, CopyVaultFlare.SwapAuth[] memory auths, bytes32 actionId, string memory tag, uint8 status)
        internal
        view
        returns (bytes memory sig)
    {
        // Mirrors what the tee-node actually does — see TeeSigVerifier's docs and the real-signature
        // fixture in TeeSigVerifierFixture.t.sol. The Payload layer (prefix + chainId) is not optional:
        // omitting it here would let these tests pass against a verifier that rejects every real
        // signature, which is exactly the bug the fixture test caught.
        bytes memory resultData = abi.encode(auths);
        bytes32 inner = keccak256(abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes(tag)), status));
        bytes32 signed = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), block.chainid, inner));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", signed));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, ethSigned);
        sig = abi.encodePacked(r, s, v);
    }

    function _sign(CopyVaultFlare.SwapAuth[] memory auths, bytes32 actionId, string memory tag, uint8 status)
        internal
        view
        returns (bytes memory)
    {
        return _signKey(teeKey, auths, actionId, tag, status);
    }

    // ----- happy path -----

    function test_validTeeSigExecutesSwap() public {
        CopyVaultFlare.SwapAuth[] memory auths = _goodAuth();
        bytes32 actionId = keccak256("action-1");
        bytes memory sig = _sign(auths, actionId, "sigmax", 1);

        uint256 received = vault.executeSwapWithTeeSig(auths, 0, actionId, "sigmax", 1, sig);

        assertEq(received, 28e18);
        assertEq(usdt0.balanceOf(address(vault)), 28e18);
        assertEq(fxrp.balanceOf(address(vault)), 90e18);
    }

    // ----- guard reverts -----

    function test_revertsOnBadStatus() public {
        CopyVaultFlare.SwapAuth[] memory auths = _goodAuth();
        bytes32 actionId = keccak256("action-1");
        bytes memory sig = _sign(auths, actionId, "sigmax", 0);
        vm.expectRevert(CopyVaultFlare.BadStatus.selector);
        vault.executeSwapWithTeeSig(auths, 0, actionId, "sigmax", 0, sig);
    }

    function test_revertsOnWrongSigner() public {
        CopyVaultFlare.SwapAuth[] memory auths = _goodAuth();
        bytes32 actionId = keccak256("action-1");
        bytes memory sig = _signKey(0xBADBEEF, auths, actionId, "sigmax", 1); // not the TEE key
        vm.expectRevert(CopyVaultFlare.BadTeeSignature.selector);
        vault.executeSwapWithTeeSig(auths, 0, actionId, "sigmax", 1, sig);
    }

    function test_revertsOnWrongVault() public {
        CopyVaultFlare.SwapAuth[] memory auths = new CopyVaultFlare.SwapAuth[](1);
        auths[0] = _auth(10e18, 28e18, 25e18, block.timestamp + 1 hours, block.chainid, address(0xDEAD));
        bytes32 actionId = keccak256("action-1");
        bytes memory sig = _sign(auths, actionId, "sigmax", 1);
        vm.expectRevert(CopyVaultFlare.WrongVault.selector);
        vault.executeSwapWithTeeSig(auths, 0, actionId, "sigmax", 1, sig);
    }

    function test_revertsOnWrongChain() public {
        CopyVaultFlare.SwapAuth[] memory auths = new CopyVaultFlare.SwapAuth[](1);
        auths[0] = _auth(10e18, 28e18, 25e18, block.timestamp + 1 hours, block.chainid + 1, address(vault));
        bytes32 actionId = keccak256("action-1");
        bytes memory sig = _sign(auths, actionId, "sigmax", 1);
        vm.expectRevert(CopyVaultFlare.WrongChain.selector);
        vault.executeSwapWithTeeSig(auths, 0, actionId, "sigmax", 1, sig);
    }

    function test_revertsOnExpiredDeadline() public {
        CopyVaultFlare.SwapAuth[] memory auths = new CopyVaultFlare.SwapAuth[](1);
        auths[0] = _auth(10e18, 28e18, 25e18, block.timestamp - 1, block.chainid, address(vault));
        bytes32 actionId = keccak256("action-1");
        bytes memory sig = _sign(auths, actionId, "sigmax", 1);
        vm.expectRevert(CopyVaultFlare.AuthExpired.selector);
        vault.executeSwapWithTeeSig(auths, 0, actionId, "sigmax", 1, sig);
    }

    function test_revertsOnReplay() public {
        CopyVaultFlare.SwapAuth[] memory auths = _goodAuth();
        bytes32 actionId = keccak256("action-1");
        bytes memory sig = _sign(auths, actionId, "sigmax", 1);

        vault.executeSwapWithTeeSig(auths, 0, actionId, "sigmax", 1, sig); // first use OK

        vm.expectRevert(CopyVaultFlare.AuthAlreadyUsed.selector);
        vault.executeSwapWithTeeSig(auths, 0, actionId, "sigmax", 1, sig); // replay rejected
    }

    function test_revertsOnCapExceeded() public {
        CopyVaultFlare.SwapAuth[] memory auths = new CopyVaultFlare.SwapAuth[](1);
        auths[0] = _auth(2000e18, 28e18, 25e18, block.timestamp + 1 hours, block.chainid, address(vault)); // > cap
        bytes32 actionId = keccak256("action-1");
        bytes memory sig = _sign(auths, actionId, "sigmax", 1);
        vm.expectRevert(CopyVaultFlare.CapExceeded.selector);
        vault.executeSwapWithTeeSig(auths, 0, actionId, "sigmax", 1, sig);
    }

    function test_revertsOnNonWhitelistedToken() public {
        MockERC20 other = new MockERC20("OTHER", "OTH");
        CopyVaultFlare.SwapAuth[] memory auths = new CopyVaultFlare.SwapAuth[](1);
        auths[0] = CopyVaultFlare.SwapAuth({
            vault: address(vault),
            tokenIn: address(other), // not whitelisted
            tokenOut: address(usdt0),
            amountIn: 10e18,
            minOut: 25e18,
            router: address(router),
            swapData: "",
            signalId: keccak256("sig-1"),
            deadline: block.timestamp + 1 hours,
            chainId: block.chainid
        });
        bytes32 actionId = keccak256("action-1");
        bytes memory sig = _sign(auths, actionId, "sigmax", 1);
        vm.expectRevert(CopyVaultFlare.TokenNotWhitelisted.selector);
        vault.executeSwapWithTeeSig(auths, 0, actionId, "sigmax", 1, sig);
    }

    function test_onlyOwnerCanWithdraw() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(CopyVaultFlare.NotOwner.selector);
        vault.withdraw(address(fxrp), 1e18);

        vm.prank(owner);
        vault.withdraw(address(fxrp), 10e18);
        assertEq(fxrp.balanceOf(owner), 10e18);
    }

    function test_setTeeAddressOnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(CopyVaultFlare.NotOwner.selector);
        vault.setTeeAddress(address(0x1234));

        vm.prank(owner);
        vault.setTeeAddress(address(0x1234));
        assertEq(vault.teeAddress(), address(0x1234));
    }
}
