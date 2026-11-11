// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Plain ERC-20 with configurable decimals and open mint.
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev ERC-20 that, when armed, calls back into `victim` with `payload` on the next balance movement.
contract ReentrantERC20 is MockERC20 {
    address public victim;
    bytes public payload;
    bool public armed;
    bool public hookRan;
    bool public reenterOk;
    bytes public reenterRet;

    constructor(string memory n, string memory s, uint8 d) MockERC20(n, s, d) {}

    function arm(address victim_, bytes calldata payload_) external {
        victim = victim_;
        payload = payload_;
        armed = true;
        hookRan = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed) {
            armed = false;
            hookRan = true;
            (reenterOk, reenterRet) = victim.call(payload);
        }
        super._update(from, to, value);
    }
}

/// @dev Chainlink-style aggregator with settable answer / updatedAt / decimals.
contract MockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    bool public broken;

    constructor(uint8 d, int256 a) {
        decimals = d;
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 a) external {
        answer = a;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @dev Honest swap target: pulls tokenIn from msg.sender, pays amountIn * num / den of tokenOut.
contract MockSwapTarget {
    uint256 public rateNum = 1;
    uint256 public rateDen = 1;

    function setRate(uint256 n, uint256 d) external {
        rateNum = n;
        rateDen = d;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 out) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        out = (amountIn * rateNum) / rateDen;
        IERC20(tokenOut).transfer(msg.sender, out);
    }

    /// @dev Reverts with empty returndata.
    function failEmpty() external pure {
        assembly { revert(0, 0) }
    }
}

/// @dev Misbehaving swap target. Pays a fixed `outAmount`, with modes that cheat on input accounting or reenter.
contract MaliciousSwapTarget {
    enum Mode { NORMAL, SPEND_HALF, SPEND_NONE, REFUND_INPUT, REENTER }

    Mode public mode;
    uint256 public outAmount;
    address public victim;
    bytes public reenterPayload;
    bool public reenterRan;
    bool public reenterOk;
    bytes public reenterRet;

    function configure(Mode m, uint256 out_) external {
        mode = m;
        outAmount = out_;
    }

    function setReenter(address victim_, bytes calldata payload_) external {
        victim = victim_;
        reenterPayload = payload_;
        mode = Mode.REENTER;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256) {
        uint256 pull = amountIn;
        if (mode == Mode.SPEND_HALF) pull = amountIn / 2;
        if (mode == Mode.SPEND_NONE) pull = 0;
        if (pull != 0) IERC20(tokenIn).transferFrom(msg.sender, address(this), pull);
        if (mode == Mode.REFUND_INPUT) IERC20(tokenIn).transfer(msg.sender, amountIn + 1);
        if (mode == Mode.REENTER) {
            reenterRan = true;
            (reenterOk, reenterRet) = victim.call(reenterPayload);
        }
        IERC20(tokenOut).transfer(msg.sender, outAmount);
        return outAmount;
    }
}
