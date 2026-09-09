// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUniswapV3Factory, SafeTransfer} from "./BasketRouter.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

interface IUniswapV3PoolSwap {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/**
 * @title TokenSwap
 * @notice One swap, through one Uniswap V3 pool, for whoever asks.
 *
 * @dev **Why this exists.** A basket token graduates into its own USDG pool and
 *      that pool is where its price comes from, but a Uniswap V3 pool cannot be
 *      traded by a wallet: `swap` calls `uniswapV3SwapCallback` on its caller to
 *      collect the input, and an externally owned account has no code to answer
 *      with. So without a contract in front of it the site could show a price it
 *      could not let anybody trade at. A holder's only exit was `redeem`, which
 *      pays the backing and never the market, and a launchpad where the sell
 *      button is missing reads as one where selling is not allowed. It is not,
 *      and this is the difference between that being true and being visible.
 *
 *      **It is deliberately ungoverned, and that is not an oversight.** No
 *      owner, no guardian, no pause, no size cap, no fee, no upgrade. Every
 *      other contract here that holds a power holds it for a reason that
 *      survives the question "what does this do to somebody trying to leave",
 *      and a pause on the only way to sell a token does not: it is the exact
 *      shape of the thing this whole design exists to not be. There is nothing
 *      here to govern anyway. It holds no balance between transactions, has no
 *      storage that outlives a call, and can move a token only from the address
 *      that called it, only in the amount that call named, and only to the pool
 *      the real factory returns for the pair.
 *
 *      **What an approval to this is worth to an attacker: nothing.** The
 *      callback pays with `transferFrom(payer, pool, owed)` where `payer` is
 *      encoded by `swap` as `msg.sender` and handed back by the pool untouched.
 *      There is no path that sets `payer` to anybody else, so an open allowance
 *      here can only ever be spent by its own owner. That is the same argument
 *      `BasketRouter` makes and the same three checks enforce it: the cap must
 *      be set, so nothing outside a swap this contract started can reach the
 *      callback; the caller must be the pool the factory returns for the decoded
 *      pair, so a contract that merely claims to be a pool cannot spend an
 *      approval; and the amount is bounded by the swap that was asked for, so a
 *      genuine but hostile pool cannot take more than it was offered.
 *
 *      **No price limit, and `minOut` instead.** The swap runs to whatever the
 *      pool gives and the caller's own bound decides whether that was
 *      acceptable, which is the same split every other trade in this repo uses:
 *      the contract enforces a floor the caller chose, and never a price of its
 *      own, because a price of its own would need an oracle.
 */
contract TokenSwap is ReentrancyGuardTransient {
    using SafeTransfer for address;

    IUniswapV3Factory public immutable factory;

    /// The ends of the V3 price range. A swap that wants no limit asks for one past them.
    uint160 internal constant MIN_SQRT_RATIO = 4_295_128_739;
    uint160 internal constant MAX_SQRT_RATIO = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;

    /**
     * How much the pool being swapped through right now may pull, and nothing
     * at all when zero.
     *
     * @dev The same one variable doing two jobs as `BasketRouter._owedCap`. It
     *      is what stops an arbitrary caller reaching the callback, and it
     *      bounds what a real pool can take if it asks for more than the swap.
     */
    uint256 private _owedCap;

    event Swapped(
        address indexed who, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );

    error NoPool(address tokenIn, address tokenOut, uint24 fee);
    error ZeroAmount();
    error AmountTooLarge();
    error SameToken();
    error Expired(uint256 deadline);
    error TooLittleOut(uint256 got, uint256 wanted);
    error UnknownCaller();
    error PoolWantsTooMuch(uint256 owed, uint256 cap);

    constructor(IUniswapV3Factory factory_) {
        factory = factory_;
    }

    /**
     * @notice Spend `amountIn` of `tokenIn` and receive `tokenOut`, or revert.
     *
     * @param minOut The least the caller will accept. Zero means any price at
     *        all, which is the caller's choice to make badly.
     * @param deadline The last timestamp this may execute at. A transaction
     *        that sits unmined for an hour and then fills is a fill at a price
     *        nobody agreed to.
     *
     * @dev The proceeds go straight to the caller, never through here, so this
     *      contract holds nothing at any point a reentrant call could see.
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 out) {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (tokenIn == tokenOut) revert SameToken();
        if (amountIn == 0) revert ZeroAmount();
        // `swap` takes an int256, and a cast that wrapped would ask the pool for
        // an exact *output* of an enormous number rather than an exact input.
        if (amountIn > uint256(type(int256).max)) revert AmountTooLarge();

        address pool = factory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert NoPool(tokenIn, tokenOut, fee);

        bool zeroForOne = tokenIn < tokenOut;
        _owedCap = amountIn;
        (int256 amount0, int256 amount1) = IUniswapV3PoolSwap(pool).swap(
            msg.sender,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn, tokenOut, fee, msg.sender)
        );
        _owedCap = 0;

        // A negative delta is what the pool paid out.
        int256 delta = zeroForOne ? -amount1 : -amount0;
        out = delta > 0 ? uint256(delta) : 0;
        if (out < minOut) revert TooLittleOut(out, minOut);

        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, out);
    }

    /// @notice Called by a V3 pool mid swap to collect the input side.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        uint256 cap = _owedCap;
        if (cap == 0) revert UnknownCaller();

        (address tokenIn, address tokenOut, uint24 fee, address payer) =
            abi.decode(data, (address, address, uint24, address));
        if (msg.sender != factory.getPool(tokenIn, tokenOut, fee)) revert UnknownCaller();

        // A positive delta is what this contract owes the pool.
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        if (owed > cap) revert PoolWantsTooMuch(owed, cap);

        // From the caller, never from here, and never from anybody else: `payer`
        // is what `swap` encoded, which is only ever its own `msg.sender`.
        tokenIn.safeTransferFrom(payer, msg.sender, owed);
    }
}
