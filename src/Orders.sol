// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUniswapV3Factory, IUniswapV3Pool, SafeTransfer} from "./BasketRouter.sol";
import {PoolPrice} from "./PoolPrice.sol";
import {Guarded} from "./Guarded.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPermit2, PERMIT2} from "./IPermit2.sol";

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}

/// ERC-8056. Named differently from `Rebalancer`'s identical interface so that
/// a file importing both does not collide on the name.
interface ISplitAware {
    function uiMultiplier() external view returns (uint256);
}

/**
 * @title Orders
 * @notice Stop losses, limits, trailing stops and TWAPs on tokenised equities,
 *         that work while the stock market is shut.
 *
 * @dev **The thing no broker can do.** NVDA trades 09:30 to 16:00. The token
 *      trades constantly, so roughly seventy percent of every week is time when
 *      a holder is exposed and no exchange on earth will accept their stop. On
 *      this chain the pool is always open, so the order can fire.
 *
 *      **Which is why the trigger is the pool and not the oracle.** Chainlink
 *      stock feeds here run 24/5 and update on deviation: an NVDA feed was
 *      measured 120 minutes stale mid session, and a weekend has no update at
 *      all. An order that consults the oracle is an order that cannot fire on a
 *      Sunday, which would defeat the entire point.
 *
 *      **And why the floor is anchored to the trigger.** A pool price is easier
 *      to push around than an oracle. If the minimum output were derived from
 *      spot at execution time, whoever moved the pool would also move the
 *      protection. Instead the floor comes from the price the owner themselves
 *      named, so pushing the pool to trip a stop does not let anyone fill it
 *      cheaply. The trigger decides whether to trade; the owner's own number
 *      decides whether the fill is acceptable.
 *
 *      **Custody.** Nothing is escrowed. An order is a standing permission
 *      against the owner's allowance, and output is paid straight back to them
 *      by the pool. Cancel the order or revoke the allowance and it is dead.
 */
contract Orders is Guarded, ReentrancyGuardTransient {
    using SafeTransfer for address;

    uint16 internal constant BPS = 10_000;
    uint160 internal constant MIN_SQRT_RATIO = 4_295_128_739;
    uint160 internal constant MAX_SQRT_RATIO =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;

    IUniswapV3Factory public immutable factory;
    /// What sell orders receive and buy orders spend. USDG.
    address public immutable usdg;

    enum Kind {
        LimitBuy, // buy the token once it is at or below the trigger
        LimitSell, // sell the token once it is at or above the trigger
        StopLoss, // sell the token once it is at or below the trigger
        TrailingStop, // sell once it falls trailBps from the highest price seen
        Twap // ignore price, fill one slice per interval

    }

    struct Order {
        address owner;
        address token;
        uint24 fee;
        Kind kind;
        /// True when the input is USDG and the output is the stock token.
        bool buying;
        /// Total input to spend, in the input currency's own decimals.
        uint256 amount;
        uint256 filled;
        /// USDG per whole token, 1e18. Unused by Twap.
        uint256 trigger;
        /// TrailingStop only: distance below the peak that arms the sale.
        uint16 trailBps;
        /// TrailingStop only: highest price seen since the order was placed.
        uint256 peak;
        /// The worst fill the owner will accept against their own trigger.
        uint16 maxSlippageBps;
        /// Twap only.
        uint32 slices;
        uint32 interval;
        uint64 lastFillAt;
        uint64 expiry;
        bool active;
    }

    Order[] internal _orders;
    mapping(address => uint256[]) internal _byOwner;
    /// order id => the leg's `uiMultiplier` when the order was placed.
    mapping(uint256 => uint256) public multiplierAt;
    /// Still read by the swap callback to prove it belongs to a fill this
    /// contract started. Reentrancy itself is inherited.
    bool private _working;

    event Placed(uint256 indexed id, address indexed owner, address indexed token, Kind kind, uint256 amount);
    event Filled(uint256 indexed id, uint256 amountIn, uint256 amountOut, uint256 price18);
    event Cancelled(uint256 indexed id);
    event PeakRaised(uint256 indexed id, uint256 peak);
    event CorporateActionAcknowledged(uint256 indexed id, uint256 was, uint256 now_, uint256 trigger);

    error NotOwner();
    error Inactive(uint256 id);
    error NotTriggered(uint256 id, uint256 price18, uint256 trigger);
    error Expired(uint256 id);
    error TooSoon(uint256 id, uint64 readyAt);
    error BadOrder(string why);
    error Underfilled(uint256 got, uint256 wanted);
    error NoPool(address token, uint24 fee);
    error UnknownCaller();
    error Reentrancy();
    error CorporateActionPending(uint256 id, uint256 was, uint256 now_);
    error NoChange(uint256 id);

    constructor(IUniswapV3Factory _factory, address _usdg, address _guardian, uint256 _maxNotional)
        Guarded(_guardian, _maxNotional)
    {
        factory = _factory;
        usdg = _usdg;
    }

    // ------------------------------------------------------------------ place

    function place(Order memory o) external whenLive returns (uint256 id) {
        if (o.token == address(0)) revert BadOrder("no token");
        if (o.amount == 0) revert BadOrder("no amount");
        if (o.maxSlippageBps > 5_000) revert BadOrder("slippage over 50%");
        if (factory.getPool(usdg, o.token, o.fee) == address(0)) revert NoPool(o.token, o.fee);

        o.buying = o.kind == Kind.LimitBuy ? true : o.kind == Kind.Twap ? o.buying : false;

        // The cap is a USDG figure with 6 decimals. A sell is sized in the
        // stock token with 18, so comparing the two directly rejected a one
        // share stop against a $25,000 cap. Value the sell side first.
        _underCap(o.buying ? o.amount : (o.amount * _price(o.token, o.fee)) / 1e30);

        if (o.kind == Kind.Twap) {
            if (o.slices == 0) revert BadOrder("twap needs slices");
            if (o.interval == 0) revert BadOrder("twap needs an interval");
            o.trigger = 0;
        } else if (o.kind == Kind.TrailingStop) {
            if (o.trailBps == 0 || o.trailBps >= BPS) revert BadOrder("bad trail");
            // Start the high water at the current price, so a trailing stop
            // placed into a falling market does not arm instantly off a zero.
            o.peak = _price(o.token, o.fee);
            o.trigger = (o.peak * (BPS - o.trailBps)) / BPS;
            o.slices = 0;
        } else {
            if (o.trigger == 0) revert BadOrder("no trigger");
            o.slices = 0;
        }

        o.owner = msg.sender;
        o.filled = 0;
        o.lastFillAt = 0;
        o.active = true;

        id = _orders.length;
        _orders.push(o);
        _byOwner[msg.sender].push(id);
        // Recorded here so a corporate action after this point is detectable.
        // See the freeze in `ready`.
        multiplierAt[id] = _multiplier(o.token);
        emit Placed(id, msg.sender, o.token, o.kind, o.amount);
    }

    function cancel(uint256 id) external {
        Order storage o = _orders[id];
        if (o.owner != msg.sender) revert NotOwner();
        o.active = false;
        emit Cancelled(id);
    }

    function get(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    function count() external view returns (uint256) {
        return _orders.length;
    }

    function ordersOf(address who) external view returns (uint256[] memory) {
        return _byOwner[who];
    }

    /**
     * @notice Raise a trailing stop's high water mark.
     * @dev Open to anyone, and it has to be. A trailing stop only tightens when
     *      somebody observes a new high, and if only the owner could do that
     *      the stop would quietly stop trailing the moment they stopped
     *      watching, which is the one thing it exists to avoid.
     */
    function poke(uint256 id) external {
        Order storage o = _orders[id];
        if (!o.active || o.kind != Kind.TrailingStop) revert Inactive(id);
        uint256 p = _price(o.token, o.fee);
        if (p > o.peak) {
            o.peak = p;
            o.trigger = (p * (BPS - o.trailBps)) / BPS;
            emit PeakRaised(id, p);
        }
    }

    /**
     * @notice Confirm a split or dividend and restate the level, so the order
     *         can fire again.
     * @param newTrigger The price the owner wants now, 1e18. Ignored by a
     *        trailing stop, which re-anchors to the current price instead.
     *
     * @dev **The owner supplies the new trigger rather than the contract
     *      deriving it, and that is deliberate.** A two for one split is the
     *      easy case: halve it. But `uiMultiplier` also moves on a dividend,
     *      where the price effect is not the same shape at all, and a contract
     *      that quietly rescaled every corporate action the same way would be
     *      guessing on the one number the owner cared enough about to set.
     *      `Rebalancer` gets to simply record the new multiplier because it
     *      trades ratios and a ratio survives a split. A stop is an absolute
     *      price and does not.
     *
     *      A trailing stop is the exception, and not by special pleading: its
     *      trigger is derived from a peak rather than named, so the thing to
     *      restate is the peak, and the only honest peak after a corporate
     *      action is the price right now. Its own `trailBps` then does the
     *      rest.
     */
    function acknowledgeCorporateAction(uint256 id, uint256 newTrigger) external {
        Order storage o = _orders[id];
        if (o.owner != msg.sender) revert NotOwner();
        if (!o.active) revert Inactive(id);

        uint256 was = multiplierAt[id];
        uint256 nowM = _multiplier(o.token);
        // Refused rather than treated as a no-op, because the call that does
        // nothing is the one where the owner has misread which order is stuck.
        if (was == nowM) revert NoChange(id);

        if (o.kind == Kind.TrailingStop) {
            o.peak = _price(o.token, o.fee);
            o.trigger = (o.peak * (BPS - o.trailBps)) / BPS;
        } else if (o.kind != Kind.Twap) {
            if (newTrigger == 0) revert BadOrder("no trigger");
            o.trigger = newTrigger;
        }

        multiplierAt[id] = nowM;
        emit CorporateActionAcknowledged(id, was, nowM, o.trigger);
    }

    // ------------------------------------------------------------------ check

    /// Cheap enough for a keeper to poll before spending gas on a revert.
    function ready(uint256 id) public view returns (bool ok, string memory why, uint256 price18) {
        Order storage o = _orders[id];
        if (!o.active) return (false, "inactive", 0);
        if (o.expiry != 0 && block.timestamp > o.expiry) return (false, "expired", 0);
        if (o.filled >= o.amount) return (false, "complete", 0);

        price18 = _price(o.token, o.fee);

        /*
         * A split freezes the order, and this is the whole point of the check.
         *
         * `Rebalancer` has had this since phase 2 and `Orders` never did, which
         * is the worse of the two places to be missing it: a rebalance is a
         * ratio, and a stop is an absolute price. A two for one split halves
         * what one token is worth, so the pool price halves, and every stop
         * sitting under that level reads as triggered by a crash that did not
         * happen.
         *
         * Nothing was ever sold at the wrong price, because `_floor` anchors on
         * the owner's pre-split trigger and therefore demands about twice what
         * the tokens are now worth, so the fill reverts. But that is a safe
         * accident rather than a design: `ready` said fillable, every execution
         * reverted `Underfilled`, the keeper's consecutive failure counter ate
         * it, and nothing anywhere said the word split. The order looked live
         * and could never fill.
         *
         * So it is refused by name, and only the owner can lift it. A corporate
         * action changes what a position means and what a price level means,
         * and the point of freezing is that a person looks at it before a
         * machine trades it.
         */
        uint256 m = _multiplier(o.token);
        if (m != multiplierAt[id]) return (false, "corporate action pending", price18);

        if (o.kind == Kind.Twap) {
            uint64 readyAt = o.lastFillAt + o.interval;
            if (o.lastFillAt != 0 && block.timestamp < readyAt) return (false, "waiting for the next slice", price18);
        } else if (o.kind == Kind.LimitBuy) {
            if (price18 > o.trigger) return (false, "price above the limit", price18);
        } else if (o.kind == Kind.LimitSell) {
            if (price18 < o.trigger) return (false, "price below the limit", price18);
        } else {
            // StopLoss and TrailingStop both fire on the way down.
            if (price18 > o.trigger) return (false, "price above the stop", price18);
        }

        address src = o.buying ? usdg : o.token;
        uint256 slice = _slice(o);
        if (IERC20Balance(src).balanceOf(o.owner) < slice) return (false, "owner balance too low", price18);
        // The permit is what actually gates a fill, and it can lapse as well as
        // be revoked, so both are reported rather than a bare "no allowance".
        (uint160 permitted, uint48 expiry,) = IPermit2(PERMIT2).allowance(o.owner, src, address(this));
        if (expiry != 0 && block.timestamp > expiry) return (false, "permit expired", price18);
        if (permitted < slice) return (false, "permit revoked or too small", price18);
        return (true, "", price18);
    }

    // ---------------------------------------------------------------- execute

    /**
     * @notice Fill an order, or one slice of a TWAP. Callable by anyone.
     * @dev Permissionless for the same reason rebalancing is: every bound comes
     *      from the owner's own order, so a privileged keeper could do nothing
     *      an arbitrary one could not, and the service does not stop when one
     *      machine dies.
     */
    function execute(uint256 id) external whenLive nonReentrant {
        _working = true;

        Order storage o = _orders[id];
        (bool ok, string memory why, uint256 price18) = ready(id);
        if (!ok) {
            if (keccak256(bytes(why)) == keccak256("expired")) revert Expired(id);
            if (keccak256(bytes(why)) == keccak256("waiting for the next slice")) {
                revert TooSoon(id, o.lastFillAt + o.interval);
            }
            if (keccak256(bytes(why)) == keccak256("inactive") || keccak256(bytes(why)) == keccak256("complete")) {
                revert Inactive(id);
            }
            // Named rather than left to fall through. `NotTriggered` on a
            // frozen order tells a keeper the price is wrong, which sends
            // whoever reads the log looking at the pool instead of at the
            // corporate action that actually stopped it.
            if (keccak256(bytes(why)) == keccak256("corporate action pending")) {
                revert CorporateActionPending(id, multiplierAt[id], _multiplier(o.token));
            }
            revert NotTriggered(id, price18, o.trigger);
        }

        uint256 amountIn = _slice(o);
        // Stamp before the swap. A keeper retrying a transaction it wrongly
        // believes failed must not fill the same slice twice.
        o.filled += amountIn;
        o.lastFillAt = uint64(block.timestamp);
        if (o.filled >= o.amount) o.active = false;

        uint256 floor = _floor(o, amountIn, price18);
        address tokenIn = o.buying ? usdg : o.token;
        address tokenOut = o.buying ? o.token : usdg;

        // Through Permit2, so the standing permission this order relies on
        // carries an amount and an expiry rather than being an open ended
        // approval on the token itself.
        if (amountIn > type(uint160).max) revert BadOrder("amount too large for permit2");
        IPermit2(PERMIT2).transferFrom(o.owner, address(this), uint160(amountIn), tokenIn);

        address pool = factory.getPool(usdg, o.token, o.fee);
        bool zeroForOne = tokenIn < tokenOut;
        (int256 a0, int256 a1) = IUniswapV3Pool(pool).swap(
            o.owner, // straight back to the owner, never held here
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn, tokenOut, o.fee)
        );

        int256 outSigned = zeroForOne ? -a1 : -a0;
        uint256 received = outSigned > 0 ? uint256(outSigned) : 0;
        if (received < floor) revert Underfilled(received, floor);

        emit Filled(id, amountIn, received, price18);
        _working = false;
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (!_working) revert UnknownCaller();
        (address tokenIn, address tokenOut, uint24 fee) = abi.decode(data, (address, address, uint24));
        if (msg.sender != factory.getPool(tokenIn, tokenOut, fee)) revert UnknownCaller();
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        tokenIn.safeTransfer(msg.sender, owed);
    }

    // ----------------------------------------------------------------- internals

    function _slice(Order storage o) internal view returns (uint256) {
        uint256 left = o.amount - o.filled;
        if (o.kind != Kind.Twap) return left;
        uint256 per = o.amount / o.slices;
        // The last slice takes the remainder so rounding never strands dust.
        return left < per * 2 ? left : per;
    }

    /**
     * @dev The minimum acceptable output, derived from the owner's own trigger
     *      rather than from spot, so moving the pool to trip a stop does not
     *      also move the protection. A TWAP has no trigger, so it is the one
     *      type that falls back to spot, and it is the one type where that is
     *      acceptable: it is a schedule, not a promise about price.
     */
    function _floor(Order storage o, uint256 amountIn, uint256 spot18) internal view returns (uint256) {
        uint256 anchorPrice = o.kind == Kind.Twap ? spot18 : o.trigger;
        if (anchorPrice == 0) return 0;

        // USDG is 6 decimals and stock tokens are 18, so 1e30 carries both the
        // decimal shift and the 1e18 price scaling.
        uint256 expected = o.buying
            ? (amountIn * 1e30) / anchorPrice // USDG in, tokens out
            : (amountIn * anchorPrice) / 1e30; // tokens in, USDG out

        return (expected * (BPS - o.maxSlippageBps)) / BPS;
    }

    /// A token that does not implement ERC-8056 is treated as unsplit rather
    /// than as an error, so a plain ERC-20 does not brick an order. Same
    /// tolerance, and the same reason, as `Rebalancer._multiplier`.
    function _multiplier(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(ISplitAware.uiMultiplier.selector));
        if (!ok || ret.length < 32) return 1e18;
        return abi.decode(ret, (uint256));
    }

    function _price(address token, uint24 fee) internal view returns (uint256) {
        address pool = factory.getPool(usdg, token, fee);
        if (pool == address(0)) revert NoPool(token, fee);
        return PoolPrice.usdgPerToken(pool, usdg < token);
    }
}
