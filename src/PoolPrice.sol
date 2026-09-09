// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";

interface IUniswapV3PoolState {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/**
 * @title PoolPrice
 * @notice The spot price of a stock token in USDG, read from the pool itself.
 *
 * @dev **Why not the oracle.** Chainlink stock feeds on this chain run 24/5 and
 *      update on price deviation rather than a heartbeat: an NVDA feed was
 *      measured 120 minutes stale mid session, and across a weekend there is no
 *      update at all. Orders that are supposed to fire while the exchange is
 *      shut therefore cannot use it. The pool never stops trading, so the pool
 *      is the trigger.
 *
 *      That is a real tradeoff and not a free win. A pool price is thinner and
 *      easier to push around than an oracle, which is why every order carries
 *      its own minimum output: the trigger decides *whether* to trade, and the
 *      minimum decides whether the fill is acceptable. Moving the pool to
 *      trigger somebody's stop still has to survive their slippage bound.
 */
library PoolPrice {
    error PoolLocked();

    /**
     * @notice USDG per whole stock token, scaled to 1e18.
     * @param usdgIsToken0 whether USDG sorts first in this pool.
     *
     * @dev USDG has 6 decimals and stock tokens have 18, so the raw ratio is
     *      off by 1e12 before scaling. The arithmetic is split around the shift
     *      rather than done in one multiply, because `sqrtPriceX96` squared
     *      already reaches 2^320 and anything naive overflows silently.
     */
    function usdgPerToken(address pool, bool usdgIsToken0) internal view returns (uint256 price18) {
        (uint160 sqrtPriceX96,,,,,, bool unlocked) = IUniswapV3PoolState(pool).slot0();
        // A locked pool means a swap is mid flight and slot0 is not a price
        // anyone should act on.
        if (!unlocked) revert PoolLocked();

        // FullMath.mulDiv carries the full 512 bit intermediate, so the square
        // and the scaling can be written as they actually are. The hand rolled
        // version shifted sqrtP down by 32 and split the multiply around the
        // shift to dodge an overflow, and its reciprocal branch was wrong on
        // the first attempt. This is the library that exists for exactly this.
        uint256 sqrtP = uint256(sqrtPriceX96);

        if (usdgIsToken0) {
            // token1 is the stock, so the pool ratio is stock per USDG and the
            // price wanted is its reciprocal: 1e30 * 2^192 / sqrtP^2.
            uint256 denom = FullMath.mulDiv(sqrtP, sqrtP, 1 << 64);
            if (denom == 0) return 0;
            price18 = FullMath.mulDiv(1e30, 1 << 128, denom);
        } else {
            // token1 is USDG, so the ratio already is USDG per stock.
            // 1e30 carries both the 1e18 scaling and the 18 to 6 decimal shift.
            price18 = FullMath.mulDiv(FullMath.mulDiv(sqrtP, sqrtP, 1 << 64), 1e30, 1 << 128);
        }
    }
}
