// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ArcTradeOrders} from "../ArcTradeOrders.sol";
import {MaliciousSwapTarget} from "./ArcTradeMocks.sol";
import {ArcTradeOrdersTestBase} from "./ArcTradeOrders.Base.t.sol";

contract ArcTradeOrdersDcaTest is ArcTradeOrdersTestBase {
    uint256 internal constant PER_BUY = 1_000e6;
    uint32 internal constant DAY = 1 days;
    MaliciousSwapTarget internal evil;

    function setUp() public override {
        super.setUp();
        evil = new MaliciousSwapTarget();
        _allow(address(evil));
        wbtc.mint(address(evil), 1e15);
        usdc.mint(address(evil), 1e15);
    }

    function _dca(uint16 n, uint32 interval, uint40 first, uint256 maxPrice) internal returns (uint256 id) {
        vm.prank(alice);
        id = arc.createDca(address(wbtc), PER_BUY, n, interval, first, SLIP, maxPrice);
    }

    function _dca4() internal returns (uint256) {
        return _dca(4, DAY, 0, 0);
    }

    function _prepDca(uint256 id, uint256 gross) internal returns (bytes memory) {
        ArcTradeOrders.Dca memory d = arc.getDca(id);
        uint256 amountIn = Math.min(d.amountPerBuy, d.budgetRemaining);
        dex.setRate(gross, amountIn);
        return _swapData(address(usdc), d.base, amountIn);
    }

    function _marketBase() internal view returns (uint256) {
        (uint256 price,) = arc.currentPrice(address(wbtc));
        return arc.baseForQuote(address(wbtc), PER_BUY, price);
    }

    function _runDca(uint256 id) internal {
        bytes memory data = _prepDca(id, _marketBase());
        vm.prank(keeper);
        arc.executeDca(id, address(dex), data);
    }

    function _expectDcaRevert(uint256 id, address target, bytes memory data, bytes memory err) internal {
        vm.prank(keeper);
        vm.expectRevert(err);
        arc.executeDca(id, target, data);
    }

    // ----------------------------------------------------------------- create

    function test_CreateDca_EscrowsBudgetAndStoresPlan() public {
        ArcTradeOrders.Dca memory expected = ArcTradeOrders.Dca(
            alice, ArcTradeOrders.DcaStatus.ACTIVE, uint40(block.timestamp), DAY, address(wbtc), SLIP, 0,
            uint40(block.timestamp), PER_BUY, 4 * PER_BUY, 70_000e18, 0, 0
        );
        vm.expectEmit(true, true, false, true, address(arc));
        emit ArcTradeOrders.DcaCreated(1, alice, expected);
        uint256 before_ = usdc.balanceOf(alice);
        uint256 id = _dca(4, DAY, 0, 70_000e18);
        assertEq(id, 1);
        assertEq(arc.nextDcaId(), 2);
        assertEq(usdc.balanceOf(alice), before_ - 4 * PER_BUY);
        assertEq(usdc.balanceOf(address(arc)), 4 * PER_BUY);
        ArcTradeOrders.Dca memory d = arc.getDca(id);
        assertEq(d.owner, alice);
        assertEq(d.budgetRemaining, 4 * PER_BUY);
        assertEq(d.nextExecution, uint40(block.timestamp));
        assertEq(arc.getDcaIds(alice).length, 1);
    }

    function test_CreateDca_CustomFirstExecution() public {
        uint40 first = uint40(block.timestamp + 3 days);
        uint256 id = _dca(2, DAY, first, 0);
        assertEq(arc.getDca(id).nextExecution, first);
    }

    function test_CreateDca_BoundariesAccepted() public {
        vm.startPrank(alice);
        arc.createDca(address(wbtc), 1e6, 520, 3600, 0, 1000, uint256(type(uint128).max));
        vm.stopPrank();
    }

    function test_CreateDca_Reverts() public {
        vm.startPrank(alice);
        bytes4 ip = ArcTradeOrders.InvalidParameters.selector;
        vm.expectRevert(ip);
        arc.createDca(address(usdc), PER_BUY, 4, DAY, 0, SLIP, 0);
        vm.expectRevert(ip);
        arc.createDca(address(wbtc), 0, 4, DAY, 0, SLIP, 0);
        vm.expectRevert(ip);
        arc.createDca(address(wbtc), PER_BUY, 0, DAY, 0, SLIP, 0);
        vm.expectRevert(ip);
        arc.createDca(address(wbtc), PER_BUY, 521, DAY, 0, SLIP, 0);
        vm.expectRevert(ip);
        arc.createDca(address(wbtc), PER_BUY, 4, 3599, 0, SLIP, 0);
        vm.expectRevert(ip);
        arc.createDca(address(wbtc), PER_BUY, 4, DAY, 0, SLIP, uint256(type(uint128).max) + 1);
        vm.expectRevert(ip);
        arc.createDca(address(wbtc), PER_BUY, 4, DAY, 0, 0, 0);
        vm.expectRevert(ip);
        arc.createDca(address(wbtc), PER_BUY, 4, DAY, 0, 1001, 0);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.TokenNotSupported.selector, address(0xBEEF)));
        arc.createDca(address(0xBEEF), PER_BUY, 4, DAY, 0, SLIP, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- execute

    function test_ExecuteDca_PaysOwnerNetAndKeeperFeeInBase() public {
        uint256 id = _dca4();
        uint256 gross = _marketBase();
        assertEq(gross, 1_666_666);
        uint256 fee = _fee(gross);
        uint256 net = gross - fee;
        bytes memory data = _prepDca(id, gross);
        uint256 aBefore = wbtc.balanceOf(alice);
        uint256 kBefore = wbtc.balanceOf(keeper);
        vm.expectEmit(true, true, true, true, address(arc));
        emit ArcTradeOrders.DcaExecuted(id, alice, keeper, PER_BUY, net, fee, uint40(block.timestamp + DAY));
        vm.prank(keeper);
        arc.executeDca(id, address(dex), data);

        assertEq(wbtc.balanceOf(alice), aBefore + net);
        assertEq(wbtc.balanceOf(keeper), kBefore + fee);
        assertEq(wbtc.balanceOf(address(arc)), 0);
        assertEq(usdc.allowance(address(arc), address(dex)), 0);
        ArcTradeOrders.Dca memory d = arc.getDca(id);
        assertEq(d.budgetRemaining, 3 * PER_BUY);
        assertEq(d.totalSpent, PER_BUY);
        assertEq(d.totalBought, net);
        assertEq(d.executions, 1);
        assertEq(d.nextExecution, uint40(block.timestamp + DAY));
        assertEq(usdc.balanceOf(address(arc)), 3 * PER_BUY);
    }

    function test_ExecuteDca_NotDueThenDueAtExactTime() public {
        uint40 first = uint40(block.timestamp + 1 hours);
        uint256 id = _dca(2, DAY, first, 0);
        bytes memory data = _prepDca(id, _marketBase());
        _expectDcaRevert(id, address(dex), data, abi.encodePacked(ArcTradeOrders.DcaNotDue.selector));
        vm.warp(first - 1);
        _touch();
        _expectDcaRevert(id, address(dex), data, abi.encodePacked(ArcTradeOrders.DcaNotDue.selector));
        vm.warp(first);
        _touch();
        _runDca(id);
        assertEq(arc.getDca(id).executions, 1);
        assertEq(arc.getDca(id).nextExecution, first + DAY);
    }

    function test_ExecuteDca_ScheduleAdvancesByIntervalThenCompletes() public {
        uint256 id = _dca4();
        uint40 t0 = uint40(block.timestamp);
        for (uint256 i; i < 4; ++i) {
            if (i != 0) {
                bytes memory early = _prepDca(id, _marketBase());
                _expectDcaRevert(id, address(dex), early, abi.encodePacked(ArcTradeOrders.DcaNotDue.selector));
                skip(DAY);
                _touch();
            }
            if (i == 3) vm.recordLogs();
            _runDca(id);
            if (i == 3) {
                Vm.Log[] memory logs = vm.getRecordedLogs();
                Vm.Log memory last = logs[logs.length - 1];
                assertEq(last.emitter, address(arc));
                assertEq(last.topics[0], ArcTradeOrders.DcaCompleted.selector);
                assertEq(last.topics[1], bytes32(id));
                assertEq(logs[logs.length - 2].topics[0], ArcTradeOrders.DcaExecuted.selector);
            }
            assertEq(arc.getDca(id).executions, i + 1);
            assertEq(arc.getDca(id).nextExecution, t0 + uint40((i + 1) * DAY));
        }
        ArcTradeOrders.Dca memory d = arc.getDca(id);
        assertEq(uint8(d.status), uint8(ArcTradeOrders.DcaStatus.COMPLETED));
        assertEq(d.budgetRemaining, 0);
        assertEq(d.totalSpent, 4 * PER_BUY);
        assertEq(usdc.balanceOf(address(arc)), 0);
        assertEq(wbtc.balanceOf(address(arc)), 0);

        skip(DAY);
        _touch();
        bytes memory data = _swapData(address(usdc), address(wbtc), PER_BUY);
        _expectDcaRevert(id, address(dex), data, abi.encodePacked(ArcTradeOrders.DcaNotActive.selector));
    }

    function test_ExecuteDca_LateExecutionDoesNotBackfill() public {
        uint256 id = _dca4();
        skip(3 * DAY + 5 hours);
        _touch();
        _runDca(id);
        assertEq(arc.getDca(id).nextExecution, uint40(block.timestamp + DAY));
        // only one buy per call; next one not due immediately
        bytes memory data = _prepDca(id, _marketBase());
        _expectDcaRevert(id, address(dex), data, abi.encodePacked(ArcTradeOrders.DcaNotDue.selector));
    }

    function test_ExecuteDca_Eth18Decimals() public {
        vm.prank(alice);
        uint256 id = arc.createDca(address(weth), 3_000e6, 2, DAY, 0, SLIP, 0);
        dex.setRate(1e18, 3_000e6);
        bytes memory data = _swapData(address(usdc), address(weth), 3_000e6);
        uint256 before_ = weth.balanceOf(alice);
        vm.prank(keeper);
        arc.executeDca(id, address(dex), data);
        assertEq(weth.balanceOf(alice) - before_, 1e18 - _fee(1e18));
    }

    function test_ExecuteDca_PriceCap() public {
        uint256 id = _dca(4, DAY, 0, 58_000e18);
        bytes memory data = _prepDca(id, _marketBase());
        _expectDcaRevert(
            id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.PriceAboveCap.selector, 60_000e18, 58_000e18)
        );
        _setBtc(58_000); // at the cap is allowed
        _runDca(id);
        assertEq(arc.getDca(id).executions, 1);
    }

    function test_ExecuteDca_ZeroCapMeansNoCap() public {
        uint256 id = _dca4();
        _setBtc(500_000);
        _runDca(id);
        assertEq(arc.getDca(id).executions, 1);
    }

    function test_ExecuteDca_MinOutSlippageFloor() public {
        uint256 id = _dca4();
        (uint256 price, uint256 minOut) = arc.previewDca(id);
        assertEq(price, 60_000e18);
        assertEq(minOut, Math.mulDiv(_marketBase(), 9_900, 10_000));
        // gross so low the net is below the floor
        uint256 gross = minOut - 1;
        uint256 net = gross - _fee(gross);
        bytes memory data = _prepDca(id, gross);
        _expectDcaRevert(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.InsufficientOutput.selector, net, minOut));
    }

    function test_ExecuteDca_RevertsStaleOracleAndUnallowedTarget() public {
        uint256 id = _dca4();
        bytes memory data = _prepDca(id, _marketBase());
        address rogue = makeAddr("rogue");
        _expectDcaRevert(id, rogue, data, abi.encodeWithSelector(ArcTradeOrders.SwapTargetNotAllowed.selector, rogue));
        skip(STALE + 1);
        _expectDcaRevert(id, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.StalePrice.selector, address(wbtc)));
    }

    function test_ExecuteDca_PartialFillReverts() public {
        uint256 id = _dca4();
        evil.configure(MaliciousSwapTarget.Mode.SPEND_HALF, 2e6);
        bytes memory data = _swapData(address(usdc), address(wbtc), PER_BUY);
        _expectDcaRevert(
            id, address(evil), data, abi.encodeWithSelector(ArcTradeOrders.PartialFill.selector, PER_BUY / 2, PER_BUY)
        );
        assertEq(arc.getDca(id).budgetRemaining, 4 * PER_BUY);
    }

    function test_ExecuteDca_InvalidId() public {
        bytes memory data = _swapData(address(usdc), address(wbtc), PER_BUY);
        _expectDcaRevert(7, address(dex), data, abi.encodeWithSelector(ArcTradeOrders.InvalidDca.selector, 7));
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.InvalidDca.selector, 7));
        arc.getDca(7);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.InvalidDca.selector, 7));
        arc.previewDca(7);
    }

    // ------------------------------------------------------ pause/resume/cancel

    function test_PauseDca_BlocksExecuteAndResumeRestores() public {
        uint256 id = _dca4();
        vm.expectEmit(true, false, false, false, address(arc));
        emit ArcTradeOrders.DcaPaused(id);
        vm.prank(alice);
        arc.pauseDca(id);
        assertEq(uint8(arc.getDca(id).status), uint8(ArcTradeOrders.DcaStatus.PAUSED));
        bytes memory data = _prepDca(id, _marketBase());
        _expectDcaRevert(id, address(dex), data, abi.encodePacked(ArcTradeOrders.DcaNotActive.selector));

        skip(2 * DAY);
        _touch();
        uint40 nowTs = uint40(block.timestamp);
        vm.expectEmit(true, false, false, true, address(arc));
        emit ArcTradeOrders.DcaResumed(id, nowTs); // past schedule is not replayed
        vm.prank(alice);
        arc.resumeDca(id);
        assertEq(arc.getDca(id).nextExecution, nowTs);
        _runDca(id);
        assertEq(arc.getDca(id).executions, 1);
    }

    function test_ResumeDca_KeepsFutureSchedule() public {
        uint40 first = uint40(block.timestamp + 5 days);
        uint256 id = _dca(2, DAY, first, 0);
        vm.startPrank(alice);
        arc.pauseDca(id);
        arc.resumeDca(id);
        vm.stopPrank();
        assertEq(arc.getDca(id).nextExecution, first);
    }

    function test_PauseResumeDca_Guards() public {
        uint256 id = _dca4();
        vm.prank(bob);
        vm.expectRevert(ArcTradeOrders.NotDcaOwner.selector);
        arc.pauseDca(id);
        vm.prank(bob);
        vm.expectRevert(ArcTradeOrders.NotDcaOwner.selector);
        arc.resumeDca(id);
        vm.prank(alice);
        vm.expectRevert(ArcTradeOrders.DcaNotPaused.selector);
        arc.resumeDca(id);
        vm.startPrank(alice);
        arc.pauseDca(id);
        vm.expectRevert(ArcTradeOrders.DcaNotActive.selector);
        arc.pauseDca(id);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.InvalidDca.selector, 55));
        arc.pauseDca(55);
        vm.stopPrank();
    }

    function test_CancelDca_RefundsRemainingBudget() public {
        uint256 id = _dca4();
        _runDca(id);
        uint256 before_ = usdc.balanceOf(alice);
        vm.expectEmit(true, true, false, true, address(arc));
        emit ArcTradeOrders.DcaCancelled(id, alice, 3 * PER_BUY);
        vm.prank(alice);
        arc.cancelDca(id);
        assertEq(usdc.balanceOf(alice), before_ + 3 * PER_BUY);
        assertEq(usdc.balanceOf(address(arc)), 0);
        ArcTradeOrders.Dca memory d = arc.getDca(id);
        assertEq(uint8(d.status), uint8(ArcTradeOrders.DcaStatus.CANCELLED));
        assertEq(d.budgetRemaining, 0);
        vm.prank(alice);
        vm.expectRevert(ArcTradeOrders.DcaNotCancellable.selector);
        arc.cancelDca(id);
    }

    function test_CancelDca_WhenPlanPausedAndGuards() public {
        uint256 id = _dca4();
        vm.prank(bob);
        vm.expectRevert(ArcTradeOrders.NotDcaOwner.selector);
        arc.cancelDca(id);
        vm.startPrank(alice);
        arc.pauseDca(id);
        arc.cancelDca(id);
        vm.expectRevert(abi.encodeWithSelector(ArcTradeOrders.InvalidDca.selector, 12));
        arc.cancelDca(12);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(arc)), 0);
    }

    function test_CancelDca_CompletedNotCancellable() public {
        uint256 id = _dca(1, DAY, 0, 0);
        _runDca(id);
        assertEq(uint8(arc.getDca(id).status), uint8(ArcTradeOrders.DcaStatus.COMPLETED));
        vm.prank(alice);
        vm.expectRevert(ArcTradeOrders.DcaNotCancellable.selector);
        arc.cancelDca(id);
    }

    // ------------------------------------------------------------ global pause

    function test_GlobalPause_BlocksCreateAndExecuteButNotCancelOrPlanControls() public {
        uint256 id = _dca4();
        bytes memory data = _prepDca(id, _marketBase());
        vm.prank(owner);
        arc.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arc.createDca(address(wbtc), PER_BUY, 4, DAY, 0, SLIP, 0);
        _expectDcaRevert(id, address(dex), data, abi.encodePacked(Pausable.EnforcedPause.selector));

        vm.startPrank(alice);
        arc.pauseDca(id);
        arc.resumeDca(id);
        uint256 before_ = usdc.balanceOf(alice);
        arc.cancelDca(id);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), before_ + 4 * PER_BUY);
    }

    // -------------------------------------------------------------- checkDca

    function test_CheckDca_ReasonCodes() public {
        (bool ok, uint8 code,,) = arc.checkDca(99);
        assertFalse(ok);
        assertEq(code, 1); // unknown

        uint256 id = _dca(4, DAY, uint40(block.timestamp + 1 hours), 58_000e18);
        (ok, code,,) = arc.checkDca(id);
        assertEq(code, 2); // not due

        skip(1 hours);
        _touch();
        uint256 price;
        uint256 minOut;
        (ok, code, price, minOut) = arc.checkDca(id);
        assertFalse(ok);
        assertEq(code, 3); // above cap
        assertEq(price, 60_000e18);
        assertGt(minOut, 0);

        _setBtc(57_000);
        (ok, code, price, minOut) = arc.checkDca(id);
        assertTrue(ok);
        assertEq(code, 0);
        assertEq(price, 57_000e18);
        assertEq(minOut, Math.mulDiv(arc.baseForQuote(address(wbtc), PER_BUY, 57_000e18), 9_900, 10_000));

        btcFeed.setBroken(true);
        (ok, code,,) = arc.checkDca(id);
        assertEq(code, 4);
        btcFeed.setBroken(false);
        skip(STALE + 1);
        (ok, code,,) = arc.checkDca(id);
        assertEq(code, 4); // stale

        _touch();
        vm.prank(owner);
        arc.pause();
        (ok, code,,) = arc.checkDca(id);
        assertEq(code, 5);
        vm.prank(owner);
        arc.unpause();

        vm.prank(alice);
        arc.pauseDca(id);
        (ok, code,,) = arc.checkDca(id);
        assertEq(code, 1); // paused plan is "not active"

        vm.prank(alice);
        arc.cancelDca(id);
        (ok, code,,) = arc.checkDca(id);
        assertEq(code, 1);
    }

    function test_CheckDca_CompletedIsNotActive() public {
        uint256 id = _dca(1, DAY, 0, 0);
        _runDca(id);
        (bool ok, uint8 code,,) = arc.checkDca(id);
        assertFalse(ok);
        assertEq(code, 1);
    }
}
