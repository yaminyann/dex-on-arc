// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {TestToken} from "../testnet/TestToken.sol";
import {TestPriceFeed} from "../testnet/TestPriceFeed.sol";
import {TestSwapRouter} from "../testnet/TestSwapRouter.sol";

/// Exercises the testnet-only harness and proves the order contract works end to end against it.
contract TestnetHarnessTest is Test {
    TestToken usdc;
    TestToken tbtc;
    TestPriceFeed usdcFeed;
    TestPriceFeed btcFeed;
    TestSwapRouter router;
    ArcTradeOrders orders;
    address user = address(0xBEEF);
    address keeper = address(0xCAFE);

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new TestToken("USD Coin", "USDC", 6, 1_000e6, address(this));
        tbtc = new TestToken("Test BTC", "tBTC", 8, 1e8, address(this));
        usdcFeed = new TestPriceFeed("USDC / USD", 1e8);
        btcFeed = new TestPriceFeed("tBTC / USD", 100_000e8);
        router = new TestSwapRouter(address(this));
        router.setFeed(address(usdc), address(usdcFeed));
        router.setFeed(address(tbtc), address(btcFeed));
        usdc.setMinter(address(router));
        tbtc.setMinter(address(router));

        orders = new ArcTradeOrders(address(this), address(usdc), 1 hours);
        bytes32 a = orders.queueTokenConfig(address(usdc), address(usdcFeed), 172_800);
        bytes32 b = orders.queueTokenConfig(address(tbtc), address(btcFeed), 172_800);
        bytes32 c = orders.queueSwapTarget(address(router), true);
        vm.warp(block.timestamp + 1 hours);
        orders.applyConfig(a);
        orders.applyConfig(b);
        orders.applyConfig(c);
    }

    function _swapData(address tokenIn, address tokenOut, uint256 amountIn) private pure returns (bytes memory) {
        return abi.encodeCall(TestSwapRouter.swapExactIn, (tokenIn, tokenOut, amountIn));
    }

    function test_faucetIsCapped() public {
        vm.startPrank(user);
        for (uint256 i; i < 10; i++) tbtc.faucet();
        vm.expectRevert(TestToken.FaucetLimit.selector);
        tbtc.faucet();
        vm.stopPrank();
    }

    function test_feedSetAndRefresh() public {
        vm.warp(block.timestamp + 5 days);
        btcFeed.refresh();
        (, int256 ans,, uint256 updatedAt,) = btcFeed.latestRoundData();
        assertEq(ans, 100_000e8);
        assertEq(updatedAt, block.timestamp);
        vm.expectRevert(TestPriceFeed.InvalidPrice.selector);
        btcFeed.setPrice(0);
    }

    function test_routerQuoteMatchesFeedMinusFee() public view {
        // 1 tBTC at 100,000 USD -> 100,000 USDC less 0.10%
        assertEq(router.quote(address(tbtc), address(usdc), 1e8), 99_900e6);
        // 1,000 USDC buys 0.01 tBTC less 0.10%
        assertEq(router.quote(address(usdc), address(tbtc), 1_000e6), 999_000);
    }

    function test_limitSellExecutesThroughRouter() public {
        vm.startPrank(user);
        tbtc.faucet();
        tbtc.approve(address(orders), 1e8);
        uint256 id = orders.createOrder(
            ArcTradeOrders.CreateParams({
                base: address(tbtc),
                side: ArcTradeOrders.Side.SELL,
                orderType: ArcTradeOrders.OrderType.LIMIT,
                amountIn: 1e8,
                triggerPrice: 110_000e18,
                limitPrice: 0,
                trailBps: 0,
                maxSlippageBps: 100,
                expiry: uint40(block.timestamp + 1 days)
            })
        );
        vm.stopPrank();

        // Not triggered at 100,000.
        vm.prank(keeper);
        vm.expectRevert();
        orders.execute(id, address(router), _swapData(address(tbtc), address(usdc), 1e8));

        btcFeed.setPrice(112_000e8);
        vm.prank(keeper);
        orders.execute(id, address(router), _swapData(address(tbtc), address(usdc), 1e8));

        // 112,000 less router fee 0.10% = 111,888 gross; keeper takes 0.10% of that.
        uint256 gross = 111_888e6;
        uint256 fee = gross * 10 / 10_000;
        assertEq(usdc.balanceOf(user), gross - fee);
        assertEq(usdc.balanceOf(keeper), fee);
        assertEq(tbtc.balanceOf(address(orders)), 0);
    }

    function test_stopLossExecutesWhenPriceFalls() public {
        vm.startPrank(user);
        tbtc.faucet();
        tbtc.approve(address(orders), 1e8);
        uint256 id = orders.createOrder(
            ArcTradeOrders.CreateParams({
                base: address(tbtc),
                side: ArcTradeOrders.Side.SELL,
                orderType: ArcTradeOrders.OrderType.STOP_LOSS,
                amountIn: 1e8,
                triggerPrice: 90_000e18,
                limitPrice: 0,
                trailBps: 0,
                maxSlippageBps: 100,
                expiry: uint40(block.timestamp + 1 days)
            })
        );
        vm.stopPrank();
        btcFeed.setPrice(85_000e8);
        vm.prank(keeper);
        orders.execute(id, address(router), _swapData(address(tbtc), address(usdc), 1e8));
        assertGt(usdc.balanceOf(user), 84_000e6);
    }

    function test_dcaBuysThroughRouter() public {
        vm.startPrank(user);
        usdc.faucet();
        usdc.approve(address(orders), 300e6);
        uint256 id = orders.createDca(address(tbtc), 100e6, 3, 1 hours, 0, 100, 0);
        vm.stopPrank();
        vm.prank(keeper);
        orders.executeDca(id, address(router), _swapData(address(usdc), address(tbtc), 100e6));
        assertGt(tbtc.balanceOf(user), 0);
        vm.warp(block.timestamp + 1 hours);
        btcFeed.refresh();
        usdcFeed.refresh();
        vm.prank(keeper);
        orders.executeDca(id, address(router), _swapData(address(usdc), address(tbtc), 100e6));
        assertEq(orders.getDca(id).executions, 2);
    }
}
