// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CopyVault} from "../src/CopyVault.sol";
import {CopyVaultFactory} from "../src/CopyVaultFactory.sol";

/// Pure deploy logic — no fork needed.  forge test --match-contract CopyVaultFactoryTest -vv
contract CopyVaultFactoryTest is Test {
    CopyVaultFactory factory;

    address agent = makeAddr("agent");
    address follower = makeAddr("follower");
    address follower2 = makeAddr("follower2");
    address tokenA = makeAddr("tokenA");
    address tokenB = makeAddr("tokenB");
    address router = makeAddr("router");

    uint256 constant CAP = 1000e6;

    event VaultCreated(address indexed owner, address vault);

    function setUp() public {
        factory = new CopyVaultFactory();
    }

    function _args() internal view returns (address[] memory tokens, address[] memory routers) {
        tokens = new address[](2);
        tokens[0] = tokenA;
        tokens[1] = tokenB;
        routers = new address[](1);
        routers[0] = router;
    }

    function test_createVault_configuresOwnerExecutorWhitelistCap() public {
        (address[] memory tokens, address[] memory routers) = _args();

        vm.prank(follower);
        address vaultAddr = factory.createVault(agent, tokens, routers, CAP);
        CopyVault vault = CopyVault(vaultAddr);

        assertEq(vault.owner(), follower, "owner is the follower (msg.sender)");
        assertTrue(vault.isExecutor(agent), "agent is executor");
        assertTrue(vault.tokenWhitelisted(tokenA), "tokenA whitelisted");
        assertTrue(vault.tokenWhitelisted(tokenB), "tokenB whitelisted");
        assertTrue(vault.routerWhitelisted(router), "router whitelisted");
        assertEq(vault.perTradeCap(), CAP, "cap set");
    }

    function test_vaultOf_recorded() public {
        (address[] memory tokens, address[] memory routers) = _args();

        vm.prank(follower);
        address vaultAddr = factory.createVault(agent, tokens, routers, CAP);

        assertEq(factory.vaultOf(follower), vaultAddr, "vaultOf maps follower to deployed vault");
    }

    function test_VaultCreated_event() public {
        (address[] memory tokens, address[] memory routers) = _args();

        // Predict the CREATE2 address so we can assert the exact `vault` field in the event.
        address predicted = _predict(follower, agent, tokens, routers, CAP);

        // VaultCreated has one indexed param (owner); check topic1 + data (the vault address).
        vm.expectEmit(true, false, false, true, address(factory));
        emit VaultCreated(follower, predicted);

        vm.prank(follower);
        factory.createVault(agent, tokens, routers, CAP);
    }

    function test_duplicateCreate_reverts() public {
        (address[] memory tokens, address[] memory routers) = _args();

        vm.prank(follower);
        factory.createVault(agent, tokens, routers, CAP);

        vm.prank(follower);
        vm.expectRevert(bytes("VAULT_EXISTS"));
        factory.createVault(agent, tokens, routers, CAP);
    }

    function test_distinctFollowers_getDistinctVaults() public {
        (address[] memory tokens, address[] memory routers) = _args();

        vm.prank(follower);
        address v1 = factory.createVault(agent, tokens, routers, CAP);

        vm.prank(follower2);
        address v2 = factory.createVault(agent, tokens, routers, CAP);

        assertTrue(v1 != v2, "distinct followers get distinct vaults");
        assertEq(CopyVault(v1).owner(), follower);
        assertEq(CopyVault(v2).owner(), follower2);
    }

    function test_create2_deterministic() public {
        (address[] memory tokens, address[] memory routers) = _args();

        address predicted = _predict(follower, agent, tokens, routers, CAP);

        vm.prank(follower);
        address vaultAddr = factory.createVault(agent, tokens, routers, CAP);

        assertEq(vaultAddr, predicted, "deployed address matches CREATE2 prediction");
    }

    /// @dev Mirrors the factory: salt = follower address, init code = CopyVault creation code + ctor args.
    function _predict(address owner_, address executor, address[] memory tokens, address[] memory routers, uint256 cap)
        internal
        view
        returns (address)
    {
        bytes32 salt = bytes32(uint256(uint160(owner_)));
        bytes memory initCode =
            abi.encodePacked(type(CopyVault).creationCode, abi.encode(owner_, executor, tokens, routers, cap));
        return vm.computeCreate2Address(salt, keccak256(initCode), address(factory));
    }
}
