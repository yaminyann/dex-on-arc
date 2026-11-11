// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Minimal Chainlink-compatible feed surface.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    );
}

/// @dev Namespacing permits the OrderExpired error and lifecycle event to share a name.
interface IArcTradeErrors {
    error OrderExpired(uint256 id);
}

/// @title ArcTradeOrders
/// @notice Escrow-backed conditional orders and recurring quote-token purchases.
/// @dev Quote, base tokens, feeds, and swap targets must be trusted, standard ERC-20/feed contracts.
///      Arbitrary keeper calldata is constrained by exact input spend and net output balance checks.
///      There is no native-token handling, standing allowance, rescue, or owner withdrawal.
///      Users can always cancel orders or cancel DCA plans and withdraw escrow during the config delay window.
///      Production deployments should use a configuration delay of 48 hours or more.
contract ArcTradeOrders is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant MAX_USER_PRICE = type(uint128).max;

    enum Side { BUY, SELL }
    enum OrderType { LIMIT, STOP_LOSS, TAKE_PROFIT, STOP_LIMIT, TRAILING_STOP, OCO }
    enum Status { OPEN, EXECUTED, CANCELLED, EXPIRED }
    enum DcaStatus { ACTIVE, PAUSED, CANCELLED, COMPLETED }

    struct TokenConfig {
        address feed;
        uint8 feedDecimals;
        uint8 tokenDecimals;
        uint32 maxStaleness;
    }

    struct PendingConfig {
        address subject;
        address feed;
        uint32 maxStaleness;
        bool isToken;
        bool allowed;
        uint256 eta;
    }

    struct CreateParams {
        address base;
        Side side;
        OrderType orderType;
        uint256 amountIn;
        uint256 triggerPrice;
        uint256 limitPrice;
        uint16 trailBps;
        uint16 maxSlippageBps;
        uint40 expiry;
    }

    struct Order {
        address owner;
        Side side;
        OrderType orderType;
        Status status;
        uint40 expiry;
        bool stopActivated;
        address base;
        uint16 trailBps;
        uint16 maxSlippageBps;
        uint40 createdAt;
        uint40 executedAt;
        uint256 amountIn;
        uint256 triggerPrice;
        uint256 limitPrice;
        uint256 peakPrice;
        uint256 amountOut;
        uint256 executionPrice;
    }

    struct Dca {
        address owner;
        DcaStatus status;
        uint40 nextExecution;
        uint32 interval;
        address base;
        uint16 maxSlippageBps;
        uint16 executions;
        uint40 createdAt;
        uint256 amountPerBuy;
        uint256 budgetRemaining;
        uint256 maxPrice;
        uint256 totalSpent;
        uint256 totalBought;
    }

    address public immutable quote;
    uint32 public immutable configDelay;
    uint256 private _configNonce;
    mapping(bytes32 => PendingConfig) private _pendingConfigs;
    /// @notice Keeper fee on swap output in basis points. Starts at 0.10% and can only ever be lowered.
    uint16 public keeperFeeBps = 10;
    uint256 public nextOrderId = 1;
    uint256 public nextDcaId = 1;
    mapping(address => TokenConfig) public tokenConfigs;
    mapping(address => bool) public swapTargets;
    mapping(uint256 => Order) private _orders;
    mapping(address => uint256[]) private _orderIds;
    mapping(uint256 => Dca) private _dcas;
    mapping(address => uint256[]) private _dcaIds;

    error ZeroAddress();
    error InvalidParameters();
    error UnsupportedDecimals();
    error TokenNotSupported(address token);
    error StalePrice(address token);
    error InvalidPrice(address token);
    error InvalidOrder(uint256 id);
    error OrderNotOpen(uint256 id);
    error NotOrderOwner();
    error NotTriggered();
    error NotExpired();
    error SwapTargetNotAllowed(address target);
    error SwapFailed();
    error PartialFill(uint256 spent, uint256 required);
    error InvalidBalanceDelta();
    error TransferAmountMismatch();
    error InsufficientOutput(uint256 net, uint256 minOut);
    error InvalidDca(uint256 id);
    error DcaNotActive();
    error DcaNotPaused();
    error DcaNotCancellable();
    error NotDcaOwner();
    error DcaNotDue();
    error PriceAboveCap(uint256 price, uint256 cap);
    error TimestampOverflow();
    error InvalidDelay();
    error ConfigNotReady();
    error ConfigUnknown();

    event TokenConfigured(address indexed token, address indexed feed, uint8 feedDecimals, uint8 tokenDecimals, uint32 maxStaleness);
    event SwapTargetSet(address indexed target, bool allowed);
    event ConfigQueued(bytes32 indexed changeId, uint256 eta);
    event ConfigCancelled(bytes32 indexed changeId);
    event StopActivated(uint256 indexed id, uint256 price);
    event KeeperFeeSet(uint16 feeBps);
    event OrderCreated(uint256 indexed id, address indexed owner, address indexed base, CreateParams params, uint256 peakPrice, uint40 createdAt);
    event OrderExecuted(uint256 indexed id, address indexed owner, address indexed keeper, uint256 amountIn, uint256 net, uint256 keeperFee, uint256 executionPrice);
    event OrderCancelled(uint256 indexed id, address indexed owner, uint256 refund);
    event OrderExpired(uint256 indexed id, address indexed owner, uint256 refund);
    event TrailingPeakUpdated(uint256 indexed id, uint256 peakPrice);
    event DcaCreated(uint256 indexed id, address indexed owner, Dca plan);
    event DcaPaused(uint256 indexed id);
    event DcaResumed(uint256 indexed id, uint40 nextExecution);
    event DcaCancelled(uint256 indexed id, address indexed owner, uint256 refund);
    event DcaExecuted(uint256 indexed id, address indexed owner, address indexed keeper, uint256 amountIn, uint256 net, uint256 keeperFee, uint40 nextExecution);
    event DcaCompleted(uint256 indexed id);

    /// @notice Sets the administrator and the ERC-20 quote token; neither is hardcoded.
    constructor(address owner_, address quote_, uint32 configDelay_) Ownable(owner_) {
        if (quote_ == address(0)) revert ZeroAddress();
        if (configDelay_ < 1 hours || configDelay_ > 14 days) revert InvalidDelay();
        quote = quote_;
        configDelay = configDelay_;
    }

    /// @notice Queues a token feed change; decimal metadata is read only when applied.
    function queueTokenConfig(address token, address feed, uint32 maxStaleness) external onlyOwner nonReentrant returns (bytes32 changeId) {
        if (token == address(0)) revert ZeroAddress();
        if (maxStaleness < 60 || maxStaleness > 172800) revert InvalidParameters();
        changeId = _queueConfig(PendingConfig(token, feed, maxStaleness, true, false, block.timestamp + configDelay));
    }

    /// @notice Queues a swap target change; target validity is checked again when applied.
    function queueSwapTarget(address target, bool allowed) external onlyOwner nonReentrant returns (bytes32 changeId) {
        if (target == address(0)) revert ZeroAddress();
        if (allowed && (target == address(this) || target.code.length == 0)) revert InvalidParameters();
        changeId = _queueConfig(PendingConfig(target, address(0), 0, false, allowed, block.timestamp + configDelay));
    }

    /// @notice Applies a queued change only after its full configuration delay.
    function applyConfig(bytes32 changeId) external onlyOwner nonReentrant {
        PendingConfig memory pending = _pendingConfigs[changeId];
        if (pending.eta == 0) revert ConfigUnknown();
        if (block.timestamp < pending.eta) revert ConfigNotReady();
        delete _pendingConfigs[changeId];
        if (pending.isToken) _setToken(pending.subject, pending.feed, pending.maxStaleness);
        else _setSwapTarget(pending.subject, pending.allowed);
    }

    /// @notice Cancels a pending configuration change without applying it.
    function cancelConfig(bytes32 changeId) external onlyOwner nonReentrant {
        if (_pendingConfigs[changeId].eta == 0) revert ConfigUnknown();
        delete _pendingConfigs[changeId];
        emit ConfigCancelled(changeId);
    }

    /// @notice Returns the earliest apply timestamp, or zero for an unknown or consumed change.
    function pendingConfigEta(bytes32 changeId) external view returns (uint256) {
        return _pendingConfigs[changeId].eta;
    }

    /// @notice Immediately disables a token without blocking refunds or altering decimal metadata.
    function disableToken(address token) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        TokenConfig storage config = tokenConfigs[token];
        config.feed = address(0);
        emit TokenConfigured(token, address(0), config.feedDecimals, config.tokenDecimals, config.maxStaleness);
    }

    /// @notice Immediately revokes a swap target's permission.
    function disableSwapTarget(address target) external onlyOwner nonReentrant {
        _setSwapTarget(target, false);
    }

    function _queueConfig(PendingConfig memory pending) private returns (bytes32 changeId) {
        changeId = keccak256(abi.encode(address(this), ++_configNonce, pending));
        _pendingConfigs[changeId] = pending;
        emit ConfigQueued(changeId, pending.eta);
    }

    /// @notice Registers a feed, or disables new usage with a zero feed without blocking refunds.
    /// @dev Decimal bounds keep powers of ten representable; existing metadata is kept on disable.
    function _setToken(address token, address feed, uint32 maxStaleness) private {
        if (token == address(0)) revert ZeroAddress();
        if (maxStaleness < 60 || maxStaleness > 172800) revert InvalidParameters();
        if (feed == address(0)) {
            TokenConfig storage config = tokenConfigs[token];
            config.feed = address(0);
            config.maxStaleness = maxStaleness;
            emit TokenConfigured(token, feed, config.feedDecimals, config.tokenDecimals, maxStaleness);
            return;
        }
        uint8 td = IERC20Metadata(token).decimals();
        uint8 fd = AggregatorV3Interface(feed).decimals();
        if (td > 59 || fd > 77) revert UnsupportedDecimals();
        tokenConfigs[token] = TokenConfig(feed, fd, td, maxStaleness);
        emit TokenConfigured(token, feed, fd, td, maxStaleness);
    }

    /// @notice Allows or revokes an external swap contract. Targets receive only exact input approval.
    function _setSwapTarget(address target, bool allowed) private {
        if (target == address(0)) revert ZeroAddress();
        if (allowed && (target == address(this) || target.code.length == 0)) revert InvalidParameters();
        swapTargets[target] = allowed;
        emit SwapTargetSet(target, allowed);
    }

    /// @notice Lowers the output-denominated keeper fee. The fee can never be raised, so no timelock is needed.
    function setKeeperFeeBps(uint16 feeBps) external onlyOwner nonReentrant {
        if (feeBps > keeperFeeBps) revert InvalidParameters();
        keeperFeeBps = feeBps;
        emit KeeperFeeSet(feeBps);
    }

    /// @notice Stops new escrow and executions; refunds and plan management remain available.
    function pause() external onlyOwner nonReentrant { _pause(); }

    /// @notice Restores new escrow and executions.
    function unpause() external onlyOwner nonReentrant { _unpause(); }

    /// @notice Returns the token's validated USD price scaled to 18 decimals.
    function usdPrice18(address token) external view returns (uint256) {
        (uint256 price,) = _usdPrice18(token);
        return price;
    }

    /// @notice Returns quote-per-whole-base scaled to 1e18 and the older feed timestamp.
    function currentPrice(address base) public view returns (uint256 price18, uint256 updatedAt) {
        (uint256 baseUsd, uint256 baseTime) = _usdPrice18(base);
        (uint256 quoteUsd, uint256 quoteTime) = _usdPrice18(quote);
        price18 = Math.mulDiv(baseUsd, WAD, quoteUsd);
        if (price18 == 0) revert InvalidPrice(base);
        updatedAt = Math.min(baseTime, quoteTime);
    }

    /// @notice Converts base smallest units to quote smallest units, rounding down.
    function quoteForBase(address base, uint256 baseAmount, uint256 price18) public view returns (uint256) {
        uint8 bd = tokenConfigs[base].tokenDecimals;
        uint8 qd = tokenConfigs[quote].tokenDecimals;
        if (qd <= bd) return Math.mulDiv(baseAmount, price18, WAD * _pow10(bd - qd));
        // Decomposition retains the fractional part without an overflowing price * scale product.
        uint256 scale = _pow10(qd - bd);
        uint256 whole = Math.mulDiv(baseAmount, price18, WAD);
        return Math.mulDiv(whole, scale, 1) + Math.mulDiv(mulmod(baseAmount, price18, WAD), scale, WAD);
    }

    /// @notice Converts quote smallest units to base smallest units, rounding down.
    function baseForQuote(address base, uint256 quoteAmount, uint256 price18) public view returns (uint256) {
        if (price18 == 0) revert InvalidPrice(base);
        uint8 bd = tokenConfigs[base].tokenDecimals;
        uint8 qd = tokenConfigs[quote].tokenDecimals;
        if (bd >= qd) return Math.mulDiv(quoteAmount, WAD * _pow10(bd - qd), price18);
        return Math.mulDiv(Math.mulDiv(quoteAmount, WAD, price18), 1, _pow10(qd - bd));
    }

    /// @notice Escrows a new order after validating its pair, trigger, and slippage settings.
    function createOrder(CreateParams calldata p) external nonReentrant whenNotPaused returns (uint256 id) {
        if (p.base == quote || p.amountIn == 0 || p.expiry <= block.timestamp) revert InvalidParameters();
        _validateSlippage(p.maxSlippageBps);
        if (p.orderType != OrderType.LIMIT && p.side != Side.SELL) revert InvalidParameters();
        (uint256 price,) = currentPrice(p.base);
        _validateOrderPrices(p, price);
        id = nextOrderId++;
        Order storage o = _orders[id];
        o.owner = msg.sender;
        o.base = p.base;
        o.side = p.side;
        o.orderType = p.orderType;
        o.status = Status.OPEN;
        o.amountIn = p.amountIn;
        o.triggerPrice = p.triggerPrice;
        o.limitPrice = p.limitPrice;
        o.peakPrice = p.orderType == OrderType.TRAILING_STOP ? price : 0;
        o.trailBps = p.trailBps;
        o.maxSlippageBps = p.maxSlippageBps;
        o.expiry = p.expiry;
        o.createdAt = _time(block.timestamp);
        _orderIds[msg.sender].push(id);
        _pull(p.side == Side.BUY ? quote : p.base, p.amountIn);
        emit OrderCreated(id, msg.sender, p.base, p, o.peakPrice, o.createdAt);
    }

    /// @notice Executes an open triggered order using keeper-provided calldata and net output checks.
    function execute(uint256 id, address target, bytes calldata data) external nonReentrant whenNotPaused {
        Order storage o = _openOrder(id);
        if (block.timestamp >= o.expiry) revert IArcTradeErrors.OrderExpired(id);
        (uint256 price,) = currentPrice(o.base);
        _raisePeak(id, o, price);
        if (!_triggered(o, price)) revert NotTriggered();
        if (o.orderType == OrderType.STOP_LIMIT && !o.stopActivated) {
            o.stopActivated = true;
            emit StopActivated(id, price);
        }
        uint256 minOut = _orderMinOut(o, price);
        address tokenIn = o.side == Side.BUY ? quote : o.base;
        address tokenOut = o.side == Side.BUY ? o.base : quote;
        (uint256 net, uint256 fee) = _swap(tokenIn, tokenOut, o.amountIn, minOut, target, data);
        o.status = Status.EXECUTED;
        o.executedAt = _time(block.timestamp);
        o.amountOut = net;
        // Realized price uses the owner's net proceeds (or net purchased base), not gross output.
        o.executionPrice = o.side == Side.BUY
            ? _realizedPrice(o.base, net, o.amountIn)
            : _realizedPrice(o.base, o.amountIn, net);
        IERC20(tokenOut).safeTransfer(o.owner, net);
        if (fee != 0) IERC20(tokenOut).safeTransfer(msg.sender, fee);
        emit OrderExecuted(id, o.owner, msg.sender, o.amountIn, net, fee, o.executionPrice);
    }

    /// @notice Permanently activates an open stop-limit order when its stop condition is met.
    function activateStop(uint256 id) external nonReentrant whenNotPaused {
        Order storage o = _openOrder(id);
        if (block.timestamp >= o.expiry) revert IArcTradeErrors.OrderExpired(id);
        if (o.orderType != OrderType.STOP_LIMIT || o.stopActivated) revert InvalidParameters();
        (uint256 price,) = currentPrice(o.base);
        if (price > o.triggerPrice) revert NotTriggered();
        o.stopActivated = true;
        emit StopActivated(id, price);
    }

    /// @notice Persists a higher trailing peak; callable even while globally paused.
    function pokeTrailing(uint256 id) external nonReentrant {
        Order storage o = _openOrder(id);
        if (o.orderType != OrderType.TRAILING_STOP) revert InvalidParameters();
        if (block.timestamp >= o.expiry) revert IArcTradeErrors.OrderExpired(id);
        (uint256 price,) = currentPrice(o.base);
        _raisePeak(id, o, price);
    }

    /// @notice Cancels the caller's open order and refunds its full input, including while paused.
    function cancelOrder(uint256 id) external nonReentrant {
        Order storage o = _openOrder(id);
        if (o.owner != msg.sender) revert NotOrderOwner();
        o.status = Status.CANCELLED;
        IERC20(o.side == Side.BUY ? quote : o.base).safeTransfer(o.owner, o.amountIn);
        emit OrderCancelled(id, o.owner, o.amountIn);
    }

    /// @notice Marks an expired open order and refunds its owner without requiring an oracle.
    function expireOrder(uint256 id) external nonReentrant {
        Order storage o = _openOrder(id);
        if (block.timestamp < o.expiry) revert NotExpired();
        o.status = Status.EXPIRED;
        IERC20(o.side == Side.BUY ? quote : o.base).safeTransfer(o.owner, o.amountIn);
        emit OrderExpired(id, o.owner, o.amountIn);
    }

    /// @notice Returns an existing order, including its final execution accounting.
    function getOrder(uint256 id) external view returns (Order memory) {
        if (_orders[id].owner == address(0)) revert InvalidOrder(id);
        return _orders[id];
    }

    /// @notice Lists all order IDs created by an account.
    function getOrderIds(address account) external view returns (uint256[] memory) { return _orderIds[account]; }

    /// @notice Previews trigger and minimum output, using a virtual higher trailing peak.
    /// @dev External so checkOrder can catch feed failures and malformed oracle responses.
    function previewOrder(uint256 id) external view returns (bool triggered, uint256 price18, uint256 minOut) {
        Order storage o = _orders[id];
        if (o.owner == address(0)) revert InvalidOrder(id);
        (price18,) = currentPrice(o.base);
        triggered = _triggered(o, price18);
        minOut = _orderMinOut(o, price18);
    }

    /// @notice Returns reason 0 ready, 1 not open, 2 expired, 3 not triggered, 4 oracle unavailable, 5 paused.
    /// @dev Readiness does not guarantee a target quote or swap fill; feed failures never propagate.
    function checkOrder(uint256 id) external view returns (bool executable, uint8 reasonCode, uint256 price18, uint256 minOut) {
        Order storage o = _orders[id];
        if (o.owner == address(0) || o.status != Status.OPEN) return (false, 1, 0, 0);
        if (block.timestamp >= o.expiry) return (false, 2, 0, 0);
        if (paused()) return (false, 5, 0, 0);
        try this.previewOrder(id) returns (bool triggered, uint256 price, uint256 minimum) {
            return (triggered, triggered ? 0 : 3, price, minimum);
        } catch { return (false, 4, 0, 0); }
    }

    /// @notice Escrows up to 520 recurring quote-token buys; a zero first execution means now.
    function createDca(
        address base, uint256 amountPerBuy, uint16 numBuys, uint32 interval,
        uint40 firstExecution, uint16 maxSlippageBps, uint256 maxPrice
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        if (base == quote || amountPerBuy == 0 || numBuys == 0 || numBuys > 520 || interval < 3600 || maxPrice > MAX_USER_PRICE) {
            revert InvalidParameters();
        }
        _validateSlippage(maxSlippageBps);
        currentPrice(base);
        uint256 budget = amountPerBuy * numBuys;
        id = nextDcaId++;
        Dca storage d = _dcas[id];
        d.owner = msg.sender;
        d.base = base;
        d.amountPerBuy = amountPerBuy;
        d.budgetRemaining = budget;
        d.interval = interval;
        d.nextExecution = firstExecution == 0 ? _time(block.timestamp) : firstExecution;
        d.maxSlippageBps = maxSlippageBps;
        d.maxPrice = maxPrice;
        d.status = DcaStatus.ACTIVE;
        d.createdAt = _time(block.timestamp);
        _dcaIds[msg.sender].push(id);
        _pull(quote, budget);
        emit DcaCreated(id, msg.sender, d);
    }

    /// @notice Executes one due purchase, paying the keeper in base tokens from the output.
    function executeDca(uint256 id, address target, bytes calldata data) external nonReentrant whenNotPaused {
        Dca storage d = _existingDca(id);
        if (d.status != DcaStatus.ACTIVE || d.budgetRemaining == 0) revert DcaNotActive();
        if (block.timestamp < d.nextExecution) revert DcaNotDue();
        (uint256 price,) = currentPrice(d.base);
        if (d.maxPrice != 0 && price > d.maxPrice) revert PriceAboveCap(price, d.maxPrice);
        uint256 amountIn = Math.min(d.amountPerBuy, d.budgetRemaining);
        uint256 minOut = _floor(baseForQuote(d.base, amountIn, price), d.maxSlippageBps);
        (uint256 net, uint256 fee) = _swap(quote, d.base, amountIn, minOut, target, data);
        d.budgetRemaining -= amountIn;
        d.totalSpent += amountIn;
        d.totalBought += net;
        ++d.executions;
        uint256 scheduled = uint256(d.nextExecution) + d.interval;
        d.nextExecution = _time(scheduled <= block.timestamp ? block.timestamp + d.interval : scheduled);
        if (d.budgetRemaining == 0) d.status = DcaStatus.COMPLETED;
        IERC20(d.base).safeTransfer(d.owner, net);
        if (fee != 0) IERC20(d.base).safeTransfer(msg.sender, fee);
        emit DcaExecuted(id, d.owner, msg.sender, amountIn, net, fee, d.nextExecution);
        if (d.status == DcaStatus.COMPLETED) emit DcaCompleted(id);
    }

    /// @notice Pauses only the caller's active recurring plan.
    function pauseDca(uint256 id) external nonReentrant {
        Dca storage d = _ownedDca(id);
        if (d.status != DcaStatus.ACTIVE) revert DcaNotActive();
        d.status = DcaStatus.PAUSED;
        emit DcaPaused(id);
    }

    /// @notice Resumes the caller's paused plan without scheduling in the past.
    function resumeDca(uint256 id) external nonReentrant {
        Dca storage d = _ownedDca(id);
        if (d.status != DcaStatus.PAUSED) revert DcaNotPaused();
        d.status = DcaStatus.ACTIVE;
        d.nextExecution = _time(Math.max(d.nextExecution, block.timestamp));
        emit DcaResumed(id, d.nextExecution);
    }

    /// @notice Cancels the caller's active or paused plan and refunds all unused quote tokens.
    function cancelDca(uint256 id) external nonReentrant {
        Dca storage d = _ownedDca(id);
        if (d.status != DcaStatus.ACTIVE && d.status != DcaStatus.PAUSED) revert DcaNotCancellable();
        uint256 refund = d.budgetRemaining;
        d.budgetRemaining = 0;
        d.status = DcaStatus.CANCELLED;
        IERC20(quote).safeTransfer(d.owner, refund);
        emit DcaCancelled(id, d.owner, refund);
    }

    /// @notice Returns an existing recurring plan and its accumulated net purchases.
    function getDca(uint256 id) external view returns (Dca memory) {
        if (_dcas[id].owner == address(0)) revert InvalidDca(id);
        return _dcas[id];
    }

    /// @notice Lists all recurring plan IDs created by an account.
    function getDcaIds(address account) external view returns (uint256[] memory) { return _dcaIds[account]; }

    /// @notice Previews a plan's oracle price and net minimum; reverts for unavailable oracle data.
    function previewDca(uint256 id) external view returns (uint256 price18, uint256 minOut) {
        Dca storage d = _dcas[id];
        if (d.owner == address(0)) revert InvalidDca(id);
        (price18,) = currentPrice(d.base);
        minOut = _floor(baseForQuote(d.base, Math.min(d.amountPerBuy, d.budgetRemaining), price18), d.maxSlippageBps);
    }

    /// @notice Returns reason 0 ready, 1 not active, 2 not due, 3 above cap, 4 oracle unavailable, 5 paused.
    function checkDca(uint256 id) external view returns (bool executable, uint8 reasonCode, uint256 price18, uint256 minOut) {
        Dca storage d = _dcas[id];
        if (d.owner == address(0) || d.status != DcaStatus.ACTIVE || d.budgetRemaining == 0) return (false, 1, 0, 0);
        if (block.timestamp < d.nextExecution) return (false, 2, 0, 0);
        if (paused()) return (false, 5, 0, 0);
        try this.previewDca(id) returns (uint256 price, uint256 minimum) {
            if (d.maxPrice != 0 && price > d.maxPrice) return (false, 3, price, minimum);
            return (true, 0, price, minimum);
        } catch { return (false, 4, 0, 0); }
    }

    function _usdPrice18(address token) private view returns (uint256 price, uint256 updatedAt) {
        TokenConfig memory c = tokenConfigs[token];
        if (c.feed == address(0)) revert TokenNotSupported(token);
        int256 answer;
        try AggregatorV3Interface(c.feed).latestRoundData() returns (
            uint80, int256 a, uint256, uint256 timestamp, uint80
        ) {
            answer = a;
            updatedAt = timestamp;
        } catch { revert InvalidPrice(token); }
        if (answer <= 0) revert InvalidPrice(token);
        if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > c.maxStaleness) {
            revert StalePrice(token);
        }
        if (c.feedDecimals <= 18) {
            uint256 scale = _pow10(18 - c.feedDecimals);
            if (uint256(answer) > type(uint256).max / scale) revert InvalidPrice(token);
            price = Math.mulDiv(uint256(answer), scale, 1);
        } else {
            price = Math.mulDiv(uint256(answer), 1, _pow10(c.feedDecimals - 18));
        }
        if (price == 0) revert InvalidPrice(token);
    }

    function _validateOrderPrices(CreateParams calldata p, uint256 price) private pure {
        if (p.triggerPrice > MAX_USER_PRICE || p.limitPrice > MAX_USER_PRICE) revert InvalidParameters();
        if (p.orderType == OrderType.TRAILING_STOP) {
            if (p.trailBps < 10 || p.trailBps > 5000 || p.triggerPrice != 0 || p.limitPrice != 0) revert InvalidParameters();
            return;
        }
        if (p.triggerPrice == 0 || p.trailBps != 0) revert InvalidParameters();
        if (p.orderType == OrderType.STOP_LIMIT || p.orderType == OrderType.OCO) {
            if (p.limitPrice == 0) revert InvalidParameters();
        } else if (p.limitPrice != 0) revert InvalidParameters();
        if (p.orderType == OrderType.STOP_LOSS || p.orderType == OrderType.STOP_LIMIT) {
            if (p.triggerPrice >= price) revert InvalidParameters();
        }
        if (p.orderType == OrderType.TAKE_PROFIT && p.triggerPrice <= price) revert InvalidParameters();
        if (p.orderType == OrderType.STOP_LIMIT && p.limitPrice > p.triggerPrice) revert InvalidParameters();
        if (p.orderType == OrderType.OCO && !(p.triggerPrice < price && price < p.limitPrice)) revert InvalidParameters();
    }

    function _triggered(Order storage o, uint256 price) private view returns (bool) {
        if (o.orderType == OrderType.LIMIT) return o.side == Side.BUY ? price <= o.triggerPrice : price >= o.triggerPrice;
        if (o.orderType == OrderType.TAKE_PROFIT) return price >= o.triggerPrice;
        if (o.orderType == OrderType.STOP_LIMIT) return o.stopActivated || price <= o.triggerPrice;
        if (o.orderType == OrderType.TRAILING_STOP) {
            uint256 peak = Math.max(o.peakPrice, price);
            return price <= Math.mulDiv(peak, BPS - o.trailBps, BPS);
        }
        if (o.orderType == OrderType.OCO) return price <= o.triggerPrice || price >= o.limitPrice;
        return price <= o.triggerPrice;
    }

    function _orderMinOut(Order storage o, uint256 price) private view returns (uint256 minimum) {
        minimum = _floor(_convert(o, price), o.maxSlippageBps);
        uint256 userPrice;
        if (o.orderType == OrderType.LIMIT || o.orderType == OrderType.TAKE_PROFIT) userPrice = o.triggerPrice;
        else if (o.orderType == OrderType.STOP_LIMIT) userPrice = o.limitPrice;
        else if (o.orderType == OrderType.OCO && price >= o.limitPrice) userPrice = o.limitPrice;
        if (userPrice != 0) minimum = Math.max(minimum, _convert(o, userPrice));
    }

    function _convert(Order storage o, uint256 price) private view returns (uint256) {
        return o.side == Side.BUY ? baseForQuote(o.base, o.amountIn, price) : quoteForBase(o.base, o.amountIn, price);
    }

    function _raisePeak(uint256 id, Order storage o, uint256 price) private {
        if (o.orderType == OrderType.TRAILING_STOP && price > o.peakPrice) {
            o.peakPrice = price;
            emit TrailingPeakUpdated(id, price);
        }
    }

    function _swap(
        address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address target, bytes calldata data
    ) private returns (uint256 net, uint256 fee) {
        if (!swapTargets[target]) revert SwapTargetNotAllowed(target);
        uint256 inputBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outputBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(target, amountIn);
        (bool success, bytes memory result) = target.call(data);
        IERC20(tokenIn).forceApprove(target, 0);
        if (!success) {
            if (result.length == 0) revert SwapFailed();
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        uint256 inputAfter = IERC20(tokenIn).balanceOf(address(this));
        if (inputAfter > inputBefore) revert PartialFill(0, amountIn);
        uint256 spent = inputBefore - inputAfter;
        if (spent != amountIn) revert PartialFill(spent, amountIn);
        uint256 outputAfter = IERC20(tokenOut).balanceOf(address(this));
        if (outputAfter < outputBefore) revert InvalidBalanceDelta();
        uint256 received = outputAfter - outputBefore;
        fee = Math.mulDiv(received, keeperFeeBps, BPS);
        net = received - fee;
        if (net < minOut) revert InsufficientOutput(net, minOut);
        // Prevent zero-sized realized-price denominators and dust executions paying nothing to users.
        if (net == 0) revert InsufficientOutput(0, Math.max(minOut, 1));
    }

    function _pull(address token, uint256 amount) private {
        uint256 beforeBalance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = IERC20(token).balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert TransferAmountMismatch();
    }

    function _realizedPrice(address base, uint256 baseAmount, uint256 quoteAmount) private view returns (uint256) {
        uint8 bd = tokenConfigs[base].tokenDecimals;
        uint8 qd = tokenConfigs[quote].tokenDecimals;
        if (bd >= qd) return Math.mulDiv(quoteAmount, WAD * _pow10(bd - qd), baseAmount);
        return Math.mulDiv(Math.mulDiv(quoteAmount, WAD, baseAmount), 1, _pow10(qd - bd));
    }

    function _openOrder(uint256 id) private view returns (Order storage o) {
        o = _orders[id];
        if (o.owner == address(0)) revert InvalidOrder(id);
        if (o.status != Status.OPEN) revert OrderNotOpen(id);
    }

    function _existingDca(uint256 id) private view returns (Dca storage d) {
        d = _dcas[id];
        if (d.owner == address(0)) revert InvalidDca(id);
    }

    function _ownedDca(uint256 id) private view returns (Dca storage d) {
        d = _existingDca(id);
        if (d.owner != msg.sender) revert NotDcaOwner();
    }

    function _floor(uint256 amount, uint16 slippage) private pure returns (uint256) {
        return Math.mulDiv(amount, BPS - slippage, BPS);
    }

    function _validateSlippage(uint16 slippage) private pure {
        if (slippage == 0 || slippage > 1000) revert InvalidParameters();
    }

    function _pow10(uint8 exponent) private pure returns (uint256) { return 10 ** uint256(exponent); }

    function _time(uint256 timestamp) private pure returns (uint40) {
        if (timestamp > type(uint40).max) revert TimestampOverflow();
        return uint40(timestamp);
    }
}
