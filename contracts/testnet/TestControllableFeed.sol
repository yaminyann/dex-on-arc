// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TestControllableFeed
/// @notice TESTNET ONLY. A Chainlink-shaped feed whose every field the admin can set, so the live
///         oracle-protection tests can produce stale timestamps, mismatched rounds, non-positive answers,
///         future timestamps and reverting reads on demand. Never deploy to mainnet.
contract TestControllableFeed {
    uint8 public constant decimals = 8;
    address public immutable admin;

    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;
    int256 public answer;
    uint256 public updatedAt;
    bool public broken;

    error NotAdmin();

    constructor(int256 answer_) {
        admin = msg.sender;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_, uint256 updatedAt_, uint80 roundId_, uint80 answeredInRound_) external {
        if (msg.sender != admin) revert NotAdmin();
        answer = answer_;
        updatedAt = updatedAt_;
        roundId = roundId_;
        answeredInRound = answeredInRound_;
    }

    function setBroken(bool broken_) external {
        if (msg.sender != admin) revert NotAdmin();
        broken = broken_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}
