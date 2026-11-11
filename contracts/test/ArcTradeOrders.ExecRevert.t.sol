// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {MaliciousSwapTarget} from "./ArcTradeMocks.sol";
import {ArcTradeOrdersTestBase} from "./ArcTradeOrders.Base.t.sol";

/// @dev Every execute() revert path plus checkOrder reason codes.
contract ArcTradeOrdersExecRevertTest is ArcTradeOrdersTestBase {
    MaliciousSwapTarget internal evil;
    bytes4 internal constant ORDER_EXPIRED = bytes4(keccak256("OrderExpired(uint256)"));

    function setUp() public override {
        super.setUp();
        evil = new MaliciousSwapTarget();
        _allow(address(evil));
        usdc.mint(address(evil), 1e15);
        wbtc.mint(address(evil), 1e15);
    }

    function _triggeredSell() internal returns (uint256 id) {
        id = _limitSellBtc(65_000);
        _setBtc(66_000);
    }

    function _evilData(uint256 id) internal view returns (bytes memory) {
        ArcTradeOrders.Order memory o = arc.getOrder(id);
        (address tIn, address tOut) = _tokens(o);
        return _swapData(tIn, tOut, o.amountIn);
    }

    function _expectExec(uint256 id, address target, bytes memory data, bytes memory err) internal {
        vm.prank(keeper);
        vm.expectRevert(err);
        arc.execute(id, target, data);
    }

    // ---------------------------------------------------------- not triggered

    function test_Revert_NotTriggered_EachType() public {
        uint256[5] memory ids;
        ids[0] = _limitSellBtc(65_000); // sell above
        ids[1] = _create(alice, _p(address(wbtc), S_BUY, T_LIMIT, 60_000e6, 55_000e18, 0, 0)); // buy below
        ids[2] = _create(alice, _p(address(wbtc), S_SELL, T_STOP, BTC_AMT, 55_000e18, 0, 0));
        ids[3] = _create(alice, _p(address(wbtc), S_SELL, T_TP, BTC_AMT, 65_000e18, 0, 0));
        ids[4] = _create(alice, _p(address(wbtc), S_SELL, T_OCO, BTC_AMT, 55_000e18, 65_000e18, 0));
        for (uint256 i; i < 5; ++i) {
            bytes memory data = _prep(ids[i], 1e6);
            _expectExec(ids[i], address(dex), data, abi.encodePacked(ArcTradeOrders.NotTriggered.selector));
        }
    }

    function test_Revert_InvalidAndNonOpenOrder() public {
        bytes memory data = _swapData(address(wbtc), address(usdc), 1);
        _expectExec(42, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.InvalidOrder.selector, 42));
        uint256 id = _triggeredSell();
        vm.prank(alice);
        arc.cancelOrder(id);
        data = _swapData(address(wbtc), address(usdc), BTC_AMT);
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.OrderNotOpen.selector, id));
    }

    // -------------------------------------------------------------- oracle

    function test_Revert_StaleBaseFeed() public {
        uint256 id = _triggeredSell();
        bytes memory data = _prep(id, 66_000e6);
        btcFeed.setUpdatedAt(block.timestamp - STALE - 1);
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.StalePrice.selector, address(wbtc)));
    }

    function test_Revert_StaleAtExactlyMaxStalenessIsOk() public {
        uint256 id = _triggeredSell();
        btcFeed.setUpdatedAt(block.timestamp - STALE);
        _execMarket(id);
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXECUTED));
    }

    function test_Revert_StaleQuoteFeed() public {
        uint256 id = _triggeredSell();
        bytes memory data = _prep(id, 66_000e6);
        usdcFeed.setUpdatedAt(block.timestamp - STALE - 1);
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.StalePrice.selector, address(usdc)));
    }

    function test_Revert_FeedTimestampInFutureOrZero() public {
        uint256 id = _triggeredSell();
        bytes memory data = _prep(id, 66_000e6);
        btcFeed.setUpdatedAt(block.timestamp + 1);
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.StalePrice.selector, address(wbtc)));
        btcFeed.setUpdatedAt(0);
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.StalePrice.selector, address(wbtc)));
    }

    function test_Revert_ZeroAndNegativePrice() public {
        uint256 id = _triggeredSell();
        bytes memory data = _prep(id, 66_000e6);
        bytes memory err = abi.encodeWithSelector(ArcTradeOrders.InvalidPrice.selector, address(wbtc));
        btcFeed.setAnswer(0);
        _expectExec(id, address(dex), data, err);
        btcFeed.setAnswer(-1);
        _expectExec(id, address(dex), data, err);
        btcFeed.setAnswer(66_000e8);
        usdcFeed.setAnswer(-5);
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.InvalidPrice.selector, address(usdc)));
    }

    function test_Revert_BrokenFeedIsInvalidPrice() public {
        uint256 id = _triggeredSell();
        bytes memory data = _prep(id, 66_000e6);
        btcFeed.setBroken(true);
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.InvalidPrice.selector, address(wbtc)));
    }

    function test_Revert_DisabledTokenOrQuote() public {
        uint256 id = _triggeredSell();
        bytes memory data = _prep(id, 66_000e6);
        vm.prank(owner);
        arc.disableToken(address(usdc));
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.TokenNotSupported.selector, address(usdc)));
    }

    // ------------------------------------------------------ swap target / fill

    function test_Revert_UnallowlistedTarget() public {
        uint256 id = _triggeredSell();
        address rogue = address(new MaliciousSwapTarget());
        bytes memory data = _prep(id, 66_000e6);
        _expectExec(id, rogue, data, abi.encodeWithSelector(ArcTradeOrders.SwapTargetNotAllowed.selector, rogue));
    }

    function test_Revert_DisabledTargetBlocksExecuteInstantly() public {
        uint256 id = _triggeredSell();
        bytes memory data = _prep(id, 66_000e6);
        vm.prank(owner);
        arc.disableSwapTarget(address(dex));
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.SwapTargetNotAllowed.selector, address(dex)));
    }

    function test_Revert_TargetRevertBubblesUp() public {
        uint256 id = _triggeredSell();
        // dex pays more than it holds: ERC20InsufficientBalance bubbles
        dex.setRate(1e30, 1);
        bytes memory data = _swapData(address(wbtc), address(usdc), BTC_AMT);
        vm.prank(keeper);
        vm.expectRevert();
        arc.execute(id, address(dex), data);
    }

    function test_Revert_EmptyRevertFromTargetIsSwapFailed() public {
        uint256 id = _triggeredSell();
        bytes memory data = abi.encodeWithSignature("failEmpty()");
        _expectExec(id, address(dex), data, abi.encodePacked(ArcTradeOrders.SwapFailed.selector));
    }

    function test_Revert_PartialFill_SpendsHalf() public {
        uint256 id = _triggeredSell();
        evil.configure(MaliciousSwapTarget.Mode.SPEND_HALF, 66_000e6);
        _expectExec(
            id, address(evil), _evilData(id), abi.encodeWithSelector(ArcTradeOrders.PartialFill.selector, BTC_AMT / 2, BTC_AMT)
        );
        assertEq(wbtc.allowance(address(arc), address(evil)), 0);
        assertEq(wbtc.balanceOf(address(arc)), BTC_AMT);
    }

    function test_Revert_PartialFill_SpendsNothing() public {
        uint256 id = _triggeredSell();
        evil.configure(MaliciousSwapTarget.Mode.SPEND_NONE, 66_000e6);
        _expectExec(id, address(evil), _evilData(id), abi.encodeWithSelector(ArcTradeOrders.PartialFill.selector, 0, BTC_AMT));
    }

    function test_Revert_PartialFill_TargetReturnsExtraInput() public {
        uint256 id = _triggeredSell();
        evil.configure(MaliciousSwapTarget.Mode.REFUND_INPUT, 66_000e6);
        _expectExec(id, address(evil), _evilData(id), abi.encodeWithSelector(ArcTradeOrders.PartialFill.selector, 0, BTC_AMT));
    }

    function test_Revert_MaliciousUnderDelivery() public {
        uint256 id = _triggeredSell();
        evil.configure(MaliciousSwapTarget.Mode.NORMAL, 10_000e6);
        (,, uint256 minOut) = arc.previewOrder(id);
        uint256 net = 10_000e6 - _fee(10_000e6);
        _expectExec(
            id, address(evil), _evilData(id), abi.encodeWithSelector(ArcTradeOrders.InsufficientOutput.selector, net, minOut)
        );
        assertEq(wbtc.balanceOf(address(arc)), BTC_AMT);
    }

    function test_Revert_MaliciousHonestDeliveryStillWorks() public {
        uint256 id = _triggeredSell();
        evil.configure(MaliciousSwapTarget.Mode.NORMAL, 66_000e6);
        vm.prank(keeper);
        arc.execute(id, address(evil), _evilData(id));
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXECUTED));
    }

    function test_Revert_InsufficientNetAfterKeeperFee() public {
        uint256 id = _triggeredSell();
        (,, uint256 minOut) = arc.previewOrder(id);
        // gross exactly minOut: passes a gross check but net is short by the fee
        uint256 fee = _fee(minOut);
        assertGt(fee, 0);
        bytes memory data = _prep(id, minOut);
        _expectExec(
            id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.InsufficientOutput.selector, minOut - fee, minOut)
        );
        // Lowering the fee to zero makes the same gross pass.
        vm.prank(owner);
        arc.setKeeperFeeBps(0);
        vm.prank(keeper);
        arc.execute(id, address(dex), data);
        assertEq(arc.getOrder(id).amountOut, minOut);
    }

    function test_Revert_ZeroOutput() public {
        uint256 id = _triggeredSell();
        (,, uint256 minOut) = arc.previewOrder(id);
        bytes memory data = _prep(id, 0);
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.InsufficientOutput.selector, 0, minOut));
    }

    // -------------------------------------------------------------- expiry

    function test_Execute_LastValidSecondBeforeExpirySucceeds() public {
        uint256 id = _triggeredSell();
        bytes memory data;
        uint256 exp = arc.getOrder(id).expiry;
        vm.warp(exp - 1);
        _touch();
        _setBtc(66_000);
        data = _prep(id, 66_000e6);
        vm.prank(keeper);
        arc.execute(id, address(dex), data); // last valid second
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXECUTED));
    }

    function test_Revert_ExecuteAtExpiryReverts() public {
        uint256 id = _triggeredSell();
        bytes memory data = _prep(id, 66_000e6);
        vm.warp(arc.getOrder(id).expiry);
        _touch();
        _expectExec(id, address(dex), data, abi.encodeWithSelector(ORDER_EXPIRED, id));
    }

    function test_Revert_Paused() public {
        uint256 id = _triggeredSell();
        bytes memory data = _prep(id, 66_000e6);
        vm.prank(owner);
        arc.pause();
        _expectExec(id, address(dex), data, abi.encodePacked(Pausable.EnforcedPause.selector));
    }

    // ------------------------------------------------------- checkOrder codes

    function test_CheckOrder_Code0_Ready() public {
        uint256 id = _triggeredSell();
        (bool exec, uint8 code, uint256 price, uint256 minOut) = arc.checkOrder(id);
        assertTrue(exec);
        assertEq(code, 0);
        assertEq(price, 66_000e18);
        assertEq(minOut, 65_340e6);
    }

    function test_CheckOrder_Code1_UnknownOrNotOpen() public {
        (bool exec, uint8 code,,) = arc.checkOrder(500);
        assertFalse(exec);
        assertEq(code, 1);
        uint256 id = _limitSellBtc(65_000);
        vm.prank(alice);
        arc.cancelOrder(id);
        (exec, code,,) = arc.checkOrder(id);
        assertFalse(exec);
        assertEq(code, 1);
    }

    function test_CheckOrder_Code2_Expired_BeatsPauseAndOracle() public {
        uint256 id = _limitSellBtc(65_000);
        vm.prank(owner);
        arc.pause();
        skip(7 days); // also stale oracle
        (bool exec, uint8 code,,) = arc.checkOrder(id);
        assertFalse(exec);
        assertEq(code, 2);
    }

    function test_CheckOrder_Code3_NotTriggered() public {
        uint256 id = _limitSellBtc(65_000);
        (bool exec, uint8 code, uint256 price,) = arc.checkOrder(id);
        assertFalse(exec);
        assertEq(code, 3);
        assertEq(price, 60_000e18);
    }

    function test_CheckOrder_Code4_OracleUnavailable() public {
        uint256 id = _limitSellBtc(65_000);
        skip(STALE + 1); // stale (order still unexpired)
        (bool exec, uint8 code,,) = arc.checkOrder(id);
        assertFalse(exec);
        assertEq(code, 4);
        _touch();
        btcFeed.setBroken(true);
        (exec, code,,) = arc.checkOrder(id);
        assertEq(code, 4);
        btcFeed.setBroken(false);
        btcFeed.setAnswer(0);
        (exec, code,,) = arc.checkOrder(id);
        assertEq(code, 4);
    }

    function test_CheckOrder_Code5_Paused() public {
        uint256 id = _triggeredSell();
        vm.prank(owner);
        arc.pause();
        (bool exec, uint8 code,,) = arc.checkOrder(id);
        assertFalse(exec);
        assertEq(code, 5);
    }

    function test_PreviewOrder_RevertsOnUnknownId() public {
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.InvalidOrder.selector, 9));
        arc.previewOrder(9);
    }
}
