// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {MockERC20, MockAggregator} from "./ArcTradeMocks.sol";
import {ArcTradeOrdersTestBase} from "./ArcTradeOrders.Base.t.sol";

contract ArcTradeOrdersConfigTest is ArcTradeOrdersTestBase {
    // ------------------------------------------------------------ constructor

    function test_Constructor_SetsState() public view {
        assertEq(arc.owner(), owner);
        assertEq(arc.quote(), address(usdc));
        assertEq(arc.configDelay(), DELAY);
        assertEq(arc.keeperFeeBps(), 10);
        assertEq(arc.nextOrderId(), 1);
        assertEq(arc.nextDcaId(), 1);
    }

    function test_Constructor_RevertsOnZeroQuote() public {
        vm.expectRevert(ArcTradeOrders.ZeroAddress.selector);
        new ArcTradeOrders(owner, address(0), DELAY);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ArcTradeOrders(address(0), address(usdc), DELAY);
    }

    function test_Constructor_DelayBounds() public {
        vm.expectRevert(ArcTradeOrders.InvalidDelay.selector);
        new ArcTradeOrders(owner, address(usdc), 1 hours - 1);
        vm.expectRevert(ArcTradeOrders.InvalidDelay.selector);
        new ArcTradeOrders(owner, address(usdc), 14 days + 1);
        assertEq(new ArcTradeOrders(owner, address(usdc), 1 hours).configDelay(), 1 hours);
        assertEq(new ArcTradeOrders(owner, address(usdc), 14 days).configDelay(), 14 days);
    }

    function test_Ownable2Step_TransferNeedsAccept() public {
        vm.prank(owner);
        arc.transferOwnership(bob);
        assertEq(arc.owner(), owner);
        vm.prank(bob);
        arc.acceptOwnership();
        assertEq(arc.owner(), bob);
    }

    // ------------------------------------------------------- token config queue

    function test_QueueTokenConfig_StoresEtaAndEmits() public {
        vm.expectEmit(false, false, false, true, address(arc));
        emit ArcTradeOrders.ConfigQueued(bytes32(0), block.timestamp + DELAY, address(wbtc), address(btcFeed), STALE, true, false);
        vm.prank(owner);
        bytes32 id = arc.queueTokenConfig(address(wbtc), address(btcFeed), STALE);
        assertEq(arc.pendingConfigEta(id), block.timestamp + DELAY);
    }

    function test_QueueTokenConfig_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arc.queueTokenConfig(address(wbtc), address(btcFeed), STALE);
    }

    function test_QueueTokenConfig_InvalidInputs() public {
        vm.startPrank(owner);
        vm.expectRevert(ArcTradeOrders.ZeroAddress.selector);
        arc.queueTokenConfig(address(0), address(btcFeed), STALE);
        vm.expectRevert(ArcTradeOrders.InvalidParameters.selector);
        arc.queueTokenConfig(address(wbtc), address(btcFeed), 59);
        vm.expectRevert(ArcTradeOrders.InvalidParameters.selector);
        arc.queueTokenConfig(address(wbtc), address(btcFeed), 172801);
        arc.queueTokenConfig(address(wbtc), address(btcFeed), 60);
        arc.queueTokenConfig(address(wbtc), address(btcFeed), 172800);
        vm.stopPrank();
    }

    function test_ApplyConfig_NotReadyThenReady() public {
        MockERC20 t = new MockERC20("T", "T", 12);
        MockAggregator f = new MockAggregator(8, 5e8);
        vm.prank(owner);
        bytes32 id = arc.queueTokenConfig(address(t), address(f), 3600);
        uint256 eta = arc.pendingConfigEta(id);

        vm.warp(eta - 1);
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.ConfigNotReady.selector);
        arc.applyConfig(id);

        vm.warp(eta);
        vm.expectEmit(true, true, false, true, address(arc));
        emit ArcTradeOrders.TokenConfigured(address(t), address(f), 8, 12, 3600);
        vm.prank(owner);
        arc.applyConfig(id);

        (address feed, uint8 fd, uint8 td, uint32 ms) = arc.tokenConfigs(address(t));
        assertEq(feed, address(f));
        assertEq(fd, 8);
        assertEq(td, 12);
        assertEq(ms, 3600);
        assertEq(arc.pendingConfigEta(id), 0);
    }

    function test_ApplyConfig_ConsumedAndUnknownRevert() public {
        vm.prank(owner);
        bytes32 id = arc.queueTokenConfig(address(wbtc), address(btcFeed), STALE);
        skip(DELAY);
        vm.startPrank(owner);
        arc.applyConfig(id);
        vm.expectRevert(ArcTradeOrders.ConfigUnknown.selector);
        arc.applyConfig(id);
        vm.expectRevert(ArcTradeOrders.ConfigUnknown.selector);
        arc.applyConfig(keccak256("nope"));
        vm.stopPrank();
    }

    function test_ApplyConfig_OnlyOwner() public {
        vm.prank(owner);
        bytes32 id = arc.queueTokenConfig(address(wbtc), address(btcFeed), STALE);
        skip(DELAY);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arc.applyConfig(id);
    }

    function test_ApplyConfig_UnsupportedDecimals() public {
        MockERC20 badToken = new MockERC20("B", "B", 60);
        MockAggregator badFeed = new MockAggregator(78, 1);
        vm.startPrank(owner);
        bytes32 a = arc.queueTokenConfig(address(badToken), address(btcFeed), STALE);
        bytes32 b = arc.queueTokenConfig(address(wbtc), address(badFeed), STALE);
        vm.stopPrank();
        skip(DELAY);
        vm.startPrank(owner);
        vm.expectRevert(ArcTradeOrders.UnsupportedDecimals.selector);
        arc.applyConfig(a);
        vm.expectRevert(ArcTradeOrders.UnsupportedDecimals.selector);
        arc.applyConfig(b);
        vm.stopPrank();
    }

    function test_CancelConfig_PreventsApply() public {
        vm.prank(owner);
        bytes32 id = arc.queueTokenConfig(address(wbtc), address(btcFeed), 3600);
        vm.expectEmit(true, false, false, false, address(arc));
        emit ArcTradeOrders.ConfigCancelled(id);
        vm.prank(owner);
        arc.cancelConfig(id);
        assertEq(arc.pendingConfigEta(id), 0);
        skip(DELAY);
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.ConfigUnknown.selector);
        arc.applyConfig(id);
        (, , , uint32 ms) = arc.tokenConfigs(address(wbtc));
        assertEq(ms, STALE);
    }

    function test_CancelConfig_UnknownAndNonOwnerRevert() public {
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.ConfigUnknown.selector);
        arc.cancelConfig(bytes32(uint256(1)));
        vm.prank(owner);
        bytes32 id = arc.queueTokenConfig(address(wbtc), address(btcFeed), 3600);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arc.cancelConfig(id);
    }

    function test_QueueSameConfigTwice_GivesDistinctIds() public {
        vm.startPrank(owner);
        bytes32 a = arc.queueTokenConfig(address(wbtc), address(btcFeed), 3600);
        bytes32 b = arc.queueTokenConfig(address(wbtc), address(btcFeed), 3600);
        vm.stopPrank();
        assertTrue(a != b);
    }

    function test_ZeroFeedConfig_DisablesButKeepsDecimals() public {
        vm.prank(owner);
        bytes32 id = arc.queueTokenConfig(address(wbtc), address(0), 7200);
        skip(DELAY);
        vm.prank(owner);
        arc.applyConfig(id);
        (address feed, uint8 fd, uint8 td, uint32 ms) = arc.tokenConfigs(address(wbtc));
        assertEq(feed, address(0));
        assertEq(fd, 8);
        assertEq(td, 8);
        assertEq(ms, 7200);
    }

    // ----------------------------------------------------------- disable (instant)

    function test_DisableToken_InstantBlocksNewOrdersKeepsMetadata() public {
        vm.expectEmit(true, true, false, true, address(arc));
        emit ArcTradeOrders.TokenConfigured(address(wbtc), address(0), 8, 8, STALE);
        vm.prank(owner);
        arc.disableToken(address(wbtc));
        (address feed,, uint8 td,) = arc.tokenConfigs(address(wbtc));
        assertEq(feed, address(0));
        assertEq(td, 8);

        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.TokenNotSupported.selector, address(wbtc)));
        arc.createOrder(p);
    }

    function test_DisableToken_DoesNotBlockRefunds() public {
        uint256 id = _limitSellBtc(65_000);
        vm.prank(owner);
        arc.disableToken(address(wbtc));
        uint256 before_ = wbtc.balanceOf(alice);
        vm.prank(alice);
        arc.cancelOrder(id);
        assertEq(wbtc.balanceOf(alice), before_ + BTC_AMT);
    }

    function test_DisableToken_Guards() public {
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.ZeroAddress.selector);
        arc.disableToken(address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arc.disableToken(address(wbtc));
    }

    // ------------------------------------------------------------ swap targets

    function test_QueueSwapTarget_Validation() public {
        vm.startPrank(owner);
        vm.expectRevert(ArcTradeOrders.ZeroAddress.selector);
        arc.queueSwapTarget(address(0), true);
        vm.expectRevert(ArcTradeOrders.InvalidParameters.selector);
        arc.queueSwapTarget(makeAddr("eoa"), true);
        vm.expectRevert(ArcTradeOrders.InvalidParameters.selector);
        arc.queueSwapTarget(address(arc), true);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arc.queueSwapTarget(address(dex), true);
    }

    function test_SwapTarget_TimelockedAllow() public {
        address t = address(new MockERC20("x", "x", 1));
        assertFalse(arc.swapTargets(t));
        vm.prank(owner);
        bytes32 id = arc.queueSwapTarget(t, true);
        assertFalse(arc.swapTargets(t));
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.ConfigNotReady.selector);
        arc.applyConfig(id);
        skip(DELAY);
        vm.expectEmit(true, false, false, true, address(arc));
        emit ArcTradeOrders.SwapTargetSet(t, true);
        vm.prank(owner);
        arc.applyConfig(id);
        assertTrue(arc.swapTargets(t));
    }

    function test_DisableSwapTarget_Instant() public {
        assertTrue(arc.swapTargets(address(dex)));
        vm.expectEmit(true, false, false, true, address(arc));
        emit ArcTradeOrders.SwapTargetSet(address(dex), false);
        vm.prank(owner);
        arc.disableSwapTarget(address(dex));
        assertFalse(arc.swapTargets(address(dex)));
    }

    function test_DisableSwapTarget_Guards() public {
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.ZeroAddress.selector);
        arc.disableSwapTarget(address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arc.disableSwapTarget(address(dex));
    }

    // -------------------------------------------------------------- keeper fee

    function test_SetKeeperFee_CanOnlyLower() public {
        vm.expectEmit(false, false, false, true, address(arc));
        emit ArcTradeOrders.KeeperFeeSet(5);
        vm.prank(owner);
        arc.setKeeperFeeBps(5);
        assertEq(arc.keeperFeeBps(), 5);

        vm.prank(owner);
        arc.setKeeperFeeBps(5); // equal is allowed
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.InvalidParameters.selector);
        arc.setKeeperFeeBps(6);
        vm.prank(owner);
        arc.setKeeperFeeBps(0);
        vm.prank(owner);
        vm.expectRevert(ArcTradeOrders.InvalidParameters.selector);
        arc.setKeeperFeeBps(1);
    }

    function test_SetKeeperFee_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arc.setKeeperFeeBps(1);
    }

    // ------------------------------------------------------------------ pause

    function test_PauseUnpause_OwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arc.pause();
        vm.prank(owner);
        arc.pause();
        assertTrue(arc.paused());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arc.unpause();
        vm.prank(owner);
        arc.unpause();
        assertFalse(arc.paused());
        vm.prank(owner);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        arc.unpause();
    }

    // ------------------------------------------------------------ price views

    function test_UsdPrice18_ScalesFeedDecimals() public {
        assertEq(arc.usdPrice18(address(wbtc)), 60_000e18);
        assertEq(arc.usdPrice18(address(usdc)), 1e18);

        MockERC20 t = new MockERC20("T", "T", 18);
        MockAggregator hi = new MockAggregator(20, 7e20); // 7.0 with 20 decimals
        MockAggregator lo = new MockAggregator(6, 2e6); // 2.0 with 6 decimals
        vm.startPrank(owner);
        bytes32 a = arc.queueTokenConfig(address(t), address(hi), STALE);
        bytes32 b = arc.queueTokenConfig(address(weth), address(lo), STALE);
        vm.stopPrank();
        skip(DELAY);
        hi.setUpdatedAt(block.timestamp);
        lo.setUpdatedAt(block.timestamp);
        vm.startPrank(owner);
        arc.applyConfig(a);
        arc.applyConfig(b);
        vm.stopPrank();
        assertEq(arc.usdPrice18(address(t)), 7e18);
        assertEq(arc.usdPrice18(address(weth)), 2e18);
    }

    function test_UsdPrice18_UnsupportedToken() public {
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.TokenNotSupported.selector, address(0xBEEF)));
        arc.usdPrice18(address(0xBEEF));
    }

    function test_CurrentPrice_QuotePerBaseAndOlderTimestamp() public {
        skip(100);
        btcFeed.setUpdatedAt(block.timestamp - 10);
        usdcFeed.setUpdatedAt(block.timestamp - 50);
        (uint256 price, uint256 ts) = arc.currentPrice(address(wbtc));
        assertEq(price, 60_000e18);
        assertEq(ts, block.timestamp - 50);
        // Quote at $1.25 -> BTC is worth fewer quote units.
        usdcFeed.set(1.25e8);
        (price,) = arc.currentPrice(address(wbtc));
        assertEq(price, 48_000e18);
    }
}
