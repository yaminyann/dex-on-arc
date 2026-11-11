// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {MockERC20, MockAggregator} from "./ArcTradeMocks.sol";
import {ArcTradeOrdersTestBase} from "./ArcTradeOrders.Base.t.sol";

contract ArcTradeOrdersFuzzTest is ArcTradeOrdersTestBase {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAXP = type(uint128).max;

    /// @dev Fresh deployment whose quote/base have arbitrary decimals.
    function _fresh(uint8 qd, uint8 bd) internal returns (ArcTradeOrders a, address base) {
        MockERC20 q = new MockERC20("q", "q", qd);
        MockERC20 b = new MockERC20("b", "b", bd);
        MockAggregator f1 = new MockAggregator(8, 1e8);
        MockAggregator f2 = new MockAggregator(8, 2e8);
        a = new ArcTradeOrders(owner, address(q), 1 hours);
        vm.startPrank(owner);
        bytes32 x = a.queueTokenConfig(address(q), address(f1), STALE);
        bytes32 y = a.queueTokenConfig(address(b), address(f2), STALE);
        vm.stopPrank();
        skip(1 hours);
        vm.startPrank(owner);
        a.applyConfig(x);
        a.applyConfig(y);
        vm.stopPrank();
        base = address(b);
    }

    function testFuzz_QuoteForBase_MatchesExactReference(uint8 qdSeed, uint8 bdSeed, uint256 baseAmt, uint256 price) public {
        uint8 qd = uint8(bound(qdSeed, 0, 18));
        uint8 bd = uint8(bound(bdSeed, 0, 18));
        baseAmt = bound(baseAmt, 0, 1e30);
        price = bound(price, 1, MAXP);
        (ArcTradeOrders a, address base) = _fresh(qd, bd);
        uint256 expected = Math.mulDiv(baseAmt * price, 10 ** uint256(qd), WAD * 10 ** uint256(bd));
        assertEq(a.quoteForBase(base, baseAmt, price), expected);
    }

    function testFuzz_BaseForQuote_MatchesExactReference(uint8 qdSeed, uint8 bdSeed, uint256 quoteAmt, uint256 price) public {
        uint8 qd = uint8(bound(qdSeed, 0, 18));
        uint8 bd = uint8(bound(bdSeed, 0, 18));
        quoteAmt = bound(quoteAmt, 0, 1e30);
        price = bound(price, 1, MAXP);
        (ArcTradeOrders a, address base) = _fresh(qd, bd);
        uint256 expected = Math.mulDiv(quoteAmt * WAD, 10 ** uint256(bd), price * 10 ** uint256(qd));
        assertEq(a.baseForQuote(base, quoteAmt, price), expected);
    }

    function testFuzz_RoundTrip_NeverInflates(uint8 qdSeed, uint8 bdSeed, uint256 amt, uint256 price) public {
        uint8 qd = uint8(bound(qdSeed, 0, 18));
        uint8 bd = uint8(bound(bdSeed, 0, 18));
        amt = bound(amt, 0, 1e30);
        price = bound(price, 1e6, 1e30);
        (ArcTradeOrders a, address base) = _fresh(qd, bd);

        uint256 q = a.quoteForBase(base, amt, price);
        uint256 b2 = a.baseForQuote(base, q, price);
        assertLe(b2, amt, "base->quote->base inflated");
        // Loss is bounded by the value of one quote unit (+ rounding).
        assertLe(amt - b2, a.baseForQuote(base, 1, price) + 2, "base loss too large");

        uint256 b = a.baseForQuote(base, amt, price);
        uint256 q2 = a.quoteForBase(base, b, price);
        assertLe(q2, amt, "quote->base->quote inflated");
        assertLe(amt - q2, a.quoteForBase(base, 1, price) + 2, "quote loss too large");
    }

    function testFuzz_Conversions_Monotonic(uint8 qdSeed, uint8 bdSeed, uint256 a1, uint256 a2, uint256 p1, uint256 p2) public {
        uint8 qd = uint8(bound(qdSeed, 0, 18));
        uint8 bd = uint8(bound(bdSeed, 0, 18));
        a1 = bound(a1, 0, 1e30);
        a2 = bound(a2, a1, 1e30);
        p1 = bound(p1, 1, MAXP);
        p2 = bound(p2, p1, MAXP);
        (ArcTradeOrders a, address base) = _fresh(qd, bd);
        assertLe(a.quoteForBase(base, a1, p1), a.quoteForBase(base, a2, p1));
        assertLe(a.quoteForBase(base, a1, p1), a.quoteForBase(base, a1, p2));
        assertGe(a.baseForQuote(base, a1, p1), a.baseForQuote(base, a1, p2));
    }

    function test_BaseForQuote_ZeroPriceReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.InvalidPrice.selector, address(wbtc)));
        arc.baseForQuote(address(wbtc), 1e6, 0);
    }

    function test_Conversions_KnownValuesAcrossDecimals() public view {
        assertEq(arc.quoteForBase(address(wbtc), 1e8, 60_000e18), 60_000e6);
        assertEq(arc.quoteForBase(address(weth), 1e18, 3_000e18), 3_000e6);
        assertEq(arc.baseForQuote(address(wbtc), 60_000e6, 60_000e18), 1e8);
        assertEq(arc.baseForQuote(address(weth), 3_000e6, 3_000e18), 1e18);
    }

    // --------------------------------------------------- end-to-end fuzz

    function testFuzz_SellLimit_ProceedsNeverBelowUserLimit(uint256 priceUsd, uint256 grossSeed) public {
        priceUsd = bound(priceUsd, 65_000, 120_000);
        uint256 id = _limitSellBtc(65_000);
        _setBtc(priceUsd);
        (bool trig, uint256 price, uint256 minOut) = arc.previewOrder(id);
        assertTrue(trig);
        assertGe(minOut, arc.quoteForBase(address(wbtc), BTC_AMT, 65_000e18));
        uint256 market = arc.quoteForBase(address(wbtc), BTC_AMT, price);
        uint256 gross = bound(grossSeed, 0, 2 * market);
        uint256 fee = _fee(gross);
        uint256 net = gross - fee;

        bytes memory data = _prep(id, gross);
        uint256 aBefore = usdc.balanceOf(alice);
        uint256 kBefore = usdc.balanceOf(keeper);
        if (net < minOut) {
            bytes memory err = abi.encodeWithSelector(ArcTradeOrders.InsufficientOutput.selector, net, minOut);
            vm.prank(keeper);
            vm.expectRevert(err);
            arc.execute(id, address(dex), data);
            assertEq(usdc.balanceOf(alice), aBefore);
            assertEq(wbtc.balanceOf(address(arc)), BTC_AMT);
        } else {
            vm.prank(keeper);
            arc.execute(id, address(dex), data);
            assertEq(usdc.balanceOf(alice) - aBefore, net);
            assertEq(usdc.balanceOf(keeper) - kBefore, fee);
            assertGe(net, arc.quoteForBase(address(wbtc), BTC_AMT, 65_000e18));
            assertEq(usdc.balanceOf(address(arc)), 0);
            assertEq(wbtc.balanceOf(address(arc)), 0);
        }
    }

    function testFuzz_BuyLimit_EthProceedsNeverBelowUserLimit(uint256 priceUsd, uint256 grossSeed) public {
        priceUsd = bound(priceUsd, 1_000, 3_000);
        uint256 amt = 30_000e6;
        uint256 id = _create(alice, _p(address(weth), S_BUY, T_LIMIT, amt, 3_000e18, 0, 0));
        _setEth(priceUsd);
        (bool trig, uint256 price, uint256 minOut) = arc.previewOrder(id);
        assertTrue(trig);
        uint256 market = arc.baseForQuote(address(weth), amt, price);
        uint256 gross = bound(grossSeed, 0, 2 * market);
        uint256 net = gross - _fee(gross);
        bytes memory data = _prep(id, gross);
        uint256 before_ = weth.balanceOf(alice);
        if (net < minOut) {
            bytes memory err = abi.encodeWithSelector(ArcTradeOrders.InsufficientOutput.selector, net, minOut);
            vm.prank(keeper);
            vm.expectRevert(err);
            arc.execute(id, address(dex), data);
        } else {
            vm.prank(keeper);
            arc.execute(id, address(dex), data);
            assertEq(weth.balanceOf(alice) - before_, net);
            assertGe(net, arc.baseForQuote(address(weth), amt, 3_000e18)); // never worse than the limit price
            assertEq(usdc.balanceOf(address(arc)), 0);
        }
    }

    function testFuzz_Dca_BudgetConservation(uint256 nSeed, uint256 priceUsd) public {
        uint16 n = uint16(bound(nSeed, 1, 12));
        priceUsd = bound(priceUsd, 10_000, 200_000);
        vm.prank(alice);
        uint256 id = arc.createDca(address(wbtc), 500e6, n, 1 days, 0, SLIP, 0);
        uint256 spentTotal;
        for (uint256 i; i < n; ++i) {
            if (i != 0) skip(1 days);
            _setBtc(priceUsd);
            (uint256 price,) = arc.currentPrice(address(wbtc));
            uint256 gross = arc.baseForQuote(address(wbtc), 500e6, price);
            if (gross == 0) return; // dust output cannot execute
            dex.setRate(gross, 500e6);
            vm.prank(keeper);
            arc.executeDca(id, address(dex), _swapData(address(usdc), address(wbtc), 500e6));
            spentTotal += 500e6;
            ArcTradeOrders.Dca memory d = arc.getDca(id);
            assertEq(d.budgetRemaining + d.totalSpent, uint256(n) * 500e6);
            assertEq(usdc.balanceOf(address(arc)), d.budgetRemaining);
        }
        assertEq(uint8(arc.getDca(id).status), uint8(ArcTradeOrders.DcaStatus.COMPLETED));
        assertEq(arc.getDca(id).totalSpent, spentTotal);
    }
}
