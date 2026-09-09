// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title IPermit2
 * @notice The subset of Uniswap's Permit2 this project uses.
 *
 * @dev Deployed at the canonical CREATE2 address on Robinhood Chain, verified
 *      on chain at 9,152 bytes, so nothing here has to be deployed by us.
 *
 *      **Why it is worth the extra hop.** The threat model says plainly that
 *      the real exposure in this project is standing allowances: an order or a
 *      subscription is a permission that outlives the transaction that created
 *      it, and a plain ERC-20 approval is unbounded in both size and time. A
 *      Permit2 allowance carries an **amount and an expiry**, so a stop loss
 *      left running for a year does not leave an open ended claim on a wallet.
 *      The strongest advice the threat model could previously offer was "please
 *      approve only what you intend to trade", which is advice rather than a
 *      mechanism. This is the mechanism.
 */
interface IPermit2 {
    /// Move tokens the owner has permitted this contract to move.
    function transferFrom(address from, address to, uint160 amount, address token) external;

    /// Grant an allowance directly, as an alternative to a signed permit.
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    /// The live allowance, so a caller can see what is actually permitted.
    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

// The canonical Permit2 deployment, identical on every chain that has one.
address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
