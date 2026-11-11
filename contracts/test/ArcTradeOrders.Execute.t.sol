// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {ArcTradeOrdersTestBase} from "./ArcTradeOrders.Base.t.sol";

/// @dev Happy-path executions for each simple order type, fees, minOut, approvals.
contract ArcTradeOrdersExecuteTest is ArcTradeOrdersTestBase {
    function test_Execute_LimitSellBtc_PaysOwnerNetAndKeeperFee() public {
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        uint256 gross = _marketOut(id);
        assertEq(gross, 66_000e6);
        uint256 fee = _fee(gross);
        uint256 net = gross - fee;
        assertEq(fee, 66e6);

        bytes memory data = _prep(id, gross);
        uint256 aliceUsdc = usdc.balanceOf(alice);
        uint256 keeperUsdc = usdc.balanceOf(keeper);
        vm.expectEmit(true, true, true, true, address(arc));
        emit ArcTradeOrders.OrderExecuted(id, alice, keeper, BTC_AMT, net, fee, net * 1e12);
        vm.prank(keeper);
        arc.execute(id, address(dex), data);

        assertEq(usdc.balanceOf(alice), aliceUsdc + net);
        assertEq(usdc.balanceOf(keeper), keeperUsdc + fee);
        assertEq(usdc.balanceOf(address(arc)), 0);
        assertEq(wbtc.balanceOf(address(arc)), 0);
        ArcTradeOrders.Order memory o = arc.getOrder(id);
        assertEq(uint8(o.status), uint8(ArcTradeOrders.Status.EXECUTED));
        assertEq(o.amountOut, net);
        assertEq(o.executionPrice, 65_934e18);
        assertEq(o.executedAt, uint40(block.timestamp));
    }

    function test_Execute_LimitSellEth_18DecimalBase() public {
        uint256 id = _create(alice, _p(address(weth), S_SELL, T_LIMIT, ETH_AMT, 3_200e18, 0, 0));
        _setEth(3_300);
        uint256 gross = _marketOut(id);
        assertEq(gross, 33_000e6);
        uint256 before_ = usdc.balanceOf(alice);
        _execGross(id, gross);
        assertEq(usdc.balanceOf(alice), before_ + gross - _fee(gross));
        assertEq(arc.getOrder(id).executionPrice, (gross - _fee(gross)) * 1e12 / 10);
        assertEq(weth.balanceOf(address(arc)), 0);
    }

    function test_Execute_LimitBuyBtc_BuysBaseForQuoteEscrow() public {
        uint256 amt = 60_000e6;
        uint256 id = _create(alice, _p(address(wbtc), S_BUY, T_LIMIT, amt, 55_000e18, 0, 0));
        _setBtc(50_000);
        uint256 gross = _marketOut(id);
        assertEq(gross, 1.2e8); // 60k USDC / 50k = 1.2 BTC
        uint256 fee = _fee(gross);
        uint256 beforeA = wbtc.balanceOf(alice);
        uint256 beforeK = wbtc.balanceOf(keeper);
        _execGross(id, gross);
        assertEq(wbtc.balanceOf(alice), beforeA + gross - fee);
        assertEq(wbtc.balanceOf(keeper), beforeK + fee);
        assertEq(usdc.balanceOf(address(arc)), 0);
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXECUTED));
    }

    function test_Execute_LimitBuyEth_18Decimals() public {
        uint256 amt = 30_000e6;
        uint256 id = _create(alice, _p(address(weth), S_BUY, T_LIMIT, amt, 2_900e18, 0, 0));
        _setEth(2_500);
        uint256 gross = _marketOut(id);
        assertEq(gross, 12e18);
        _execGross(id, gross);
        assertEq(weth.balanceOf(address(arc)), 0);
        assertEq(arc.getOrder(id).amountOut, gross - _fee(gross));
    }

    function test_Execute_StopLossBtc() public {
        uint256 id = _create(alice, _p(address(wbtc), S_SELL, T_STOP, BTC_AMT, 55_000e18, 0, 0));
        _setBtc(54_000);
        uint256 gross = _marketOut(id);
        uint256 before_ = usdc.balanceOf(alice);
        _execGross(id, gross);
        assertEq(usdc.balanceOf(alice), before_ + gross - _fee(gross));
    }

    function test_Execute_StopLossBoundaryExactlyAtTrigger() public {
        uint256 id = _create(alice, _p(address(wbtc), S_SELL, T_STOP, BTC_AMT, 55_000e18, 0, 0));
        _setBtc(55_000);
        _execMarket(id);
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXECUTED));
    }

    function test_Execute_TakeProfitEth() public {
        uint256 id = _create(alice, _p(address(weth), S_SELL, T_TP, ETH_AMT, 3_500e18, 0, 0));
        _setEth(3_600);
        uint256 before_ = usdc.balanceOf(alice);
        _execMarket(id);
        assertEq(usdc.balanceOf(alice), before_ + 36_000e6 - _fee(36_000e6));
    }

    function test_Execute_AnyoneCanKeep_FeeGoesToCaller() public {
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        bytes memory data = _prep(id, _marketOut(id));
        uint256 before_ = usdc.balanceOf(bob);
        vm.prank(bob);
        arc.execute(id, address(dex), data);
        assertEq(usdc.balanceOf(bob), before_ + 66e6);
    }

    // ------------------------------------------------------------- keeper fee

    function test_Fee_LoweredToZeroPaysNothingToKeeper() public {
        vm.prank(owner);
        arc.setKeeperFeeBps(0);
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        uint256 before_ = usdc.balanceOf(keeper);
        uint256 aliceBefore = usdc.balanceOf(alice);
        _execGross(id, 66_000e6);
        assertEq(usdc.balanceOf(keeper), before_);
        assertEq(usdc.balanceOf(alice), aliceBefore + 66_000e6);
    }

    function test_Fee_LoweredAppliesToNextExecution() public {
        vm.prank(owner);
        arc.setKeeperFeeBps(4);
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        uint256 before_ = usdc.balanceOf(keeper);
        _execGross(id, 66_000e6);
        assertEq(usdc.balanceOf(keeper) - before_, Math.mulDiv(66_000e6, 4, 10_000));
    }

    // ------------------------------------------------------ minOut / user limit

    function _netOf(uint256 gross) internal view returns (uint256) {
        return gross - _fee(gross);
    }

    function test_MinOut_LimitSellHonorsUserPriceOverLooseSlippage() public {
        // market 70k, slippage 10% => slippage floor 63k; user limit 65k dominates.
        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 0);
        p.maxSlippageBps = 1000;
        uint256 id = _create(alice, p);
        _setBtc(70_000);
        (bool trig,, uint256 minOut) = arc.previewOrder(id);
        assertTrue(trig);
        assertEq(minOut, 65_000e6);

        // Net 1 wei below the user's limit => revert, though above the slippage floor.
        uint256 badGross = minOut * 10_000 / 9_990 - 10;
        bytes memory data = _prep(id, badGross);
        bytes memory err = abi.encodeWithSelector(ArcTradeOrders.InsufficientOutput.selector, _netOf(badGross), minOut);
        vm.prank(keeper);
        vm.expectRevert(err);
        arc.execute(id, address(dex), data);

        uint256 okGross = minOut * 10_000 / 9_990 + 2;
        assertGe(_netOf(okGross), minOut);
        uint256 before_ = usdc.balanceOf(alice);
        _execGross(id, okGross);
        assertGe(usdc.balanceOf(alice) - before_, 65_000e6);
    }

    function test_MinOut_SlippageFloorUsedWhenHigherThanUserPrice() public {
        // market 66k slippage 1% => floor 65.34k > user 65k
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        (,, uint256 minOut) = arc.previewOrder(id);
        assertEq(minOut, 65_340e6);
    }

    function test_MinOut_LimitBuyHonorsUserPrice() public {
        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_BUY, T_LIMIT, 60_000e6, 58_000e18, 0, 0);
        p.maxSlippageBps = 1000;
        uint256 id = _create(alice, p);
        _setBtc(57_000);
        (bool trig,, uint256 minOut) = arc.previewOrder(id);
        assertTrue(trig);
        assertEq(minOut, arc.baseForQuote(address(wbtc), 60_000e6, 58_000e18));
        assertGt(minOut, Math.mulDiv(arc.baseForQuote(address(wbtc), 60_000e6, 57_000e18), 9000, 10_000));
    }

    function test_MinOut_TakeProfitHonorsTriggerAsLimit() public {
        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_TP, BTC_AMT, 65_000e18, 0, 0);
        p.maxSlippageBps = 1000;
        uint256 id = _create(alice, p);
        _setBtc(66_000);
        (,, uint256 minOut) = arc.previewOrder(id);
        assertEq(minOut, 65_000e6);
    }

    function test_MinOut_StopLossHasOnlySlippageFloor() public {
        uint256 id = _create(alice, _p(address(wbtc), S_SELL, T_STOP, BTC_AMT, 55_000e18, 0, 0));
        _setBtc(54_000);
        (,, uint256 minOut) = arc.previewOrder(id);
        assertEq(minOut, 53_460e6); // 54k * 99%
    }

    // ------------------------------------------------------ no standing approvals

    function test_NoStandingApprovalAfterSellExecute() public {
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        _execMarket(id);
        assertEq(wbtc.allowance(address(arc), address(dex)), 0);
        assertEq(usdc.allowance(address(arc), address(dex)), 0);
    }

    function test_NoStandingApprovalAfterBuyExecute() public {
        uint256 id = _create(alice, _p(address(wbtc), S_BUY, T_LIMIT, 60_000e6, 55_000e18, 0, 0));
        _setBtc(50_000);
        _execMarket(id);
        assertEq(usdc.allowance(address(arc), address(dex)), 0);
        assertEq(wbtc.allowance(address(arc), address(dex)), 0);
    }

    function test_NoApprovalLeftAfterRevertedExecuteEither() public {
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        bytes memory data = _prep(id, 1); // grossly insufficient
        vm.prank(keeper);
        vm.expectRevert();
        arc.execute(id, address(dex), data);
        assertEq(wbtc.allowance(address(arc), address(dex)), 0);
    }

    // ------------------------------------------------------------- no double

    function test_Execute_SecondExecuteAndCancelRevert() public {
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        _execMarket(id);
        bytes memory data = _prep(id, 66_000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderNotOpen.selector, id));
        arc.execute(id, address(dex), data);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderNotOpen.selector, id));
        arc.cancelOrder(id);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderNotOpen.selector, id));
        arc.expireOrder(id);
    }
}
