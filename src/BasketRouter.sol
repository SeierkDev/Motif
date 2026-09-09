// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Guarded} from "./Guarded.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/**
 * @dev A pass through to OpenZeppelin's `SafeERC20`, kept only so the other
 *      contracts in this repo keep a single import surface.
 *
 *      The previous version of this was written by hand to cope with tokens
 *      that return nothing from `transfer` rather than a bool. It worked, and
 *      it had exactly one reader. Handling every quirk of every non standard
 *      token is a solved and audited problem, so it is no longer solved here.
 */
library SafeTransfer {
    function safeTransfer(address token, address to, uint256 amount) internal {
        SafeERC20.safeTransfer(IERC20(token), to, amount);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        SafeERC20.safeTransferFrom(IERC20(token), from, to, amount);
    }
}

/**
 * @title BasketRouter
 * @notice Buy a whole index of tokenised equities in one transaction, with
 *         every token landing in the buyer's own wallet.
 *
 * @dev **Venue.** Stock tokens trade against USDG on Uniswap V3 on this chain,
 *      at a factory that is not the canonical mainnet address. An earlier
 *      version of this contract targeted the V4 PoolManager, because it holds a
 *      large NVDA balance. That balance turns out to be memecoin against stock
 *      token pools from the launchpad, and V4 has no USDG paired stock pool at
 *      all. A balance in a venue proves activity, not that your pair is there.
 *
 *      **Custody.** No vault, and no balance between transactions. V3 pays swap
 *      output to any `recipient`, so each leg sends its tokens directly to the
 *      buyer and they never touch this contract. There is no withdrawal
 *      function because there is nothing to withdraw, and no fee balance
 *      because fees leave in the transaction they arrive in.
 *
 *      **Slippage** is bounded per leg from a client side quote rather than
 *      globally. A global bound would have to value several tokens in one
 *      currency inside the transaction, which means reading the oracle, and
 *      the Chainlink stock feeds here update on deviation rather than a
 *      heartbeat: an NVDA feed measured 120 minutes stale while the US market
 *      was open. Per leg minimums need no oracle, so settlement never depends
 *      on one.
 */
contract BasketRouter is Guarded, ReentrancyGuardTransient {
    using SafeTransfer for address;

    /// The most an index creator may charge, so a published index cannot be predatory.
    uint16 public constant MAX_CREATOR_FEE_BPS = 100;
    uint16 public constant PROTOCOL_FEE_BPS = 10;
    /// Same bound as `BasketFactory.MAX_IMAGE_BYTES`, and for the same reasons.
    uint256 public constant MAX_IMAGE_BYTES = 200;
    uint16 internal constant BPS = 10_000;

    /// V3 price bounds. A swap may move the pool anywhere within them, because
    /// the real protection is the per leg minimum rather than a price limit.
    uint160 internal constant MIN_SQRT_RATIO = 4_295_128_739;
    uint160 internal constant MAX_SQRT_RATIO =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;

    IUniswapV3Factory public immutable factory;
    address public immutable protocolFeeTo;

    /**
     * Which assets a basket may be priced in.
     *
     * The threat model treated an arbitrary quote asset purely as a risk, since
     * somebody could publish a basket whose quote token is malicious. An
     * allowlist keeps that shut while turning the capability into the feature:
     * a basket quoted in NVDA is a bet that the basket beats NVDA, and only the
     * guardian decides which assets are sane to price against.
     *
     * Removing one stops new baskets from using it and leaves existing baskets
     * working, because the check happens only at publication.
     */
    mapping(address => bool) public quoteAllowed;

    struct Leg {
        /// The stock token to buy.
        address token;
        /// Which fee tier pool to route through. The pool address is never
        /// stored: it is resolved from the factory at execution time, so an
        /// index cannot be published pointing a leg at a contract the real
        /// factory does not acknowledge.
        uint24 fee;
        /// This leg's share of the spend, in basis points.
        uint16 weightBps;
    }

    struct Index {
        address creator;
        uint16 creatorFeeBps;
        uint64 createdAt;
        /// What buyers pay with, USDG for everything shipped first.
        address input;
        Leg[] legs;
    }

    Index[] internal _indexes;

    /**
     * How much the pool being called right now is allowed to take, and from
     * nothing at all when zero.
     *
     * @dev One variable doing two jobs. Zero means no swap this contract
     *      started is in flight, which is what stops an arbitrary caller
     *      reaching the callback. Nonzero is the exact input of the leg being
     *      swapped, which bounds what a pool can pull even if it is a real pool
     *      for a real pair.
     *
     *      That second half matters because anyone may publish an index with
     *      any leg token, so anyone may cause this contract to call a pool they
     *      created. On the sell path the callback pays out of the seller's own
     *      allowance, and without this bound a hostile pool could ask for the
     *      whole of it rather than the amount its swap was for.
     */
    uint256 private _owedCap;

    /**
     * @dev Name, symbol and description ride in the event rather than storage.
     *      Strings in storage cost real gas on every launch, the indexer already
     *      reads events, and with no vault there is no per basket token whose
     *      metadata could hold them. The record is still permanent on chain.
     */
    event IndexCreated(
        uint256 indexed id,
        address indexed creator,
        uint16 creatorFeeBps,
        uint256 legs,
        string name,
        string symbol,
        string description,
        string image
    );
    event QuoteAllowed(address indexed token, bool allowed);
    event Bought(
        uint256 indexed id, address indexed buyer, uint256 amountIn, uint256 creatorFee, uint256 protocolFee
    );
    /// @dev No fee fields, because there are none on the way out. See `sell`.
    event Sold(uint256 indexed id, address indexed seller, uint256 legs, uint256 amountOut);

    error NoLegs();
    error WeightsMustSumToBps();
    error CreatorFeeTooHigh();
    error MinimumsLengthMismatch();
    error InsufficientOutput(uint256 leg, uint256 got, uint256 wanted);
    error ZeroAddress();
    error AmountTooLarge();
    error NoPoolForLeg(address token, uint24 fee);
    error UnknownCaller();
    error Reentrancy();
    error QuoteNotAllowed(address token);
    error BadMetadata(string why);
    error AmountsLengthMismatch();
    error NothingToSell();
    error PoolWantsTooMuch(uint256 owed, uint256 allowed);

    constructor(
        IUniswapV3Factory _factory,
        address _protocolFeeTo,
        address _guardian,
        uint256 _maxNotional,
        address[] memory _quotes
    )
        Guarded(_guardian, _maxNotional)
    {
        if (address(_factory) == address(0) || _protocolFeeTo == address(0)) revert ZeroAddress();
        factory = _factory;
        protocolFeeTo = _protocolFeeTo;
        for (uint256 i; i < _quotes.length; ++i) {
            quoteAllowed[_quotes[i]] = true;
            emit QuoteAllowed(_quotes[i], true);
        }
    }

    function setQuoteAllowed(address token, bool allowed) external onlyGuardian {
        quoteAllowed[token] = allowed;
        emit QuoteAllowed(token, allowed);
    }

    // ---------------------------------------------------------------- registry

    /**
     * @notice Publish an index. Anyone may do this, and it can never be edited.
     *
     * @dev Immutability is the point rather than a simplification. If weights
     *      could be changed after publication, a creator could wait for buyers
     *      to arrive and then repoint the index at something worthless. A new
     *      set of weights is a new index with a new id; the old one keeps
     *      working and keeps its record.
     */
    /**
     * Publish an index without a picture.
     *
     * @dev Kept as an overload rather than removed, so `BasketCurve` compiles
     *      untouched. That matters for a reason that is not tidiness:
     *      `BasketFactory` carries the curve's whole creation code, and it sits
     *      about 3,500 bytes under the 24,576 deploy limit. Changing the curve
     *      to pass an image it does not have would spend some of that room on
     *      nothing. A basket token already has its own picture, in the factory's
     *      own log.
     */
    function createIndex(
        address input,
        Leg[] calldata legs,
        uint16 creatorFeeBps,
        string calldata name,
        string calldata symbol,
        string calldata description
    ) public returns (uint256 id) {
        return createIndex(input, legs, creatorFeeBps, name, symbol, description, "");
    }

    function createIndex(
        address input,
        Leg[] calldata legs,
        uint16 creatorFeeBps,
        string calldata name,
        string calldata symbol,
        string calldata description,
        string memory image
    ) public returns (uint256 id) {
        if (legs.length == 0) revert NoLegs();
        if (input == address(0)) revert ZeroAddress();
        if (!quoteAllowed[input]) revert QuoteNotAllowed(input);
        if (creatorFeeBps > MAX_CREATOR_FEE_BPS) revert CreatorFeeTooHigh();
        // Bounded so a launch cannot be made arbitrarily expensive for everyone
        // reading the log, and so a nameless basket cannot be published.
        if (bytes(name).length == 0 || bytes(name).length > 48) revert BadMetadata("name 1 to 48 bytes");
        if (bytes(symbol).length == 0 || bytes(symbol).length > 12) revert BadMetadata("symbol 1 to 12 bytes");
        if (bytes(description).length > 280) revert BadMetadata("description over 280 bytes");
        _checkImage(image);

        uint256 total;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].token == address(0)) revert ZeroAddress();
            // Fail at publication rather than leaving a buyer to discover it.
            if (factory.getPool(input, legs[i].token, legs[i].fee) == address(0)) {
                revert NoPoolForLeg(legs[i].token, legs[i].fee);
            }
            total += legs[i].weightBps;
        }
        if (total != BPS) revert WeightsMustSumToBps();

        id = _indexes.length;
        Index storage ix = _indexes.push();
        ix.creator = msg.sender;
        ix.creatorFeeBps = creatorFeeBps;
        ix.createdAt = uint64(block.timestamp);
        ix.input = input;
        for (uint256 i; i < legs.length; ++i) ix.legs.push(legs[i]);

        emit IndexCreated(id, msg.sender, creatorFeeBps, legs.length, name, symbol, description, image);
    }

    function indexCount() external view returns (uint256) {
        return _indexes.length;
    }

    function legsOf(uint256 id) external view returns (Leg[] memory) {
        return _indexes[id].legs;
    }

    function inputOf(uint256 id) external view returns (address) {
        return _indexes[id].input;
    }

    // -------------------------------------------------------------------- buy

    /**
     * @notice Buy every leg of an index in one transaction.
     * @param minOut Per leg minimum outputs, quoted client side. Any leg that
     *        misses its minimum reverts the whole basket, because a partial
     *        basket is wrong weights with no route back and nothing for the
     *        rebalancer to target.
     */
    function buy(uint256 id, uint256 amountIn, uint256[] calldata minOut) external whenLive {
        _buy(id, amountIn, minOut);
    }

    /**
     * @notice Publish a basket and buy it in the same transaction.
     *
     * @dev The creator putting money behind their own idea at launch, which is
     *      the mechanic every launchpad has and the reason a new listing is not
     *      just an empty row. It also means the basket arrives on the
     *      leaderboard with real volume rather than waiting for a stranger.
     */
    function createAndBuy(
        address input,
        Leg[] calldata legs,
        uint16 creatorFeeBps,
        string calldata name,
        string calldata symbol,
        string calldata description,
        string memory image,
        uint256 amountIn,
        uint256[] calldata minOut
    ) public whenLive returns (uint256 id) {
        id = createIndex(input, legs, creatorFeeBps, name, symbol, description, image);
        _buy(id, amountIn, minOut);
    }

    /**
     * The shape this had before pictures existed, kept rather than replaced.
     *
     * @dev Adding `image` changed the selector, and a router deployed before
     *      that has no fallback, so a call in the new shape reverts with
     *      nothing attached. Keeping the old arity means the site can publish
     *      against either router with one build, and it is the same overload
     *      pair `createIndex` already carries for `BasketCurve`'s sake. The
     *      trap both share is that viem picks between overloads on arity, so
     *      the caller decides which by how many arguments it passes and nothing
     *      warns when it picks the one that drops the picture.
     */
    function createAndBuy(
        address input,
        Leg[] calldata legs,
        uint16 creatorFeeBps,
        string calldata name,
        string calldata symbol,
        string calldata description,
        uint256 amountIn,
        uint256[] calldata minOut
    ) external returns (uint256 id) {
        return createAndBuy(input, legs, creatorFeeBps, name, symbol, description, "", amountIn, minOut);
    }

    /**
     * A picture link is optional, and when it is there it is a link.
     *
     * @dev The same two prefixes and the same bound as `BasketFactory`, on
     *      purpose: a motif and a basket token are read by the same grid, and a
     *      rule that differed between them would be a rule somebody has to
     *      remember which side they are on.
     *
     *      This is everything a contract can usefully say about a url. It
     *      cannot fetch one and cannot tell an image from anything else, so it
     *      refuses the shapes that are certainly not links and leaves the rest
     *      to the reader. `http://` is refused because a browser will not load
     *      one on an https page, so recording it writes a dead link into a log
     *      that can never be edited. `javascript:` and `data:` are the ones
     *      worth naming, because a site that renders whatever the log says
     *      would otherwise render whatever a stranger typed.
     *
     *      `memory` rather than `calldata` because the six argument overload
     *      passes a literal, which has nowhere in calldata to be. That costs a
     *      byte by byte compare instead of a slice, once, on a launch.
     */
    function _checkImage(string memory image) private pure {
        bytes memory b = bytes(image);
        if (b.length == 0) return;
        if (b.length > MAX_IMAGE_BYTES) revert BadMetadata("image over 200 bytes");
        if (_startsWith(b, "https://") || _startsWith(b, "ipfs://")) return;
        revert BadMetadata("image must be https:// or ipfs://");
    }

    function _startsWith(bytes memory b, bytes memory prefix) private pure returns (bool) {
        if (b.length < prefix.length) return false;
        for (uint256 i; i < prefix.length; ++i) {
            if (b[i] != prefix[i]) return false;
        }
        return true;
    }

    function _buy(uint256 id, uint256 amountIn, uint256[] calldata minOut) internal nonReentrant {
        _underCap(amountIn);

        Index storage ix = _indexes[id];
        uint256 legCount = ix.legs.length;
        if (minOut.length != legCount) revert MinimumsLengthMismatch();
        if (amountIn > uint256(type(int256).max)) revert AmountTooLarge();

        address input = ix.input;
        input.safeTransferFrom(msg.sender, address(this), amountIn);

        // Fees leave in the currency they arrived in, in this same transaction,
        // so no fee balance ever accrues here and there is nothing to drain.
        uint256 creatorFee = (amountIn * ix.creatorFeeBps) / BPS;
        uint256 protocolFee = (amountIn * PROTOCOL_FEE_BPS) / BPS;
        if (creatorFee != 0) input.safeTransfer(ix.creator, creatorFee);
        if (protocolFee != 0) input.safeTransfer(protocolFeeTo, protocolFee);
        uint256 toSpend = amountIn - creatorFee - protocolFee;

        emit Bought(id, msg.sender, amountIn, creatorFee, protocolFee);

        uint256 spent;
        for (uint256 i; i < legCount; ++i) {
            Leg storage leg = ix.legs[i];
            // The last leg takes the remainder, so rounding never strands dust
            // in this contract where it would sit unclaimable.
            uint256 legIn = i == legCount - 1 ? toSpend - spent : (toSpend * leg.weightBps) / BPS;
            spent += legIn;
            if (legIn == 0) continue;

            address pool = factory.getPool(input, leg.token, leg.fee);
            if (pool == address(0)) revert NoPoolForLeg(leg.token, leg.fee);

            bool zeroForOne = input < leg.token;
            // The input is already here, so this contract pays the pool itself.
            _owedCap = legIn;
            (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
                msg.sender, // output goes straight to the buyer, never through here
                zeroForOne,
                int256(legIn), // positive is exact input
                zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                abi.encode(input, leg.token, leg.fee, address(this))
            );

            // A negative delta is what the pool paid out.
            int256 out = zeroForOne ? -amount1 : -amount0;
            uint256 received = out > 0 ? uint256(out) : 0;
            if (received < minOut[i]) revert InsufficientOutput(i, received, minOut[i]);
        }

        _owedCap = 0;
    }

    // ------------------------------------------------------------------- sell

    /**
     * @notice Sell legs of an index back to its quote asset in one transaction.
     *
     * @param amounts How much of each leg to sell, in that token's own
     *        decimals, positionally matching `legsOf(id)`. A zero skips the leg.
     * @param minOut Per leg minimum proceeds, quoted client side, in the index's
     *        quote asset.
     * @return totalOut Everything the seller received, which is also what the
     *         guardian's cap is measured against.
     *
     * @dev **Why amounts rather than a percentage.** The obvious signature is
     *      "sell 25% of this basket", and it is wrong. Leg tokens are ordinary
     *      ERC20s in the seller's own wallet, and somebody who bought three
     *      baskets containing NVDA holds one NVDA balance, not three. A contract
     *      that read `balanceOf` and sold a quarter of it would be selling a
     *      quarter of everything they own of that ticker. Working out which
     *      tokens belong to which basket is the caller's business, because only
     *      the caller can know. The site does that arithmetic and shows it
     *      before anyone signs.
     *
     *      **No fee on the way out.** The creator fee and the protocol fee are
     *      charged on the buy and nowhere else. An exit fee would mean a creator
     *      earns when people leave, which is the wrong incentive to encode, and
     *      it would make "you can always leave" a claim with a footnote. Selling
     *      costs the pool fee and the gas, the same as selling the token
     *      anywhere else.
     *
     *      **Nothing is held.** The buy path pulls the quote asset here first
     *      because the fees are taken out of it. A sell has no fees, so there is
     *      nothing to take out, and the tokens go straight from the seller's
     *      wallet to the pool inside the swap callback. Proceeds go straight
     *      back to the seller. This contract never holds either side.
     *
     *      **All or nothing**, like the buy. A leg that misses its minimum
     *      reverts the whole sell rather than leaving somebody half out of a
     *      basket at a price they did not agree to.
     */
    function sell(uint256 id, uint256[] calldata amounts, uint256[] calldata minOut)
        external
        whenLive
        nonReentrant
        returns (uint256 totalOut)
    {
        Index storage ix = _indexes[id];
        uint256 legCount = ix.legs.length;
        if (amounts.length != legCount) revert AmountsLengthMismatch();
        if (minOut.length != legCount) revert MinimumsLengthMismatch();

        address input = ix.input;
        uint256 sold;

        for (uint256 i; i < legCount; ++i) {
            uint256 amountIn = amounts[i];
            if (amountIn == 0) continue;
            if (amountIn > uint256(type(int256).max)) revert AmountTooLarge();

            Leg storage leg = ix.legs[i];
            address pool = factory.getPool(input, leg.token, leg.fee);
            if (pool == address(0)) revert NoPoolForLeg(leg.token, leg.fee);

            // Selling the leg for the quote asset, so the direction is the
            // mirror of the buy.
            bool zeroForOne = leg.token < input;
            _owedCap = amountIn;
            (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
                msg.sender, // proceeds go straight to the seller
                zeroForOne,
                int256(amountIn),
                zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                abi.encode(leg.token, input, leg.fee, msg.sender)
            );

            int256 out = zeroForOne ? -amount1 : -amount0;
            uint256 received = out > 0 ? uint256(out) : 0;
            if (received < minOut[i]) revert InsufficientOutput(i, received, minOut[i]);
            totalOut += received;
            ++sold;
        }

        _owedCap = 0;
        if (sold == 0) revert NothingToSell();
        // The cap is denominated in the quote asset, and the amounts above are
        // in the legs' own decimals. Measure the proceeds, not the input, or an
        // 18 decimal share sale fails a cap written in 6 decimal dollars.
        _underCap(totalOut);

        emit Sold(id, msg.sender, sold, totalOut);
    }

    /**
     * @notice Called by a V3 pool mid swap to collect the input side.
     *
     * @dev Three checks make this safe. `_owedCap` must be set, so an arbitrary
     *      caller cannot reach this outside a swap this contract started. The
     *      caller must be the pool the real factory returns for the decoded
     *      pair, so a contract that merely claims to be a pool cannot drain an
     *      approval. And the amount is bounded by the leg being swapped, so a
     *      pool that is genuine but hostile still cannot take more than the
     *      swap it was asked for.
     *
     *      `payer` comes from data this contract encoded and the pool handed
     *      back untouched. It is this contract on a buy, where the quote asset
     *      was pulled in to take fees from, and the seller on a sell, where
     *      nothing is pulled in at all.
     */
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        uint256 cap = _owedCap;
        if (cap == 0) revert UnknownCaller();

        (address tokenIn, address tokenOut, uint24 fee, address payer) =
            abi.decode(data, (address, address, uint24, address));
        if (msg.sender != factory.getPool(tokenIn, tokenOut, fee)) revert UnknownCaller();

        // A positive delta is what this contract owes the pool.
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        if (owed > cap) revert PoolWantsTooMuch(owed, cap);

        if (payer == address(this)) tokenIn.safeTransfer(msg.sender, owed);
        else tokenIn.safeTransferFrom(payer, msg.sender, owed);
    }
}
