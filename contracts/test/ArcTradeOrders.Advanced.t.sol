// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {ArcTradeOrdersTestBase} from "./ArcTradeOrders.Base.t.sol";

/// @dev STOP_LIMIT, TRAILING_STOP and OCO behaviour.
contract ArcTradeOrdersAdvancedTest is ArcTradeOrdersTestBase {
    // ----------------------------------------------------------- STOP_LIMIT

    function _stopLimit() internal returns (uint256) {
        // sell 1 BTC; stop 58k, limit (min acceptable price) 57k; market 60k
        return _create(alice, _p(address(wbtc), S_SELL, T_STOPLIMIT, BTC_AMT, 58_000e18, 57_000e18, 0));
    }

    function test_StopLimit_NotTriggeredAboveStop() public {
        uint256 id = _stopLimit();
        (bool exec, uint8 code,,) = arc.checkOrder(id);
        assertFalse(exec);
        assertEq(code, 3);
        bytes memory data = _prep(id, 60_000e6);
        vm.prank(keeper);
        vm.expectRevert(ArcTradeOrders.NotTriggered.selector);
        arc.execute(id, address(dex), data);
    }

    function test_ActivateStop_RevertsWhenPriceAboveTrigger() public {
        uint256 id = _stopLimit();
        vm.expectRevert(ArcTradeOrders.NotTriggered.selector);
        arc.activateStop(id);
    }

    function test_ActivateStop_PersistsAfterPriceRebound() public {
        uint256 id = _stopLimit();
        _setBtc(57_500);
        vm.expectEmit(true, false, false, true, address(arc));
        emit ArcTradeOrders.StopActivated(id, 57_500e18);
        arc.activateStop(id);
        assertTrue(arc.getOrder(id).stopActivated);

        _setBtc(62_000); // rebound well above the stop
        (bool exec, uint8 code,, uint256 minOut) = arc.checkOrder(id);
        assertTrue(exec);
        assertEq(code, 0);
        // still honours user limit 57k and slippage floor on current price (62k*99%)
        assertEq(minOut, 61_380e6);

        uint256 gross = _marketOut(id);
        uint256 before_ = usdc.balanceOf(alice);
        _execGross(id, gross);
        assertEq(usdc.balanceOf(alice), before_ + gross - _fee(gross));
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXECUTED));
    }

    function test_ActivateStop_WithoutActivationReboundIsNotTriggered() public {
        uint256 id = _stopLimit();
        _setBtc(57_500);
        _setBtc(62_000); // never activated
        (bool exec, uint8 code,,) = arc.checkOrder(id);
        assertFalse(exec);
        assertEq(code, 3);
    }

    function test_ActivateStop_Guards() public {
        uint256 id = _stopLimit();
        uint256 other = _limitSellBtc(65_000);
        _setBtc(57_000);
        vm.expectRevert(ArcTradeOrders.InvalidParameters.selector);
        arc.activateStop(other); // wrong order type
        arc.activateStop(id);
        vm.expectRevert(ArcTradeOrders.InvalidParameters.selector);
        arc.activateStop(id); // already active
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.InvalidOrder.selector, 77));
        arc.activateStop(77);
    }

    function test_ActivateStop_ExpiredAndPausedRevert() public {
        uint256 id = _stopLimit();
        _setBtc(57_000);
        vm.prank(owner);
        arc.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arc.activateStop(id);
        vm.prank(owner);
        arc.unpause();
        skip(7 days);
        _touch();
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OrderExpired(uint256)")), id));
        arc.activateStop(id);
    }

    function test_StopLimit_ExecuteBelowLimitFailsAndDoesNotPersistActivation() public {
        uint256 id = _stopLimit();
        _setBtc(56_000); // below limit 57k: market output cannot satisfy the limit
        (bool trig,, uint256 minOut) = arc.previewOrder(id);
        assertTrue(trig);
        assertEq(minOut, 57_000e6);
        uint256 gross = _marketOut(id);
        bytes memory data = _prep(id, gross);
        bytes memory err = abi.encodeWithSelector(ArcTradeOrders.InsufficientOutput.selector, gross - _fee(gross), minOut);
        vm.prank(keeper);
        vm.expectRevert(err);
        arc.execute(id, address(dex), data);
        assertFalse(arc.getOrder(id).stopActivated); // reverted tx

        // Persist the stop explicitly, then let the price recover above the limit and fill.
        arc.activateStop(id);
        _setBtc(59_000);
        _execMarket(id);
        assertGe(arc.getOrder(id).amountOut, 57_000e6);
    }

    function test_StopLimit_ExecuteAtTriggerSetsActivatedAndEmits() public {
        uint256 id = _stopLimit();
        _setBtc(57_500);
        bytes memory data = _prep(id, _marketOut(id));
        vm.expectEmit(true, false, false, true, address(arc));
        emit ArcTradeOrders.StopActivated(id, 57_500e18);
        vm.prank(keeper);
        arc.execute(id, address(dex), data);
        assertTrue(arc.getOrder(id).stopActivated);
    }

    // ------------------------------------------------------- TRAILING_STOP

    function _trail(uint16 bps) internal returns (uint256) {
        return _create(alice, _p(address(wbtc), S_SELL, T_TRAIL, BTC_AMT, 0, 0, bps));
    }

    function test_Trailing_PeakRaisedByPokeAndPersists() public {
        uint256 id = _trail(1000); // 10%
        assertEq(arc.getOrder(id).peakPrice, 60_000e18);
        _setBtc(66_000);
        vm.expectEmit(true, false, false, true, address(arc));
        emit ArcTradeOrders.TrailingPeakUpdated(id, 66_000e18);
        arc.pokeTrailing(id);
        assertEq(arc.getOrder(id).peakPrice, 66_000e18);

        _setBtc(63_000); // lower: peak must not fall
        arc.pokeTrailing(id);
        assertEq(arc.getOrder(id).peakPrice, 66_000e18);
    }

    function test_Trailing_ReversalTriggersAtPeakMinusTrail() public {
        uint256 id = _trail(1000);
        _setBtc(66_000);
        arc.pokeTrailing(id);

        _setBtc(59_401); // just above 66k * 0.9 = 59.4k
        (bool exec, uint8 code,,) = arc.checkOrder(id);
        assertFalse(exec);
        assertEq(code, 3);

        _setBtc(59_400); // exactly at threshold => triggered
        (exec, code,,) = arc.checkOrder(id);
        assertTrue(exec);
        assertEq(code, 0);

        uint256 gross = _marketOut(id);
        uint256 before_ = usdc.balanceOf(alice);
        _execGross(id, gross);
        assertEq(usdc.balanceOf(alice), before_ + gross - _fee(gross));
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXECUTED));
    }

    function test_Trailing_ExecuteRaisesPeakWhenPriceRisesButNotTriggered_RevertsWithoutPersisting() public {
        uint256 id = _trail(1000);
        _setBtc(70_000);
        bytes memory data = _prep(id, 70_000e6);
        vm.prank(keeper);
        vm.expectRevert(ArcTradeOrders.NotTriggered.selector);
        arc.execute(id, address(dex), data);
        // a reverting execute cannot persist the peak; pokeTrailing is what persists it
        assertEq(arc.getOrder(id).peakPrice, 60_000e18);
        arc.pokeTrailing(id);
        assertEq(arc.getOrder(id).peakPrice, 70_000e18);
    }

    function test_Trailing_PreviewUsesVirtualPeak() public {
        uint256 id = _trail(1000);
        _setBtc(70_000);
        (bool trig, uint256 price,) = arc.previewOrder(id);
        assertFalse(trig);
        assertEq(price, 70_000e18);
        assertEq(arc.getOrder(id).peakPrice, 60_000e18); // view does not write
    }

    function test_Trailing_ImmediateDropFromCreationPeakTriggers() public {
        uint256 id = _trail(500); // 5%: threshold 57k
        _setBtc(56_900);
        (bool exec,,,) = arc.checkOrder(id);
        assertTrue(exec);
        _execMarket(id);
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXECUTED));
    }

    function test_Trailing_PokeGuards() public {
        uint256 id = _trail(1000);
        uint256 lim = _limitSellBtc(65_000);
        vm.expectRevert(ArcTradeOrders.InvalidParameters.selector);
        arc.pokeTrailing(lim);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.InvalidOrder.selector, 55));
        arc.pokeTrailing(55);
        // callable while paused
        _setBtc(65_000);
        vm.prank(owner);
        arc.pause();
        arc.pokeTrailing(id);
        assertEq(arc.getOrder(id).peakPrice, 65_000e18);
        // expired
        skip(7 days);
        _touch();
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OrderExpired(uint256)")), id));
        arc.pokeTrailing(id);
    }

    function testFuzz_Trailing_ThresholdBoundary(uint256 trailSeed, uint256 peakUsd) public {
        uint16 trail = uint16(bound(trailSeed, 10, 5000));
        peakUsd = bound(peakUsd, 60_001, 500_000);
        uint256 id = _trail(trail);
        _setBtc(peakUsd);
        arc.pokeTrailing(id);
        uint256 peakAns = peakUsd * 1e8;
        uint256 maxTrig = Math.mulDiv(peakAns, 10_000 - trail, 10_000); // largest feed answer that triggers

        btcFeed.set(int256(maxTrig));
        _touch();
        (bool exec,,,) = arc.checkOrder(id);
        assertTrue(exec, "at threshold");
        btcFeed.set(int256(maxTrig + 1));
        _touch();
        (exec,,,) = arc.checkOrder(id);
        assertFalse(exec, "above threshold");
    }

    // ------------------------------------------------------------------ OCO

    function _oco() internal returns (uint256) {
        return _create(alice, _p(address(wbtc), S_SELL, T_OCO, BTC_AMT, 55_000e18, 65_000e18, 0));
    }

    function test_Oco_BetweenLegsNotTriggered() public {
        uint256 id = _oco();
        (bool exec, uint8 code,,) = arc.checkOrder(id);
        assertFalse(exec);
        assertEq(code, 3);
    }

    function test_Oco_StopLegExecutes() public {
        uint256 id = _oco();
        _setBtc(54_000);
        (bool exec,, , uint256 minOut) = arc.checkOrder(id);
        assertTrue(exec);
        assertEq(minOut, 53_460e6); // only slippage floor on the stop leg
        uint256 before_ = usdc.balanceOf(alice);
        _execMarket(id);
        assertEq(usdc.balanceOf(alice), before_ + 54_000e6 - _fee(54_000e6));
    }

    function test_Oco_TakeProfitLegHonorsLimitPrice() public {
        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_OCO, BTC_AMT, 55_000e18, 65_000e18, 0);
        p.maxSlippageBps = 1000;
        uint256 id = _create(alice, p);
        _setBtc(66_000);
        (bool exec,,, uint256 minOut) = arc.checkOrder(id);
        assertTrue(exec);
        assertEq(minOut, 65_000e6); // 66k*90% = 59.4k < 65k limit
        uint256 before_ = usdc.balanceOf(alice);
        _execMarket(id);
        assertGe(usdc.balanceOf(alice) - before_, 65_000e6);
    }

    function test_Oco_BothLegsBoundariesTrigger() public {
        uint256 id = _oco();
        _setBtc(55_000);
        (bool exec,,,) = arc.checkOrder(id);
        assertTrue(exec);
        _setBtc(65_000);
        (exec,,,) = arc.checkOrder(id);
        assertTrue(exec);
    }

    function test_Oco_NoDoubleExecution() public {
        uint256 id = _oco();
        _setBtc(54_000);
        _execMarket(id);
        uint256 aliceUsdc = usdc.balanceOf(alice);
        uint256 keeperUsdc = usdc.balanceOf(keeper);

        // Price swings through the other leg; the single order is spent.
        _setBtc(70_000);
        bytes memory data = _prep(id, 70_000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderNotOpen.selector, id));
        arc.execute(id, address(dex), data);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderNotOpen.selector, id));
        arc.cancelOrder(id);
        assertEq(usdc.balanceOf(alice), aliceUsdc);
        assertEq(usdc.balanceOf(keeper), keeperUsdc);
        (bool exec, uint8 code,,) = arc.checkOrder(id);
        assertFalse(exec);
        assertEq(code, 1);
    }

    function test_Oco_CancelRefundsThenNoExecute() public {
        uint256 id = _oco();
        vm.prank(alice);
        arc.cancelOrder(id);
        _setBtc(54_000);
        bytes memory data = _prep(id, 54_000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderNotOpen.selector, id));
        arc.execute(id, address(dex), data);
    }
}
