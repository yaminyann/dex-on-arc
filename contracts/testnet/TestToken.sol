// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken
/// @notice TESTNET ONLY. A mintable ERC-20 used to exercise the trading terminal on a network
///         that has no real oracle feeds or aggregator. It has no value. Never deploy to mainnet.
contract TestToken is ERC20 {
    uint8 private immutable _decimals;
    /// @notice Amount handed out by each call to `faucet`.
    uint256 public immutable faucetAmount;
    address public immutable admin;
    /// @notice Address allowed to mint (the test swap router).
    address public minter;

    error NotMinter();
    error NotAdmin();
    error FaucetLimit();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 faucetAmount_, address admin_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        faucetAmount = faucetAmount_;
        admin = admin_;
        minter = admin_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Gives the caller `faucetAmount` test tokens. Capped at ten times that amount per wallet.
    function faucet() external {
        if (balanceOf(msg.sender) + faucetAmount > faucetAmount * 10) revert FaucetLimit();
        _mint(msg.sender, faucetAmount);
    }

    function setMinter(address newMinter) external {
        if (msg.sender != admin) revert NotAdmin();
        minter = newMinter;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }
}
