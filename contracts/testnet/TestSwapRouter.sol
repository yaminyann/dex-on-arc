// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title TestSwapRouter
/// @notice TESTNET ONLY. Swaps at the TestPriceFeed price minus a fixed fee, standing in for a real
///         aggregator on a network that has none. It pulls the input with transferFrom from the
///         caller (the same shape as the real aggregator flow) and pays the output either by minting
///         (test tokens) or from its own balance (USDC, which must be funded). Never deploy to mainnet.
contract TestSwapRouter {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 10;
    address public immutable admin;
    mapping(address => address) public feeds;

    error NotAdmin();
    error NoFeed(address token);
    error BadPrice(address token);
    error InsufficientLiquidity(address token, uint256 wanted, uint256 have);
    error ZeroAmount();

    event FeedSet(address indexed token, address indexed feed);
    event Swapped(address indexed trader, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(address admin_) {
        admin = admin_;
    }

    function setFeed(address token, address feed) external {
        if (msg.sender != admin) revert NotAdmin();
        feeds[token] = feed;
        emit FeedSet(token, feed);
    }

    /// @notice Output for `amountIn` at the current feed prices, after the fee.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 pIn = _usd18(tokenIn);
        uint256 pOut = _usd18(tokenOut);
        uint256 dIn = IERC20Metadata(tokenIn).decimals();
        uint256 dOut = IERC20Metadata(tokenOut).decimals();
        uint256 gross = Math.mulDiv(amountIn, pIn * 10 ** dOut, pOut * 10 ** dIn);
        return Math.mulDiv(gross, 10_000 - FEE_BPS, 10_000);
    }

    /// @notice Sells exactly `amountIn` of `tokenIn` from the caller for `tokenOut`, paid to the caller.
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 out) {
        if (amountIn == 0) revert ZeroAmount();
        out = quote(tokenIn, tokenOut, amountIn);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        try IMintable(tokenOut).mint(msg.sender, out) {
            // test token minted on demand
        } catch {
            uint256 have = IERC20(tokenOut).balanceOf(address(this));
            if (have < out) revert InsufficientLiquidity(tokenOut, out, have);
            IERC20(tokenOut).safeTransfer(msg.sender, out);
        }
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, out);
    }

    function _usd18(address token) private view returns (uint256) {
        address feed = feeds[token];
        if (feed == address(0)) revert NoFeed(token);
        (, int256 answer,,,) = IFeed(feed).latestRoundData();
        if (answer <= 0) revert BadPrice(token);
        return uint256(answer) * 10 ** (18 - IFeed(feed).decimals());
    }
}
