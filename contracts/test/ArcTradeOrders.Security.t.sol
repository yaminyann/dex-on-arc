// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {MaliciousSwapTarget, ReentrantERC20} from "./ArcTradeMocks.sol";
import {ArcTradeOrdersTestBase} from "./ArcTradeOrders.Base.t.sol";

/// @dev Pause semantics and reentrancy via malicious token / swap target.
contract ArcTradeOrdersSecurityTest is ArcTradeOrdersTestBase {
    ReentrantERC20 internal rbase; // 18-dec base priced by the ETH feed ($3000)
    MaliciousSwapTarget internal evil;
    bytes4 internal constant REENTRANT = bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    function setUp() public override {
        super.setUp();
        rbase = new ReentrantERC20("R", "R", 18);
        evil = new MaliciousSwapTarget();
        bytes32 id = _queueToken(address(rbase), address(ethFeed));
        skip(DELAY);
        vm.prank(owner);
        arc.applyConfig(id);
        _allow(address(evil)); // also refreshes feeds
        address[3] memory who = [alice, address(dex), address(evil)];
        for (uint256 i; i < 3; ++i) {
            rbase.mint(who[i], 1e30);
        }
        wbtc.mint(address(evil), 1e15);
        usdc.mint(address(evil), 1e15);
        vm.prank(alice);
        rbase.approve(address(arc), type(uint256).max);
    }

    // ------------------------------------------------------------------ pause

    function test_Pause_BlocksCreateAndExecuteButNotExitPaths() public {
        uint256 toCancel = _limitSellBtc(65_000);
        ArcTradeOrders.CreateParams memory shortP = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 66_000e18, 0, 0);
        shortP.expiry = uint40(block.timestamp + 1 days);
        uint256 toExpire = _create(alice, shortP);
        uint256 trail = _create(alice, _p(address(wbtc), S_SELL, T_TRAIL, BTC_AMT, 0, 0, 500));
        uint256 triggered = _limitSellBtc(61_000);
        _setBtc(62_000);
        bytes memory data = _prep(triggered, 62_000e6);
        vm.prank(alice);
        uint256 dcaId = arc.createDca(address(wbtc), 1_000e6, 3, 1 days, 0, SLIP, 0);

        vm.prank(owner);
        arc.pause();

        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 65_000e18, 0, 0);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arc.createOrder(p);
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arc.execute(triggered, address(dex), data);

        // exits still work
        vm.prank(alice);
        arc.cancelOrder(toCancel);
        arc.pokeTrailing(trail);
        vm.prank(alice);
        arc.cancelDca(dcaId);
        skip(1 days);
        arc.expireOrder(toExpire);

        // unpause restores execution
        vm.prank(owner);
        arc.unpause();
        _touch();
        _execMarket(triggered);
        assertEq(uint8(arc.getOrder(triggered).status), uint8(ArcTradeOrders.Status.EXECUTED));
    }

    // ------------------------------------------------- reentrancy via token

    function _rbaseOrder(ArcTradeOrders.Side side, uint256 amountIn, uint256 trigger) internal view returns (ArcTradeOrders.CreateParams memory) {
        return _p(address(rbase), side, T_LIMIT, amountIn, trigger, 0, 0);
    }

    function _assertBlocked(bool ran, bool ok, bytes memory ret) internal {
        assertTrue(ran, "hook did not run");
        assertFalse(ok, "reentrant call succeeded");
        assertEq(bytes4(ret), REENTRANT);
    }

    function test_Reenter_TokenHookInCreateOrder() public {
        ArcTradeOrders.CreateParams memory p = _rbaseOrder(S_SELL, 10e18, 3_500e18);
        rbase.arm(address(arc), abi.encodeCall(arc.createOrder, (p)));
        uint256 id = _create(alice, p);
        _assertBlocked(rbase.hookRan(), rbase.reenterOk(), rbase.reenterRet());
        assertEq(id, 1);
        assertEq(arc.nextOrderId(), 2);
        assertEq(rbase.balanceOf(address(arc)), 10e18);
    }

    function test_Reenter_TokenHookInCancelRefund() public {
        uint256 id = _create(alice, _rbaseOrder(S_SELL, 10e18, 3_500e18));
        rbase.arm(address(arc), abi.encodeCall(arc.cancelOrder, (id)));
        uint256 before_ = rbase.balanceOf(alice);
        vm.prank(alice);
        arc.cancelOrder(id);
        _assertBlocked(rbase.hookRan(), rbase.reenterOk(), rbase.reenterRet());
        assertEq(rbase.balanceOf(alice), before_ + 10e18);
        assertEq(rbase.balanceOf(address(arc)), 0);
    }

    function test_Reenter_TokenHookInExecute() public {
        // BUY rbase with 30k USDC at $3000; output token (rbase) re-enters during the swap payout.
        uint256 id = _create(alice, _rbaseOrder(S_BUY, 30_000e6, 3_500e18));
        bytes memory data = _prep(id, 10e18);
        rbase.arm(address(arc), abi.encodeCall(arc.execute, (id, address(dex), data)));
        uint256 before_ = rbase.balanceOf(alice);
        vm.prank(keeper);
        arc.execute(id, address(dex), data);
        _assertBlocked(rbase.hookRan(), rbase.reenterOk(), rbase.reenterRet());
        assertEq(rbase.balanceOf(alice) - before_, 10e18 - _fee(10e18));
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXECUTED));
        assertEq(rbase.balanceOf(address(arc)), 0);
    }

    function test_Reenter_TokenHookInExecuteDca() public {
        // DCA escrow is the quote token; use rbase as DCA base purchase output instead.
        vm.prank(alice);
        uint256 id = arc.createDca(address(rbase), 3_000e6, 2, 1 days, 0, SLIP, 0);
        dex.setRate(1e18, 3_000e6);
        bytes memory data = _swapData(address(usdc), address(rbase), 3_000e6);
        rbase.arm(address(arc), abi.encodeCall(arc.cancelDca, (id)));
        vm.prank(keeper);
        arc.executeDca(id, address(dex), data);
        _assertBlocked(rbase.hookRan(), rbase.reenterOk(), rbase.reenterRet());
        assertEq(arc.getDca(id).executions, 1);
        assertEq(uint8(arc.getDca(id).status), uint8(ArcTradeOrders.DcaStatus.ACTIVE));
    }

    // -------------------------------------------- reentrancy via swap target

    /// @dev Executes a triggered BTC sell through `evil`, which attempts `payload` mid-swap.
    function _runWithReentry(uint256 id, bytes memory payload) internal {
        evil.configure(MaliciousSwapTarget.Mode.NORMAL, 66_000e6);
        evil.setReenter(address(arc), payload);
        bytes memory data = _swapData(address(wbtc), address(usdc), BTC_AMT);
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(keeper);
        arc.execute(id, address(evil), data);
        assertTrue(evil.reenterRan());
        assertFalse(evil.reenterOk(), "reentrant call succeeded");
        assertEq(bytes4(evil.reenterRet()), REENTRANT);
        assertEq(usdc.balanceOf(alice) - aliceBefore, 66_000e6 - _fee(66_000e6));
        assertEq(uint8(arc.getOrder(id).status), uint8(ArcTradeOrders.Status.EXECUTED));
    }

    function test_Reenter_TargetCancelsOwnOrder() public {
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        _runWithReentry(id, abi.encodeCall(arc.cancelOrder, (id)));
    }

    function test_Reenter_TargetExecutesSameOrderAgain() public {
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        bytes memory data = _swapData(address(wbtc), address(usdc), BTC_AMT);
        _runWithReentry(id, abi.encodeCall(arc.execute, (id, address(evil), data)));
    }

    function test_Reenter_TargetExecutesSecondOrder() public {
        uint256 id = _limitSellBtc(65_000);
        uint256 id2 = _limitSellBtc(65_000);
        _setBtc(66_000);
        bytes memory data = _swapData(address(wbtc), address(usdc), BTC_AMT);
        _runWithReentry(id, abi.encodeCall(arc.execute, (id2, address(evil), data)));
        assertEq(uint8(arc.getOrder(id2).status), uint8(ArcTradeOrders.Status.OPEN));
        assertEq(wbtc.balanceOf(address(arc)), BTC_AMT); // only order 2's escrow remains
    }

    function test_Reenter_TargetCreatesOrder() public {
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        ArcTradeOrders.CreateParams memory p = _p(address(wbtc), S_SELL, T_LIMIT, BTC_AMT, 70_000e18, 0, 0);
        _runWithReentry(id, abi.encodeCall(arc.createOrder, (p)));
        assertEq(arc.nextOrderId(), 2);
    }

    function test_Reenter_TargetExpiresOrder() public {
        uint256 id = _limitSellBtc(65_000);
        _setBtc(66_000);
        _runWithReentry(id, abi.encodeCall(arc.expireOrder, (id)));
    }

    function test_Reenter_TargetDuringDcaExecution() public {
        vm.prank(alice);
        uint256 id = arc.createDca(address(wbtc), 1_000e6, 3, 1 days, 0, SLIP, 0);
        evil.configure(MaliciousSwapTarget.Mode.NORMAL, 1_666_666);
        evil.setReenter(address(arc), abi.encodeCall(arc.cancelDca, (id)));
        bytes memory data = _swapData(address(usdc), address(wbtc), 1_000e6);
        vm.prank(keeper);
        arc.executeDca(id, address(evil), data);
        assertTrue(evil.reenterRan());
        assertFalse(evil.reenterOk());
        assertEq(bytes4(evil.reenterRet()), REENTRANT);
        ArcTradeOrders.Dca memory d = arc.getDca(id);
        assertEq(d.executions, 1);
        assertEq(uint8(d.status), uint8(ArcTradeOrders.DcaStatus.ACTIVE));
        assertEq(usdc.balanceOf(address(arc)), 2_000e6);
    }
}
