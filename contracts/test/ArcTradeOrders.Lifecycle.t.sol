// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {ArcTradeOrdersTestBase} from "./ArcTradeOrders.Base.t.sol";

/// @dev create / cancel / expire / refund for each order type + create-time validation.
contract ArcTradeOrdersLifecycleTest is ArcTradeOrdersTestBase {
    /// @dev Creates one order of the given kind (0..6) from alice; returns id and escrow token.
    function _mk(uint256 kind) internal returns (uint256 id, address escrow, uint256 amt) {
        if (kind == 0) {
            (id, escrow, amt) = (_limitSellBtc(65_000), address(wbtc), BTC_AMT);
        } else if (kind == 1) {
            amt = 60_000e6;
            id = _create(alice, _p(address(wbtc), S_BUY, T_LIMIT, amt, 55_000e18, 0, 0));
            escrow = address(usdc);
        } else if (kind == 2) {
            id = _create(alice, _p(address(wbtc), S_SELL, T_STOP, BTC_AMT, 55_000e18, 0, 0));
            (escrow, amt) = (address(wbtc), BTC_AMT);
        } else if (kind == 3) {
            id = _create(alice, _p(address(wbtc), S_SELL, T_TP, BTC_AMT, 65_000e18, 0, 0));
            (escrow, amt) = (address(wbtc), BTC_AMT);
        } else if (kind == 4) {
            id = _create(alice, _p(address(weth), S_SELL, T_STOPLIMIT, ETH_AMT, 2_800e18, 2_700e18, 0));
            (escrow, amt) = (address(weth), ETH_AMT);
        } else if (kind == 5) {
            id = _create(alice, _p(address(weth), S_SELL, T_TRAIL, ETH_AMT, 0, 0, 500));
            (escrow, amt) = (address(weth), ETH_AMT);
        } else {
            id = _create(alice, _p(address(wbtc), S_SELL, T_OCO, BTC_AMT, 55_000e18, 65_000e18, 0));
            (escrow, amt) = (address(wbtc), BTC_AMT);
        }
    }

    // --------------------------------------------------------------- create

    function test_CreateLimitSell_EscrowsBaseAndStoresOrder() public {
        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 0);
        uint256 aliceBefore = wbtc.balanceOf(alice);
        vm.expectEmit(true, true, true, true, address(arc));
        emit ArcTradeOrders.OrderCreated(1, alice, address(wbtc), p, 0, uint40(block.timestamp));
        uint256 id = _create(alice, p);

        assertEq(id, 1);
        assertEq(arc.nextOrderId(), 2);
        assertEq(wbtc.balanceOf(alice), aliceBefore - BTC_AMT);
        assertEq(wbtc.balanceOf(address(arc)), BTC_AMT);
        ArcTradeOrders.Order memory o = arc.getOrder(id);
        assertEq(o.owner, alice);
        assertEq(o.base, address(wbtc));
        assertEq(uint8(o.status), uint8(ArcTradeOrders.Status.OPEN));
        assertEq(uint8(o.side), uint8(S_SELL));
        assertEq(o.amountIn, BTC_AMT);
        assertEq(o.triggerPrice, 65_000e18);
        assertEq(o.peakPrice, 0);
        assertEq(o.expiry, p.expiry);
        assertEq(o.createdAt, uint40(block.timestamp));
        uint256[] memory ids = arc.getOrderIds(alice);
        assertEq(ids.length, 1);
        assertEq(ids[0], 1);
    }

    function test_CreateLimitBuy_EscrowsQuote() public {
        (uint256 id, address escrow, uint256 amt) = _mk(1);
        assertEq(escrow, address(usdc));
        assertEq(usdc.balanceOf(address(arc)), amt);
        assertEq(wbtc.balanceOf(address(arc)), 0);
        assertEq(uint8(arc.getOrder(id).side), uint8(S_BUY));
    }

    function test_CreateEthLimitSell_18DecimalEscrow() public {
        uint256 id = _create(alice, _p(address(weth), S_SELL, T_LIMIT, ETH_AMT, 3_500e18, 0, 0));
        assertEq(weth.balanceOf(address(arc)), ETH_AMT);
        assertEq(arc.getOrder(id).amountIn, ETH_AMT);
    }

    function test_CreateTrailing_SetsInitialPeakToCurrentPrice() public {
        (uint256 id,,) = _mk(5);
        assertEq(arc.getOrder(id).peakPrice, 3_000e18);
    }

    function test_CreateOrders_AllKindsEscrowExactly() public {
        for (uint256 k; k <= 6; ++k) {
            (uint256 id, address escrow, uint256 amt) = _mk(k);
            assertEq(arc.getOrder(id).amountIn, amt);
            assertGe(MockBal(escrow, address(arc)), amt);
        }
        assertEq(arc.nextOrderId(), 8);
        assertEq(arc.getOrderIds(alice).length, 7);
    }

    function MockBal(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        require(ok);
        return abi.decode(r, (uint256));
    }

    // ----------------------------------------------------- create validation

    function _expectCreateRevert(ArcTradeOrders.CreateParams memory p, bytes4 sel) internal {
        vm.prank(alice);
        vm.expectRevert(sel);
        arc.createOrder(p);
    }

    function test_CreateReverts_GenericParams() public {
        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 0);
        p.base = address(usdc);
        _expectCreateRevert(p, ArcTradeOrders.InvalidParameters.selector);
        p = _p(address(wbtc), S_SELL, T_LIMIT, 0, 65_000e18, 0, 0);
        _expectCreateRevert(p, ArcTradeOrders.InvalidParameters.selector);
        p = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 0);
        p.expiry = uint40(block.timestamp);
        _expectCreateRevert(p, ArcTradeOrders.InvalidParameters.selector);
        p.expiry = _exp();
        p.maxSlippageBps = 0;
        _expectCreateRevert(p, ArcTradeOrders.InvalidParameters.selector);
        p.maxSlippageBps = 1001;
        _expectCreateRevert(p, ArcTradeOrders.InvalidParameters.selector);
        p.maxSlippageBps = 1000; // boundary OK
        vm.prank(alice);
        arc.createOrder(p);
    }

    function test_CreateReverts_NonLimitBuyNotAllowed() public {
        _expectCreateRevert(_p(address(wbtc), S_BUY, T_STOP, 1e6, 55_000e18, 0, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_BUY, T_TP, 1e6, 65_000e18, 0, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_BUY, T_TRAIL, 1e6, 0, 0, 500), ArcTradeOrders.InvalidParameters.selector);
    }

    function test_CreateReverts_TriggerPlacement() public {
        // price = 60000
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_STOP, BTC_AMT, 60_000e18, 0, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_TP, BTC_AMT, 60_000e18, 0, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 0, 0, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_STOPLIMIT, BTC_AMT, 59_000e18, 0, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_STOPLIMIT, BTC_AMT, 59_000e18, 59_500e18, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_STOPLIMIT, BTC_AMT, 60_000e18, 59_000e18, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_OCO, BTC_AMT, 55_000e18, 0, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_OCO, BTC_AMT, 60_000e18, 65_000e18, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_OCO, BTC_AMT, 55_000e18, 60_000e18, 0), ArcTradeOrders.InvalidParameters.selector);
        // limit price only valid for STOP_LIMIT / OCO; trail only for TRAILING
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_STOP, BTC_AMT, 55_000e18, 54_000e18, 0), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 100), ArcTradeOrders.InvalidParameters.selector);
    }

    function test_CreateReverts_TrailingParams() public {
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_TRAIL, BTC_AMT, 0, 0, 9), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_TRAIL, BTC_AMT, 0, 0, 5001), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_TRAIL, BTC_AMT, 50_000e18, 0, 500), ArcTradeOrders.InvalidParameters.selector);
        _expectCreateRevert(_p(address(wbtc), S_SELL, T_TRAIL, BTC_AMT, 0, 50_000e18, 500), ArcTradeOrders.InvalidParameters.selector);
        vm.startPrank(alice);
        arc.createOrder(_p(address(wbtc), S_SELL, T_TRAIL, BTC_AMT, 0, 0, 10));
        arc.createOrder(_p(address(wbtc), S_SELL, T_TRAIL, BTC_AMT, 0, 0, 5000));
        vm.stopPrank();
    }

    function test_CreateReverts_PriceAboveUint128() public {
        _expectCreateRevert(
            _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, uint256(type(uint128).max) + 1, 0, 0), ArcTradeOrders.InvalidParameters.selector
        );
    }

    function test_CreateReverts_UnsupportedBase() public {
        ArcTradeOrders.CreateParams memory p = _p(address(0xBEEF), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.TokenNotSupported.selector, address(0xBEEF)));
        arc.createOrder(p);
    }

    function test_CreateReverts_WithoutAllowance() public {
        vm.prank(alice);
        wbtc.approve(address(arc), 0);
        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 0);
        vm.prank(alice);
        vm.expectRevert();
        arc.createOrder(p);
    }

    function test_CreateReverts_StaleOracle() public {
        skip(STALE + 1);
        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.StalePrice.selector, address(wbtc)));
        arc.createOrder(p);
    }

    // --------------------------------------------------------------- cancel

    function test_Cancel_RefundsEveryOrderType() public {
        for (uint256 k; k <= 6; ++k) {
            (uint256 id, address escrow, uint256 amt) = _mk(k);
            uint256 before_ = MockBal(escrow, alice);
            vm.expectEmit(true, true, false, true, address(arc));
            emit ArcTradeOrders.OrderCancelled(id, alice, amt);
            vm.prank(alice);
            arc.cancelOrder(id);
            assertEq(MockBal(escrow, alice), before_ + amt, "refund");
            assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.CANCELLED));
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderNotOpen.selector, id));
            arc.cancelOrder(id);
        }
        assertEq(wbtc.balanceOf(address(arc)), 0);
        assertEq(weth.balanceOf(address(arc)), 0);
        assertEq(usdc.balanceOf(address(arc)), 0);
    }

    function test_Cancel_OnlyOwner() public {
        uint256 id = _limitSellBtc(65_000);
        vm.prank(bob);
        vm.expectRevert(ArcTradeOrders.NotOrderOwner.selector);
        arc.cancelOrder(id);
    }

    function test_Cancel_InvalidId() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.InvalidOrder.selector, 99));
        arc.cancelOrder(99);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.InvalidOrder.selector, 99));
        arc.getOrder(99);
    }

    function test_Cancel_WorksWhilePausedAndWithDeadOracle() public {
        uint256 id = _limitSellBtc(65_000);
        vm.prank(owner);
        arc.pause();
        btcFeed.setBroken(true);
        uint256 before_ = wbtc.balanceOf(alice);
        vm.prank(alice);
        arc.cancelOrder(id);
        assertEq(wbtc.balanceOf(alice), before_ + BTC_AMT);
    }

    // --------------------------------------------------------------- expire

    function test_Expire_RefundsEveryOrderTypeToOwnerByAnyone() public {
        uint256[7] memory ids;
        address[7] memory esc;
        uint256[7] memory amts;
        for (uint256 k; k <= 6; ++k) (ids[k], esc[k], amts[k]) = _mk(k);
        skip(7 days); // feeds are now stale: expiry must not need the oracle
        for (uint256 k; k <= 6; ++k) {
            uint256 before_ = MockBal(esc[k], alice);
            vm.expectEmit(true, true, false, true, address(arc));
            emit ArcTradeOrders.OrderExpired(ids[k], alice, amts[k]);
            vm.prank(bob);
            arc.expireOrder(ids[k]);
            assertEq(MockBal(esc[k], alice), before_ + amts[k]);
            assertEq(uint8(arc.getOrder(ids[k]).status), uint8(ArcTradeOrders.Status.EXPIRED));
        }
        assertEq(wbtc.balanceOf(address(arc)) + weth.balanceOf(address(arc)) + usdc.balanceOf(address(arc)), 0);
    }

    function test_Expire_BeforeExpiryReverts() public {
        uint256 id = _limitSellBtc(65_000);
        uint256 exp = arc.getOrder(id).expiry;
        vm.warp(exp - 1);
        vm.expectRevert(ArcTradeOrders.NotExpired.selector);
        arc.expireOrder(id);
        vm.warp(exp);
        arc.expireOrder(id);
    }

    function test_Expire_TwiceAndCancelAfterRevert() public {
        uint256 id = _limitSellBtc(65_000);
        skip(7 days);
        arc.expireOrder(id);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderNotOpen.selector, id));
        arc.expireOrder(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderNotOpen.selector, id));
        arc.cancelOrder(id);
    }

    function test_Expire_WorksWhilePaused() public {
        uint256 id = _limitSellBtc(65_000);
        skip(7 days);
        vm.prank(owner);
        arc.pause();
        arc.expireOrder(id);
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXPIRED));
    }

    function test_Create_RevertsWhenPaused() public {
        vm.prank(owner);
        arc.pause();
        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 0);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arc.createOrder(p);
    }
}
