// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {MockERC20, MockAggregator, MockSwapTarget, MaliciousSwapTarget} from "./ArcTradeMocks.sol";

abstract contract ArcTradeOrdersTestBase is Test {
    ArcTradeOrders.Side internal constant S_BUY = ArcTradeOrders.Side.BUY;
    ArcTradeOrders.Side internal constant S_SELL = ArcTradeOrders.Side.SELL;
    ArcTradeOrders.OrderType internal constant T_LIMIT = ArcTradeOrders.OrderType.LIMIT;
    ArcTradeOrders.OrderType internal constant T_STOP = ArcTradeOrders.OrderType.STOP_LOSS;
    ArcTradeOrders.OrderType internal constant T_TP = ArcTradeOrders.OrderType.TAKE_PROFIT;
    ArcTradeOrders.OrderType internal constant T_STOPLIMIT = ArcTradeOrders.OrderType.STOP_LIMIT;
    ArcTradeOrders.OrderType internal constant T_TRAIL = ArcTradeOrders.OrderType.TRAILING_STOP;
    ArcTradeOrders.OrderType internal constant T_OCO = ArcTradeOrders.OrderType.OCO;

    uint32 internal constant DELAY = 2 days;
    uint32 internal constant STALE = 1 days;
    uint256 internal constant BTC_AMT = 1e8; // 1 BTC (8 decimals)
    uint256 internal constant ETH_AMT = 10e18; // 10 ETH (18 decimals)
    uint16 internal constant SLIP = 100; // 1%

    ArcTradeOrders internal arc;
    MockERC20 internal usdc; // quote, 6 decimals
    MockERC20 internal wbtc; // base, 8 decimals
    MockERC20 internal weth; // base, 18 decimals
    MockAggregator internal usdcFeed;
    MockAggregator internal btcFeed;
    MockAggregator internal ethFeed;
    MockSwapTarget internal dex;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("USDC", "USDC", 6);
        wbtc = new MockERC20("WBTC", "WBTC", 8);
        weth = new MockERC20("WETH", "WETH", 18);
        usdcFeed = new MockAggregator(8, 1e8);
        btcFeed = new MockAggregator(8, 60_000e8);
        ethFeed = new MockAggregator(8, 3_000e8);
        dex = new MockSwapTarget();
        arc = new ArcTradeOrders(owner, address(usdc), DELAY);

        bytes32 a = _queueToken(address(usdc), address(usdcFeed));
        bytes32 b = _queueToken(address(wbtc), address(btcFeed));
        bytes32 c = _queueToken(address(weth), address(ethFeed));
        vm.prank(owner);
        bytes32 d = arc.queueSwapTarget(address(dex), true);
        skip(DELAY);
        vm.startPrank(owner);
        arc.applyConfig(a);
        arc.applyConfig(b);
        arc.applyConfig(c);
        arc.applyConfig(d);
        vm.stopPrank();
        _touch();

        address[3] memory users = [alice, bob, address(dex)];
        for (uint256 i; i < users.length; ++i) {
            usdc.mint(users[i], 1e15);
            wbtc.mint(users[i], 1e15);
            weth.mint(users[i], 1e30);
        }
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(i == 0 ? alice : bob);
            usdc.approve(address(arc), type(uint256).max);
            wbtc.approve(address(arc), type(uint256).max);
            weth.approve(address(arc), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ---------------------------------------------------------------- helpers

    function _queueToken(address token, address feed) internal returns (bytes32 id) {
        vm.prank(owner);
        id = arc.queueTokenConfig(token, feed, STALE);
    }

    /// @dev Allowlists `target` through the timelock; refreshes feeds afterwards.
    function _allow(address target) internal {
        vm.prank(owner);
        bytes32 id = arc.queueSwapTarget(target, true);
        skip(DELAY);
        vm.prank(owner);
        arc.applyConfig(id);
        _touch();
    }

    /// @dev Re-stamps all feeds with the current time.
    function _touch() internal {
        usdcFeed.setUpdatedAt(block.timestamp);
        btcFeed.setUpdatedAt(block.timestamp);
        ethFeed.setUpdatedAt(block.timestamp);
    }

    function _setBtc(uint256 usd) internal {
        btcFeed.set(int256(usd * 1e8));
        _touch();
    }

    function _setEth(uint256 usd) internal {
        ethFeed.set(int256(usd * 1e8));
        _touch();
    }

    function _exp() internal view returns (uint40) {
        return uint40(block.timestamp + 7 days);
    }

    function _p(
        address base,
        ArcTradeOrders.Side side,
        ArcTradeOrders.OrderType t,
        uint256 amountIn,
        uint256 trigger,
        uint256 limit,
        uint16 trail
    ) internal view returns (ArcTradeOrders.CreateParams memory) {
        return ArcTradeOrders.CreateParams(base, side, t, amountIn, trigger, limit, trail, SLIP, _exp());
    }

    function _create(address who, ArcTradeOrders.CreateParams memory p) internal returns (uint256 id) {
        vm.prank(who);
        id = arc.createOrder(p);
    }

    /// @dev Limit sell of 1 BTC, triggers at price >= trigger (USD, whole units).
    function _limitSellBtc(uint256 triggerUsd) internal returns (uint256) {
        return _create(alice, _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, triggerUsd * 1e18, 0, 0));
    }

    function _swapData(address tIn, address tOut, uint256 amountIn) internal pure returns (bytes memory) {
        return abi.encodeCall(MockSwapTarget.swap, (tIn, tOut, amountIn));
    }

    function _tokens(ArcTradeOrders.Order memory o) internal view returns (address tIn, address tOut) {
        tIn = o.side == S_BUY ? address(usdc) : o.base;
        tOut = o.side == S_BUY ? o.base : address(usdc);
    }

    /// @dev Sets the dex so the order's input yields exactly `gross` output; returns swap calldata.
    function _prep(uint256 id, uint256 gross) internal returns (bytes memory) {
        ArcTradeOrders.Order memory o = arc.getOrder(id);
        (address tIn, address tOut) = _tokens(o);
        dex.setRate(gross, o.amountIn);
        return _swapData(tIn, tOut, o.amountIn);
    }

    /// @dev Gross output at the current oracle price (no slippage).
    function _marketOut(uint256 id) internal view returns (uint256) {
        ArcTradeOrders.Order memory o = arc.getOrder(id);
        (uint256 price,) = arc.currentPrice(o.base);
        return o.side == S_BUY ? arc.baseForQuote(o.base, o.amountIn, price) : arc.quoteForBase(o.base, o.amountIn, price);
    }

    function _execGross(uint256 id, uint256 gross) internal {
        bytes memory data = _prep(id, gross);
        vm.prank(keeper);
        arc.execute(id, address(dex), data);
    }

    function _execMarket(uint256 id) internal {
        _execGross(id, _marketOut(id));
    }

    function _fee(uint256 gross) internal view returns (uint256) {
        return Math.mulDiv(gross, arc.keeperFeeBps(), 10_000);
    }
}
