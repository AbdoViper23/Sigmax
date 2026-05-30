// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CopyVault} from "../src/CopyVault.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

/// Run against a fork:  forge test --fork-url $ARBITRUM_RPC_URL -vv
contract CopyVaultTest is Test {
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45; // Uniswap SwapRouter02

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    CopyVault vault;

    function setUp() public {
        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WETH;
        address[] memory routers = new address[](1);
        routers[0] = ROUTER;
        vault = new CopyVault(owner, agent, tokens, routers, 1000e6); // cap = 1000 USDC
        deal(USDC, address(vault), 1000e6);
    }

    function _swapData(uint256 amountIn, uint256 routerMinOut) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            ISwapRouter02.exactInputSingle.selector,
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: address(vault),
                amountIn: amountIn,
                amountOutMinimum: routerMinOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function test_executeSwap_realSwapOnFork() public {
        uint256 amountIn = 100e6;
        uint256 minOut = 1e16; // 0.01 WETH floor — robust to price
        vm.prank(agent);
        uint256 received = vault.executeSwap(USDC, amountIn, WETH, minOut, ROUTER, _swapData(amountIn, minOut));
        assertGe(received, minOut);
        assertEq(IERC20(WETH).balanceOf(address(vault)), received);
        // approval was reset to 0 after the swap
        assertEq(IERC20(USDC).allowance(address(vault), ROUTER), 0);
    }

    function test_nonExecutor_cannotSwap() public {
        vm.prank(stranger);
        vm.expectRevert(CopyVault.NotExecutor.selector);
        vault.executeSwap(USDC, 100e6, WETH, 0, ROUTER, _swapData(100e6, 0));
    }

    function test_revokedExecutor_cannotSwap() public {
        vm.prank(owner);
        vault.setExecutor(agent, false);
        vm.prank(agent);
        vm.expectRevert(CopyVault.NotExecutor.selector);
        vault.executeSwap(USDC, 100e6, WETH, 0, ROUTER, _swapData(100e6, 0));
    }

    function test_capExceeded() public {
        vm.prank(agent);
        vm.expectRevert(CopyVault.CapExceeded.selector);
        vault.executeSwap(USDC, 2000e6, WETH, 0, ROUTER, _swapData(2000e6, 0));
    }

    function test_nonWhitelistedToken() public {
        address random = makeAddr("randomToken");
        vm.prank(agent);
        vm.expectRevert(CopyVault.TokenNotWhitelisted.selector);
        vault.executeSwap(random, 100e6, WETH, 0, ROUTER, _swapData(100e6, 0));
    }

    function test_minOut_backstop_reverts() public {
        uint256 amountIn = 100e6;
        // router has no floor (0), but the vault's own minOut backstop is absurdly high → revert
        vm.prank(agent);
        vm.expectRevert(CopyVault.MinOut.selector);
        vault.executeSwap(USDC, amountIn, WETH, 100e18, ROUTER, _swapData(amountIn, 0));
    }

    function test_onlyOwner_withdraw() public {
        vm.prank(stranger);
        vm.expectRevert(CopyVault.NotOwner.selector);
        vault.withdraw(USDC, 1e6);

        vm.prank(owner);
        vault.withdraw(USDC, 1e6);
        assertEq(IERC20(USDC).balanceOf(owner), 1e6);
    }
}
