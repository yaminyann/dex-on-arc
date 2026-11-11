// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {ArcTradeOrdersTestBase} from "./ArcTradeOrders.Base.t.sol";
import {MockAggregator, MaliciousSwapTarget} from "./ArcTradeMocks.sol";

/// @dev Tests for the v2 additions: minimum order size, config expiry, renounce lock, round check,
///      paged views and batch execution.
contract ArcTradeOrdersV2Test is ArcTradeOrdersTestBase {
    // ------------------------------------------------------------ minimum order size

    function test_MinOrder_DefaultsToZeroAndOwnerCanSetIt() public {
        assertEq(arc.minOrderQuote(), 0);
        vm.expectEmit(false, false, false, true, address(arc));
        emit ArcTradeOrders.MinOrderQuoteSet(5e6);
        vm.prank(owner);
        arc.setMinOrderQuote(5e6);
        assertEq(arc.minOrderQuote(), 5e6);
    }

    function test_MinOrder_OnlyOwnerAndBounded() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arc.setMinOrderQuote(1);
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.InvalidParameters.selector);
        arc.setMinOrderQuote(10_001e6); // above 10,000 whole quote tokens
        vm.prank(owner);
        arc.setMinOrderQuote(10_000e6);
    }

    function test_MinOrder_RejectsSmallSellBuyAndDca() public {
        vm.prank(owner);
        arc.setMinOrderQuote(100e6); // 100 USDC
        // Sell: 0.001 BTC at 60,000 = 60 USDC < 100.
        uint256 dust = 1e5;
        ArcTradeOrders.CreateParams memory sell = _p(address(wbtc), S_SELL, T_LIMIT, dust, 65_000e18, 0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderTooSmall.selector, 60e6, 100e6));
        arc.createOrder(sell);
        // Buy: 99 USDC.
        ArcTradeOrders.CreateParams memory buy = _p(address(wbtc), S_BUY, T_LIMIT, 99e6, 55_000e18, 0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderTooSmall.selector, 99e6, 100e6));
        arc.createOrder(buy);
        // DCA: amount per buy below the minimum.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.OrderTooSmall.selector, 50e6, 100e6));
        arc.createDca(address(wbtc), 50e6, 4, 3600, 0, SLIP, 0);
    }

    function test_MinOrder_AllowsExactMinimumAndDoesNotAffectExistingOrders() public {
        uint256 existing = _limitSellBtc(65_000);
        vm.prank(owner);
        arc.setMinOrderQuote(1_000e6);
        // The existing order is untouched and still cancellable.
        vm.prank(alice);
        arc.cancelOrder(existing);
        ArcTradeOrders.CreateParams memory buy = _p(address(wbtc), S_BUY, T_LIMIT, 1_000e6, 55_000e18, 0, 0);
        vm.prank(alice);
        arc.createOrder(buy); // exactly the minimum
    }

    // ------------------------------------------------------------ renounce lock

    function test_RenounceOwnership_IsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.RenounceDisabled.selector);
        arc.renounceOwnership();
        assertEq(arc.owner(), owner);
        vm.expectRevert(ArcTradeOrders.RenounceDisabled.selector);
        arc.renounceOwnership(); // not even a non-owner gets a different answer
    }

    // ------------------------------------------------------------ config expiry and content

    function test_ConfigQueued_EmitsFullContent() public {
        MockAggregator feed = new MockAggregator(8, 1e8);
        vm.expectEmit(false, false, false, true, address(arc));
        emit ArcTradeOrders.ConfigQueued(bytes32(0), block.timestamp + DELAY, address(wbtc), address(feed), 3600, true, false);
        vm.prank(owner);
        arc.queueTokenConfig(address(wbtc), address(feed), 3600);
        vm.expectEmit(false, false, false, true, address(arc));
        emit ArcTradeOrders.ConfigQueued(bytes32(0), block.timestamp + DELAY, address(dex), address(0), 0, false, true);
        vm.prank(owner);
        arc.queueSwapTarget(address(dex), true);
    }

    function test_ApplyConfig_ExpiresAfterGraceWindow() public {
        MockAggregator feed = new MockAggregator(8, 1e8);
        vm.prank(owner);
        bytes32 id = arc.queueTokenConfig(address(wbtc), address(feed), STALE);
        uint256 eta = arc.pendingConfigEta(id);
        vm.warp(eta + 14 days + 1);
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.ConfigExpired.selector);
        arc.applyConfig(id);
        // An expired entry can still be cleaned up.
        vm.prank(owner);
        arc.cancelConfig(id);
        assertEq(arc.pendingConfigEta(id), 0);
    }

    function test_ApplyConfig_StillWorksInsideTheWindow() public {
        MockAggregator feed = new MockAggregator(8, 60_000e8);
        vm.prank(owner);
        bytes32 id = arc.queueTokenConfig(address(wbtc), address(feed), STALE);
        vm.warp(arc.pendingConfigEta(id) + 14 days);
        feed.setUpdatedAt(block.timestamp);
        vm.prank(owner);
        arc.applyConfig(id);
        (address f,,,) = arc.tokenConfigs(address(wbtc));
        assertEq(f, address(feed));
    }

    // ------------------------------------------------------------ oracle round check

    function test_Oracle_RejectsAnswerCarriedFromAnEarlierRound() public {
        // A feed whose answeredInRound lags roundId reports a stale carried-over answer.
        LaggingFeed lag = new LaggingFeed(60_000e8);
        vm.prank(owner);
        bytes32 id = arc.queueTokenConfig(address(wbtc), address(lag), STALE);
        skip(DELAY);
        _touch();
        lag.touch();
        vm.prank(owner);
        arc.applyConfig(id);
        lag.touch();
        // Healthy round: priced normally.
        arc.currentPrice(address(wbtc));
        lag.setLagging(true);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.StalePrice.selector, address(wbtc)));
        arc.currentPrice(address(wbtc));
    }

    // ------------------------------------------------------------ paged views

    function test_PagedViews_Orders() public {
        uint256[] memory ids = new uint256[](5);
        for (uint256 i; i < 5; ++i) ids[i] = _limitSellBtc(65_000 + i);
        assertEq(arc.orderCount(alice), 5);
        assertEq(arc.orderCount(bob), 0);

        uint256[] memory page = arc.getOrderIdsPage(alice, 1, 2);
        assertEq(page.length, 2);
        assertEq(page[0], ids[1]);
        assertEq(page[1], ids[2]);
        assertEq(arc.getOrderIdsPage(alice, 4, 10).length, 1);
        assertEq(arc.getOrderIdsPage(alice, 5, 10).length, 0);
        assertEq(arc.getOrderIdsPage(alice, 0, 0).length, 0);
        assertEq(arc.getOrderIdsPage(alice, type(uint256).max, 5).length, 0);

        ArcTradeOrders.Order[] memory batch = arc.getOrders(page);
        assertEq(batch.length, 2);
        assertEq(batch[0].owner, alice);
        assertEq(batch[1].triggerPrice, 65_002e18);

        uint256[] memory withUnknown = new uint256[](2);
        withUnknown[0] = ids[0];
        withUnknown[1] = 999;
        ArcTradeOrders.Order[] memory mixed = arc.getOrders(withUnknown);
        assertEq(mixed[0].owner, alice);
        assertEq(mixed[1].owner, address(0));
    }

    function test_PagedViews_Dca() public {
        vm.startPrank(alice);
        uint256 a = arc.createDca(address(wbtc), 100e6, 3, 3600, 0, SLIP, 0);
        uint256 b = arc.createDca(address(wbtc), 200e6, 3, 3600, 0, SLIP, 0);
        vm.stopPrank();
        assertEq(arc.dcaCount(alice), 2);
        uint256[] memory page = arc.getDcaIdsPage(alice, 0, 5);
        assertEq(page.length, 2);
        assertEq(page[0], a);
        assertEq(page[1], b);
    }

    // ------------------------------------------------------------ batch execution

    function test_ExecuteMany_ExecutesReadyOrdersAndSkipsTheRest() public {
        uint256 a = _limitSellBtc(65_000);
        uint256 b = _limitSellBtc(65_000);
        uint256 stuck = _limitSellBtc(90_000); // never triggers
        _setBtc(66_000);

        uint256[] memory ids = new uint256[](3);
        address[] memory targets = new address[](3);
        bytes[] memory datas = new bytes[](3);
        ids[0] = a;
        ids[1] = stuck;
        ids[2] = b;
        for (uint256 i; i < 3; ++i) targets[i] = address(dex);
        uint256 gross = _marketOut(a);
        dex.setRate(gross, BTC_AMT);
        for (uint256 i; i < 3; ++i) datas[i] = _swapData(address(wbtc), address(usdc), BTC_AMT);

        uint256 keeperBefore = usdc.balanceOf(keeper);
        vm.expectEmit(true, false, false, false, address(arc));
        emit ArcTradeOrders.BatchItemFailed(stuck);
        vm.prank(keeper);
        uint256 executed = arc.executeMany(ids, targets, datas);

        assertEq(executed, 2);
        assertEq(uint8(arc.getOrder(a).status), uint8(ArcTradeOrders.Status.EXECUTED));
        assertEq(uint8(arc.getOrder(b).status), uint8(ArcTradeOrders.Status.EXECUTED));
        assertEq(uint8(arc.getOrder(stuck).status), uint8(ArcTradeOrders.Status.OPEN));
        // The batch caller (not the contract) earns every fee.
        assertEq(usdc.balanceOf(keeper), keeperBefore + 2 * _fee(gross));
        assertEq(wbtc.balanceOf(address(arc)), BTC_AMT); // only the stuck order's escrow remains
    }

    function test_ExecuteMany_LengthMismatchReverts() public {
        uint256[] memory ids = new uint256[](2);
        address[] memory targets = new address[](1);
        bytes[] memory datas = new bytes[](2);
        vm.prank(keeper);
        vm.expectRevert(ArcTradeOrders.BatchLengthMismatch.selector);
        arc.executeMany(ids, targets, datas);
    }

    function test_ExecuteMany_RespectsPause() public {
        vm.prank(owner);
        arc.pause();
        uint256[] memory ids = new uint256[](0);
        vm.prank(keeper);
        vm.expectRevert();
        arc.executeMany(ids, new address[](0), new bytes[](0));
    }

    function test_ExecuteFor_CannotBeCalledDirectly() public {
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        bytes memory data = _prep(id, _marketOut(id));
        vm.prank(keeper);
        vm.expectRevert(ArcTradeOrders.NotSelf.selector);
        arc.executeFor(id, address(dex), data, keeper);
    }

    function test_ExecuteMany_HostileTargetCannotRedirectTheBatchFee() public {
        // A hostile target that tries to re-enter executeFor as itself is rejected (NotSelf) and the item is skipped.
        MaliciousSwapTarget evil = new MaliciousSwapTarget();
        _allow(address(evil));
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        evil.setReenter(address(arc), abi.encodeCall(ArcTradeOrders.executeFor, (id, address(evil), bytes(""), address(evil))));
        usdc.mint(address(evil), 1e15);
        uint256[] memory ids = new uint256[](1);
        address[] memory targets = new address[](1);
        bytes[] memory datas = new bytes[](1);
        ids[0] = id;
        targets[0] = address(evil);
        datas[0] = abi.encodeCall(MaliciousSwapTarget.swap, (address(wbtc), address(usdc), BTC_AMT));
        evil.configure(MaliciousSwapTarget.Mode.REENTER, _marketOut(id));
        // Mode was reset by configure; set the reenter payload again so the hostile path actually runs.
        evil.setReenter(address(arc), abi.encodeCall(ArcTradeOrders.executeFor, (id, address(evil), bytes(""), address(evil))));
        uint256 gross = _marketOut(id);
        vm.prank(keeper);
        uint256 executed = arc.executeMany(ids, targets, datas);
        assertEq(executed, 1); // the swap itself was fine
        assertTrue(evil.reenterRan());
        assertFalse(evil.reenterOk()); // the re-entrant call into executeFor was rejected
        assertEq(usdc.balanceOf(keeper), _fee(gross)); // the fee still went to the real caller, not to the hostile target
    }

}

/// @dev Feed whose answeredInRound can lag its roundId, like a feed that stopped producing new rounds.
contract LaggingFeed {
    uint8 public constant decimals = 8;
    int256 private _answer;
    uint256 private _updatedAt;
    bool private _lagging;

    constructor(int256 a) {
        _answer = a;
        _updatedAt = block.timestamp;
    }

    function touch() external {
        _updatedAt = block.timestamp;
    }

    function setLagging(bool v) external {
        _lagging = v;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (5, _answer, _updatedAt, _updatedAt, _lagging ? 4 : 5);
    }
}
