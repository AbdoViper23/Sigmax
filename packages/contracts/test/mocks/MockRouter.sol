// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Test-only swap router. Pulls `amountIn` of `tokenIn` from the caller (must be
///      approved) and sends `amountOut` of `tokenOut` back. Must be pre-funded with tokenOut.
contract MockRouter {
    function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(msg.sender, amountOut);
    }
}
