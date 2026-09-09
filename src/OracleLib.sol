// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/**
 * @title OracleLib
 * @notice Reading a Chainlink stock feed without ever trusting it blindly.
 *
 * @dev This exists because of a measurement rather than a principle. An NVDA
 *      feed on this chain was read 120 minutes stale while the US market was
 *      open, because the stock feeds update on price deviation and not on a
 *      tight heartbeat. Robinhood's own docs also say the stock feeds run 24/5,
 *      so across a weekend there is no update at all.
 *
 *      A rebalancer that assumed a fresh price would trade a portfolio against
 *      a number two hours old, or worse, against Friday's number on a Sunday.
 *      So every read here carries an age, and the caller must decide what age
 *      it will act on. Nothing in this library returns a bare price.
 */
library OracleLib {
    error NoFeed(address token);
    error BadPrice(address feed, int256 answer);
    error StalePrice(address feed, uint256 age, uint256 maxAge);

    /**
     * @notice The price, or a revert. Never a stale number passed off as fresh.
     * @return price Scaled to 1e18 regardless of what the feed reports in.
     */
    function priceOf(IAggregatorV3 feed, uint256 maxAge) internal view returns (uint256 price) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert BadPrice(address(feed), answer);
        if (updatedAt == 0) revert StalePrice(address(feed), type(uint256).max, maxAge);

        uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        if (age > maxAge) revert StalePrice(address(feed), age, maxAge);

        // Stock feeds here report 8 decimals, but read it rather than assume.
        uint8 d = feed.decimals();
        price = d <= 18 ? uint256(answer) * (10 ** (18 - d)) : uint256(answer) / (10 ** (d - 18));
    }

    /**
     * @notice How old the feed is, without reverting.
     * @dev For the keeper to check before it spends gas on a transaction that
     *      would revert on chain anyway, and for the UI to say "prices are from
     *      Friday" rather than showing a confident wrong number.
     */
    function ageOf(IAggregatorV3 feed) internal view returns (uint256 age, bool usable) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0 || updatedAt == 0) return (type(uint256).max, false);
        age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        usable = true;
    }
}
