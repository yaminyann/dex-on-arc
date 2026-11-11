// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {MockERC20, MockAggregator, MockSwapTarget} from "./ArcTradeMocks.sol";
import {ArcTradeOrdersTestBase} from "./ArcTradeOrders.Base.t.sol";

/// @dev Random-walk actor: creates, executes, cancels and expires orders / DCA plans while moving prices and time.
contract ArcTradeHandler is Test {
    ArcTradeOrders public arc;
    MockERC20 public usdc;
    MockERC20 public wbtc;
    MockERC20 public weth;
    MockAggregator public usdcFeed;
    MockAggregator public btcFeed;
    MockAggregator public ethFeed;
    MockSwapTarget public dex;

    uint256 public executedOrders;
    uint256 public executedDcas;

    constructor(
        ArcTradeOrders arc_, MockERC20 u, MockERC20 b, MockERC20 e, MockAggregator uf, MockAggregator bf, MockAggregator ef, MockSwapTarget d
    ) {
        arc = arc_;
        usdc = u;
        wbtc = b;
        weth = e;
        usdcFeed = uf;
        btcFeed = bf;
        ethFeed = ef;
        dex = d;
        usdc.approve(address(arc), type(uint256).max);
        wbtc.approve(address(arc), type(uint256).max);
        weth.approve(address(arc), type(uint256).max);
    }

    function _touch() internal {
        usdcFeed.setUpdatedAt(block.timestamp);
        btcFeed.setUpdatedAt(block.timestamp);
        ethFeed.setUpdatedAt(block.timestamp);
    }

    function _base(uint256 seed) internal view returns (MockERC20) {
        return seed % 2 == 0 ? wbtc : weth;
    }

    function movePrice(uint256 seed) external {
        btcFeed.set(int256(bound(seed, 30_000e8, 120_000e8)));
        ethFeed.set(int256(bound(seed >> 128, 1_500e8, 6_000e8)));
        _touch();
    }

    function warp(uint256 seed) external {
        skip(bound(seed, 1, 2 days));
        _touch();
    }

    function createSell(uint256 seed, uint256 amt) external {
        _touch();
        MockERC20 base = _base(seed);
        amt = bound(amt, 1, address(base) == address(wbtc) ? 5e8 : 100e18);
        (uint256 price,) = arc.currentPrice(address(base));
        base.mint(address(this), amt);
        ArcTradeOrders.CreateParams memory p;
        p.base = address(base);
        p.side = ArcTradeOrders.Side.SELL;
        p.amountIn = amt;
        p.maxSlippageBps = 100;
        p.expiry = uint40(block.timestamp + 1 hours + ((seed >> 16) % 4 days));
        uint256 kind = (seed >> 8) % 6;
        if (kind == 0) {
            p.orderType = ArcTradeOrders.OrderType.LIMIT;
            p.triggerPrice = price * 105 / 100;
        } else if (kind == 1) {
            p.orderType = ArcTradeOrders.OrderType.STOP_LOSS;
            p.triggerPrice = price * 90 / 100;
        } else if (kind == 2) {
            p.orderType = ArcTradeOrders.OrderType.TAKE_PROFIT;
            p.triggerPrice = price * 110 / 100;
        } else if (kind == 3) {
            p.orderType = ArcTradeOrders.OrderType.STOP_LIMIT;
            p.triggerPrice = price * 90 / 100;
            p.limitPrice = price * 85 / 100;
        } else if (kind == 4) {
            p.orderType = ArcTradeOrders.OrderType.TRAILING_STOP;
            p.trailBps = 500;
        } else {
            p.orderType = ArcTradeOrders.OrderType.OCO;
            p.triggerPrice = price * 90 / 100;
            p.limitPrice = price * 110 / 100;
        }
        arc.createOrder(p);
    }

    function createBuy(uint256 seed, uint256 amt) external {
        _touch();
        MockERC20 base = _base(seed);
        amt = bound(amt, 1e6, 1e12);
        (uint256 price,) = arc.currentPrice(address(base));
        usdc.mint(address(this), amt);
        ArcTradeOrders.CreateParams memory p;
        p.base = address(base);
        p.side = ArcTradeOrders.Side.BUY;
        p.orderType = ArcTradeOrders.OrderType.LIMIT;
        p.amountIn = amt;
        p.triggerPrice = price * (90 + (seed >> 8) % 25) / 100;
        p.maxSlippageBps = 100;
        p.expiry = uint40(block.timestamp + 1 hours + ((seed >> 16) % 4 days));
        arc.createOrder(p);
    }

    function createDca(uint256 seed, uint256 amt, uint256 n) external {
        _touch();
        usdc.mint(address(this), 1e13);
        arc.createDca(address(_base(seed)), bound(amt, 1e6, 1e10), uint16(bound(n, 1, 10)), 3600 + uint32((seed >> 8) % 1 days), 0, 100, 0);
    }

    function _orderId(uint256 seed) internal view returns (uint256) {
        uint256 n = arc.nextOrderId();
        return n == 1 ? 0 : bound(seed, 1, n - 1);
    }

    function execute(uint256 seed, uint256 outBps) external {
        uint256 id = _orderId(seed);
        if (id != 0) _tryExecute(id, outBps);
    }

    /// @dev Moves the order's feed so the order is triggered, then tries to execute it.
    function forceExecute(uint256 seed, uint256 outBps) external {
        uint256 id = _orderId(seed);
        if (id == 0) return;
        ArcTradeOrders.Order memory o = arc.getOrder(id);
        if (o.status != ArcTradeOrders.Status.OPEN) return;
        uint256 target;
        ArcTradeOrders.OrderType t = o.orderType;
        if (t == ArcTradeOrders.OrderType.LIMIT) {
            target = o.side == ArcTradeOrders.Side.BUY ? o.triggerPrice * 99 / 100 : o.triggerPrice * 101 / 100;
        } else if (t == ArcTradeOrders.OrderType.TAKE_PROFIT) {
            target = o.triggerPrice * 101 / 100;
        } else if (t == ArcTradeOrders.OrderType.TRAILING_STOP) {
            target = o.peakPrice * 90 / 100;
        } else {
            target = o.triggerPrice * 99 / 100;
        }
        int256 ans = int256(target / 1e10);
        if (ans == 0) return;
        (o.base == address(wbtc) ? btcFeed : ethFeed).set(ans);
        _tryExecute(id, outBps);
    }

    function _tryExecute(uint256 id, uint256 outBps) internal {
        _touch();
        ArcTradeOrders.Order memory o = arc.getOrder(id);
        if (o.status != ArcTradeOrders.Status.OPEN) return;
        (uint256 price,) = arc.currentPrice(o.base);
        bool buy = o.side == ArcTradeOrders.Side.BUY;
        uint256 mkt = buy ? arc.baseForQuote(o.base, o.amountIn, price) : arc.quoteForBase(o.base, o.amountIn, price);
        // near-market outputs: the highest values pass the net-of-fee check, lower ones exercise revert paths
        dex.setRate(mkt * bound(outBps, 9_850, 10_100) / 10_000, o.amountIn);
        address tIn = buy ? address(usdc) : o.base;
        address tOut = buy ? o.base : address(usdc);
        try arc.execute(id, address(dex), abi.encodeCall(MockSwapTarget.swap, (tIn, tOut, o.amountIn))) {
            ++executedOrders;
        } catch {}
    }

    function cancel(uint256 seed) external {
        uint256 id = _orderId(seed);
        if (id != 0) try arc.cancelOrder(id) {} catch {}
    }

    function expire(uint256 seed) external {
        uint256 id = _orderId(seed);
        if (id != 0) try arc.expireOrder(id) {} catch {}
    }

    function poke(uint256 seed) external {
        uint256 id = _orderId(seed);
        _touch();
        if (id != 0) try arc.pokeTrailing(id) {} catch {}
    }

    function activate(uint256 seed) external {
        uint256 id = _orderId(seed);
        _touch();
        if (id != 0) try arc.activateStop(id) {} catch {}
    }

    function _dcaId(uint256 seed) internal view returns (uint256) {
        uint256 n = arc.nextDcaId();
        return n == 1 ? 0 : bound(seed, 1, n - 1);
    }

    function executeDca(uint256 seed, uint256 outBps) external {
        uint256 id = _dcaId(seed);
        if (id == 0) return;
        _touch();
        ArcTradeOrders.Dca memory d = arc.getDca(id);
        if (d.status != ArcTradeOrders.DcaStatus.ACTIVE) return;
        (uint256 price,) = arc.currentPrice(d.base);
        uint256 amountIn = d.amountPerBuy < d.budgetRemaining ? d.amountPerBuy : d.budgetRemaining;
        uint256 mkt = arc.baseForQuote(d.base, amountIn, price);
        dex.setRate(mkt * bound(outBps, 9_850, 10_100) / 10_000, amountIn);
        try arc.executeDca(id, address(dex), abi.encodeCall(MockSwapTarget.swap, (address(usdc), d.base, amountIn))) {
            ++executedDcas;
        } catch {}
    }

    function cancelDca(uint256 seed) external {
        uint256 id = _dcaId(seed);
        if (id != 0) try arc.cancelDca(id) {} catch {}
    }

    function pauseDca(uint256 seed) external {
        uint256 id = _dcaId(seed);
        if (id != 0) try arc.pauseDca(id) {} catch {}
    }

    function resumeDca(uint256 seed) external {
        uint256 id = _dcaId(seed);
        if (id != 0) try arc.resumeDca(id) {} catch {}
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 120
contract ArcTradeOrdersInvariantTest is ArcTradeOrdersTestBase {
    ArcTradeHandler internal handler;

    function setUp() public override {
        super.setUp();
        usdc.mint(address(dex), 1e22);
        wbtc.mint(address(dex), 1e22);
        handler = new ArcTradeHandler(arc, usdc, wbtc, weth, usdcFeed, btcFeed, ethFeed, dex);
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](15);
        sel[0] = ArcTradeHandler.movePrice.selector;
        sel[1] = ArcTradeHandler.warp.selector;
        sel[2] = ArcTradeHandler.createSell.selector;
        sel[3] = ArcTradeHandler.createBuy.selector;
        sel[4] = ArcTradeHandler.createDca.selector;
        sel[5] = ArcTradeHandler.execute.selector;
        sel[6] = ArcTradeHandler.cancel.selector;
        sel[7] = ArcTradeHandler.expire.selector;
        sel[8] = ArcTradeHandler.poke.selector;
        sel[9] = ArcTradeHandler.activate.selector;
        sel[10] = ArcTradeHandler.executeDca.selector;
        sel[11] = ArcTradeHandler.cancelDca.selector;
        sel[12] = ArcTradeHandler.pauseDca.selector;
        sel[13] = ArcTradeHandler.resumeDca.selector;
        sel[14] = ArcTradeHandler.forceExecute.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// @dev Sum of escrow owed to open orders and live DCA plans, per token.
    function _openEscrow() internal view returns (uint256 qSum, uint256 btcSum, uint256 ethSum) {
        uint256 n = arc.nextOrderId();
        for (uint256 id = 1; id < n; ++id) {
            ArcTradeOrders.Order memory o = arc.getOrder(id);
            if (o.status != ArcTradeOrders.Status.OPEN) continue;
            if (o.side == S_BUY) qSum += o.amountIn;
            else if (o.base == address(wbtc)) btcSum += o.amountIn;
            else ethSum += o.amountIn;
        }
        uint256 m = arc.nextDcaId();
        for (uint256 id = 1; id < m; ++id) {
            ArcTradeOrders.Dca memory d = arc.getDca(id);
            if (d.status == ArcTradeOrders.DcaStatus.ACTIVE || d.status == ArcTradeOrders.DcaStatus.PAUSED) {
                qSum += d.budgetRemaining;
            }
        }
    }

    function invariant_ContractBalanceCoversOpenEscrow() public view {
        (uint256 q, uint256 b, uint256 e) = _openEscrow();
        assertGe(usdc.balanceOf(address(arc)), q, "quote escrow underfunded");
        assertGe(wbtc.balanceOf(address(arc)), b, "btc escrow underfunded");
        assertGe(weth.balanceOf(address(arc)), e, "eth escrow underfunded");
    }

    /// @dev No dust is ever stranded: balances equal exactly the open escrow.
    function invariant_BalanceEqualsEscrowExactly() public view {
        (uint256 q, uint256 b, uint256 e) = _openEscrow();
        assertEq(usdc.balanceOf(address(arc)), q);
        assertEq(wbtc.balanceOf(address(arc)), b);
        assertEq(weth.balanceOf(address(arc)), e);
    }

    function invariant_NoStandingApprovalsToSwapTarget() public view {
        assertEq(usdc.allowance(address(arc), address(dex)), 0);
        assertEq(wbtc.allowance(address(arc), address(dex)), 0);
        assertEq(weth.allowance(address(arc), address(dex)), 0);
    }

    function invariant_DcaAccountingConsistent() public view {
        uint256 m = arc.nextDcaId();
        for (uint256 id = 1; id < m; ++id) {
            ArcTradeOrders.Dca memory d = arc.getDca(id);
            assertEq((d.budgetRemaining + d.totalSpent) % d.amountPerBuy, 0);
            assertEq(d.totalSpent, uint256(d.executions) * d.amountPerBuy);
            if (d.status == ArcTradeOrders.DcaStatus.COMPLETED) assertEq(d.budgetRemaining, 0);
        }
    }
}
