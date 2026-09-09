// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BasketRouter, IUniswapV3Factory, IUniswapV3Pool, SafeTransfer} from "./BasketRouter.sol";
import {OracleLib, IAggregatorV3} from "./OracleLib.sol";
import {Guarded} from "./Guarded.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPermit2, PERMIT2} from "./IPermit2.sol";

interface IERC20Bal {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IStockToken {
    /// ERC-8056 scaled UI amount, adjusting for splits and dividends.
    function uiMultiplier() external view returns (uint256);
}

/**
 * @title Rebalancer
 * @notice Keeps a holder's basket in ratio without ever taking their tokens.
 *
 * @dev **Custody.** The holder keeps everything in their own wallet and grants
 *      an allowance. A keeper calls `rebalance`, which pulls only what it sells,
 *      swaps, and returns the proceeds to the same wallet in one transaction.
 *      Revoke the allowance or call `unsubscribe` and the keeper is powerless.
 *      Nothing rests here between transactions.
 *
 *      **Splits are frozen, not handled.** Every stock token carries an
 *      ERC-8056 `uiMultiplier` that changes on a split or dividend. Trying to
 *      do the arithmetic through a corporate action is how a rebalancer sells
 *      an entire position into a price that only looks like a 50% crash. So the
 *      multiplier of every leg is recorded at subscribe time, and if any of
 *      them moves, rebalancing stops until the holder acknowledges it. Refusing
 *      to act is the correct behaviour when the ground moves.
 *
 *      **Staleness.** See OracleLib. Feeds here update on deviation and run
 *      24/5, so a weekend has no prices at all. A rebalance that cannot get a
 *      fresh enough price reverts rather than trading on Friday's number.
 */
contract Rebalancer is Guarded, ReentrancyGuardTransient {
    using SafeTransfer for address;
    using OracleLib for IAggregatorV3;

    uint16 internal constant BPS = 10_000;

    BasketRouter public immutable registry;
    IUniswapV3Factory public immutable factory;
    /// What the basket is motifinated and settled in, USDG.
    address public immutable input;
    address public immutable owner;

    /// Add only. The owner may register a feed for a token that has none, and
    /// may never repoint one, so a live subscription cannot have its prices
    /// swapped underneath it.
    mapping(address => IAggregatorV3) public feedOf;

    struct Sub {
        uint256 indexId;
        /// Rebalance only once any leg is this far from its target weight.
        uint16 driftBps;
        /// Worst execution the holder will accept on each swap.
        uint16 maxSlippageBps;
        /// Oldest price the holder will let the keeper act on.
        uint32 maxPriceAge;
        /// Minimum gap between rebalances, so a keeper bug cannot churn a wallet.
        uint32 cooldown;
        uint64 lastRebalanceAt;
        bool active;
    }

    mapping(address => Sub) public subs;
    /// holder => token => uiMultiplier recorded when they subscribed.
    mapping(address => mapping(address => uint256)) public multiplierAt;

    /// Still read by the swap callback to prove it belongs to a rebalance this
    /// contract started. Reentrancy itself is inherited.
    bool private _working;

    event Subscribed(address indexed holder, uint256 indexed indexId, uint16 driftBps);
    event Unsubscribed(address indexed holder);
    event Rebalanced(address indexed holder, uint256 indexed indexId, uint256 driftBefore);
    event CorporateActionAcknowledged(address indexed holder, address indexed token, uint256 from, uint256 to);
    event FeedRegistered(address indexed token, address indexed feed);

    error NotOwner();
    error FeedAlreadySet(address token);
    error NotSubscribed(address holder);
    error NoDriftToCorrect(uint256 drift, uint256 threshold);
    error CooldownActive(uint64 until);
    error CorporateActionPending(address token, uint256 was, uint256 now_);
    error UnknownCaller();
    error Reentrancy();
    error NothingToValue();
    error SlippageTooHigh(uint256 got, uint256 wanted);
    error SlippageCapExceeded(uint16 bps);

    constructor(
        BasketRouter _registry,
        IUniswapV3Factory _factory,
        address _input,
        address _owner,
        address _guardian,
        uint256 _maxNotional
    ) Guarded(_guardian, _maxNotional) {
        registry = _registry;
        factory = _factory;
        input = _input;
        owner = _owner;
    }

    function registerFeed(address token, IAggregatorV3 feed) external {
        if (msg.sender != owner) revert NotOwner();
        if (address(feedOf[token]) != address(0)) revert FeedAlreadySet(token);
        feedOf[token] = feed;
        emit FeedRegistered(token, address(feed));
    }

    // ----------------------------------------------------------- subscription

    function subscribe(uint256 indexId, uint16 driftBps, uint16 maxSlippageBps, uint32 maxPriceAge, uint32 cooldown)
        external
    {
        // Capped, because a subscription that accepts any price is a standing
        // invitation to whoever keeps it.
        if (maxSlippageBps > 1_000) revert SlippageCapExceeded(maxSlippageBps);
        subs[msg.sender] = Sub({
            indexId: indexId,
            driftBps: driftBps,
            maxSlippageBps: maxSlippageBps,
            maxPriceAge: maxPriceAge,
            cooldown: cooldown,
            lastRebalanceAt: 0,
            active: true
        });

        BasketRouter.Leg[] memory legs = registry.legsOf(indexId);
        for (uint256 i; i < legs.length; ++i) {
            multiplierAt[msg.sender][legs[i].token] = _multiplier(legs[i].token);
        }
        emit Subscribed(msg.sender, indexId, driftBps);
    }

    function unsubscribe() external {
        subs[msg.sender].active = false;
        emit Unsubscribed(msg.sender);
    }

    /**
     * @notice Confirm a split or dividend and let rebalancing resume.
     * @dev Deliberately the holder's call and not the keeper's. A corporate
     *      action changes what a position means, and the point of freezing is
     *      that a person looks at it before a machine trades it.
     */
    function acknowledgeCorporateActions() external {
        Sub storage s = subs[msg.sender];
        if (!s.active) revert NotSubscribed(msg.sender);
        BasketRouter.Leg[] memory legs = registry.legsOf(s.indexId);
        for (uint256 i; i < legs.length; ++i) {
            uint256 was = multiplierAt[msg.sender][legs[i].token];
            uint256 nowM = _multiplier(legs[i].token);
            if (was != nowM) {
                multiplierAt[msg.sender][legs[i].token] = nowM;
                emit CorporateActionAcknowledged(msg.sender, legs[i].token, was, nowM);
            }
        }
    }

    // -------------------------------------------------------------- valuation

    /**
     * @notice What the holder's legs are worth and how far each has drifted.
     * @return values Per leg value, 1e18 scaled.
     * @return total Sum of them.
     * @return worstDriftBps The largest absolute deviation from target weight.
     */
    function positionOf(address holder)
        public
        view
        returns (uint256[] memory values, uint256 total, uint256 worstDriftBps)
    {
        Sub memory s = subs[holder];
        if (!s.active) revert NotSubscribed(holder);
        BasketRouter.Leg[] memory legs = registry.legsOf(s.indexId);

        values = new uint256[](legs.length);
        for (uint256 i; i < legs.length; ++i) {
            address token = legs[i].token;
            IAggregatorV3 feed = feedOf[token];
            if (address(feed) == address(0)) revert OracleLib.NoFeed(token);
            uint256 price = feed.priceOf(s.maxPriceAge);
            uint256 bal = IERC20Bal(token).balanceOf(holder);
            values[i] = (bal * price) / 1e18;
            total += values[i];
        }
        if (total == 0) revert NothingToValue();

        for (uint256 i; i < legs.length; ++i) {
            uint256 targetBps = legs[i].weightBps;
            uint256 actualBps = (values[i] * BPS) / total;
            uint256 d = actualBps > targetBps ? actualBps - targetBps : targetBps - actualBps;
            if (d > worstDriftBps) worstDriftBps = d;
        }
    }

    /// Cheap enough for a keeper to poll before spending gas on a revert.
    function shouldRebalance(address holder) external view returns (bool ok, string memory why) {
        Sub memory s = subs[holder];
        if (!s.active) return (false, "not subscribed");
        if (block.timestamp < uint256(s.lastRebalanceAt) + s.cooldown) return (false, "cooldown");

        BasketRouter.Leg[] memory legs = registry.legsOf(s.indexId);
        for (uint256 i; i < legs.length; ++i) {
            if (multiplierAt[holder][legs[i].token] != _multiplier(legs[i].token)) {
                return (false, "corporate action pending");
            }
            // Checked before the read, because the read cannot survive it. An
            // unregistered feed is address(0), and a high level call to an
            // address with no code reverts before it returns anything, so this
            // view used to revert with no reason attached in exactly the case
            // it exists to explain. `positionOf` already refuses this by name;
            // this one is the view a keeper and the portfolio page ask first,
            // and a keeper that gets a revert has to guess. Measured rather
            // than reasoned about: calling `ageOf` on a zero feed reverts.
            IAggregatorV3 feed = feedOf[legs[i].token];
            if (address(feed) == address(0)) return (false, "no price feed for a leg");
            (uint256 age, bool usable) = feed.ageOf();
            if (!usable || age > s.maxPriceAge) return (false, "price too stale");
        }
        (,, uint256 drift) = positionOf(holder);
        if (drift < s.driftBps) return (false, "within tolerance");
        return (true, "");
    }

    // -------------------------------------------------------------- rebalance

    /**
     * @notice Trade a holder's wallet back into ratio. Callable by anyone.
     *
     * @dev Open to any caller on purpose. The holder's own settings bound every
     *      decision, so there is nothing a privileged keeper could do that an
     *      arbitrary one could not, and a permissionless keeper set means the
     *      service does not stop when one machine dies. Failover is the absence
     *      of a special caller rather than a mechanism.
     */
    function rebalance(address holder) external whenLive nonReentrant {
        _working = true;

        Sub storage s = subs[holder];
        if (!s.active) revert NotSubscribed(holder);

        uint64 until = s.lastRebalanceAt + s.cooldown;
        if (block.timestamp < until) revert CooldownActive(until);

        BasketRouter.Leg[] memory legs = registry.legsOf(s.indexId);
        for (uint256 i; i < legs.length; ++i) {
            uint256 was = multiplierAt[holder][legs[i].token];
            uint256 nowM = _multiplier(legs[i].token);
            if (was != nowM) revert CorporateActionPending(legs[i].token, was, nowM);
        }

        (uint256[] memory values, uint256 total, uint256 drift) = positionOf(holder);
        if (drift < s.driftBps) revert NoDriftToCorrect(drift, s.driftBps);

        // The cap exists to bound what one call can pull from an allowance, and
        // a rebalance pulls from an allowance. Leaving it out put exactly the
        // largest positions outside the limit written for them. `total` is 1e18
        // scaled dollars and the cap is 6 decimal USDG.
        _underCap(total / 1e12);

        // Idempotency: stamp before doing any work, so a keeper that retries a
        // transaction it thinks failed cannot run the same correction twice.
        s.lastRebalanceAt = uint64(block.timestamp);
        emit Rebalanced(holder, s.indexId, drift);

        // Pass one, sell every overweight leg down to target.
        for (uint256 i; i < legs.length; ++i) {
            uint256 target = (total * legs[i].weightBps) / BPS;
            if (values[i] <= target) continue;
            uint256 excessValue = values[i] - target;
            uint256 bal = IERC20Bal(legs[i].token).balanceOf(holder);
            uint256 sell = (bal * excessValue) / values[i];
            if (sell == 0) continue;
            // Permit2, so a subscription left running does not sit behind an
            // unbounded approval for as long as the holder forgets about it.
            IPermit2(PERMIT2).transferFrom(holder, address(this), uint160(sell), legs[i].token);
            uint256 floor =
                (_expectUsdg(sell, _priceOf(legs[i].token, s.maxPriceAge)) * (BPS - s.maxSlippageBps)) / BPS;
            _swap(legs[i].token, input, legs[i].fee, sell, address(this), floor);
        }

        // Pass two, spend the proceeds on whatever is underweight, in proportion
        // to how short each leg is rather than to its weight.
        uint256 budget = IERC20Bal(input).balanceOf(address(this));
        if (budget != 0) {
            uint256 shortfallTotal;
            for (uint256 i; i < legs.length; ++i) {
                uint256 target = (total * legs[i].weightBps) / BPS;
                if (values[i] < target) shortfallTotal += target - values[i];
            }
            uint256 spent;
            for (uint256 i; i < legs.length && shortfallTotal != 0; ++i) {
                uint256 target = (total * legs[i].weightBps) / BPS;
                if (values[i] >= target) continue;
                uint256 share = ((target - values[i]) * budget) / shortfallTotal;
                if (share > budget - spent) share = budget - spent;
                if (share == 0) continue;
                spent += share;
                uint256 floor =
                    (_expectTokens(share, _priceOf(legs[i].token, s.maxPriceAge)) * (BPS - s.maxSlippageBps)) / BPS;
                _swap(input, legs[i].token, legs[i].fee, share, holder, floor);
            }
            // Anything left over is dust from rounding. It goes back, never stays.
            uint256 left = IERC20Bal(input).balanceOf(address(this));
            if (left != 0) input.safeTransfer(holder, left);
        }

        _working = false;
    }

    /**
     * @dev Every swap carries a floor. Without one, a permissionless keeper can
     *      sandwich the rebalance and take the position, which is exactly what
     *      an earlier version of this contract allowed: `maxSlippageBps` was
     *      recorded at subscribe time and then never read.
     *
     *      The floor is anchored to the **oracle**, not to the pool. This
     *      contract already refuses to run on a stale feed, so a fresh oracle
     *      price is guaranteed to be available here, and it is far harder to
     *      push than spot. Deriving the floor from the pool would let whoever
     *      moved the pool move the protection with it.
     */
    function _swap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        address recipient,
        uint256 minOut
    ) internal returns (uint256 received) {
        address pool = factory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert BasketRouter.NoPoolForLeg(tokenOut, fee);
        bool zeroForOne = tokenIn < tokenOut;
        (int256 a0, int256 a1) = IUniswapV3Pool(pool).swap(
            recipient,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? 4_295_128_740 : 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341,
            abi.encode(tokenIn, tokenOut, fee)
        );
        int256 out = zeroForOne ? -a1 : -a0;
        received = out > 0 ? uint256(out) : 0;
        if (received < minOut) revert SlippageTooHigh(received, minOut);
    }

    /// USDG expected for a quantity of a stock token, at the oracle price.
    function _expectUsdg(uint256 tokens, uint256 price18) internal pure returns (uint256) {
        return (tokens * price18) / 1e30;
    }

    /// Stock tokens expected for a quantity of USDG, at the oracle price.
    function _expectTokens(uint256 usdgAmount, uint256 price18) internal pure returns (uint256) {
        return price18 == 0 ? 0 : (usdgAmount * 1e30) / price18;
    }

    function _priceOf(address token, uint32 maxAge) internal view returns (uint256) {
        IAggregatorV3 feed = feedOf[token];
        if (address(feed) == address(0)) revert OracleLib.NoFeed(token);
        return feed.priceOf(maxAge);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (!_working) revert UnknownCaller();
        (address tokenIn, address tokenOut, uint24 fee) = abi.decode(data, (address, address, uint24));
        if (msg.sender != factory.getPool(tokenIn, tokenOut, fee)) revert UnknownCaller();
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        tokenIn.safeTransfer(msg.sender, owed);
    }

    /// A token that does not implement ERC-8056 is treated as unsplit rather
    /// than as an error, so a plain ERC-20 leg does not brick a basket.
    function _multiplier(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(IStockToken.uiMultiplier.selector));
        if (!ok || ret.length < 32) return 1e18;
        return abi.decode(ret, (uint256));
    }
}
