// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TestPriceFeed
/// @notice TESTNET ONLY. A Chainlink-shaped feed whose price anyone can set, so orders can be
///         triggered on demand. It is not market data. Never deploy to mainnet.
contract TestPriceFeed {
    uint8 public constant decimals = 8;
    string public description;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _round;

    error InvalidPrice();

    event PriceSet(address indexed by, int256 price, uint80 round);

    constructor(string memory description_, int256 initialPrice) {
        if (initialPrice <= 0) revert InvalidPrice();
        description = description_;
        _answer = initialPrice;
        _updatedAt = block.timestamp;
        _round = 1;
    }

    /// @notice Sets the price (8 decimals) and refreshes the timestamp.
    function setPrice(int256 price) external {
        if (price <= 0 || price > 1e18) revert InvalidPrice();
        _answer = price;
        _updatedAt = block.timestamp;
        _round++;
        emit PriceSet(msg.sender, price, _round);
    }

    /// @notice Re-stamps the current price so it is not stale.
    function refresh() external {
        _updatedAt = block.timestamp;
        _round++;
        emit PriceSet(msg.sender, _answer, _round);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }
}
