// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BasketRouter} from "./BasketRouter.sol";
import {BasketVault} from "./BasketVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeTransfer} from "./BasketRouter.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

interface IUniswapV3FactoryFull {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address);
}

interface IUniswapV3PoolMint {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function initialize(uint160 sqrtPriceX96) external;
    function tickSpacing() external view returns (int24);
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function burn(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256, uint256);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128, uint128);
}

/**
 * @title BasketCurve
 * @notice The part that makes this a launchpad rather than a vault: a bonding
 *         curve that sells a basket's token before the basket exists, then
 *         spends the raise on the real thing.
 *
 * @dev **Why a curve at all.** Nobody has to provide liquidity, price rises
 *      deterministically from the first buy, and being early is worth
 *      something. That is the experience people already understand from
 *      pump.fun and par, and reproducing it is the point rather than an
 *      accident. What is different is what happens at the end.
 *
 *      **The maths.** Constant product against virtual reserves, which is the
 *      standard formulation and is chosen here because it is the one that has
 *      been read by the most eyes:
 *
 *          k            = virtualUsdg * VIRTUAL_TOKENS
 *          usdgReserve  = virtualUsdg + raised
 *          tokenReserve = VIRTUAL_TOKENS - sold
 *
 *      Buying moves usdg in and tokens out along that curve; selling reverses
 *      it. The constants are picked so that selling exactly `CURVE_SUPPLY`
 *      raises exactly `threshold`, which is what makes graduation land on a
 *      round number rather than whenever somebody happens to overshoot.
 *
 *      **Graduation buys through the router.** It does not reimplement swapping.
 *      `BasketRouter.buy` already splits an amount across legs at their weights,
 *      bounds each leg's output, and delivers to `msg.sender`, and it is the
 *      most tested path in this repo. Reusing it means graduation inherits the
 *      per leg minimums, the all or nothing revert, and the fee split, and adds
 *      no new swap code to audit.
 *
 *      **All or nothing, deliberately.** If any leg cannot fill above its
 *      minimum the whole graduation reverts and the curve stays open. That is
 *      the same rule `buy` already applies and for the same reason: a partially
 *      graduated basket is wrong weights with no route back, and it would be
 *      backing a token that holders cannot value.
 */
contract BasketCurve is ReentrancyGuardTransient {
    using SafeTransfer for address;

    // --------------------------------------------------------------- shape

    /**
     * What the curve sells.
     *
     * There is deliberately no second tranche held back for a pool yet. Seeding
     * one needs a share of the raise kept in USDG to pair against it, and that
     * share is a decision nobody has made. Minting supply for it now would back
     * it with nothing and quietly dilute every redeemer, because the vault
     * divides its holdings across whatever supply exists. Only what was bought
     * is minted, so backing per token is exact at every point.
     *
     * When the pool step lands, the split of the raise and the LP tranche are
     * decided together, inside the one graduation the vault permits.
     */
    uint256 public constant CURVE_SUPPLY = 750_000_000e18;

    /**
     * Virtual reserves.
     *
     * @dev Chosen so that selling the whole `CURVE_SUPPLY` raises exactly
     *      `threshold`: VIRTUAL_TOKENS is four thirds of CURVE_SUPPLY and
     *      `virtualUsdg` a third of the threshold, which satisfies
     *
     *          virtualUsdg * VIRTUAL_TOKENS
     *              = (virtualUsdg + threshold) * (VIRTUAL_TOKENS - CURVE_SUPPLY)
     *
     *      because the token reserve ends at a quarter of where it started
     *      while the usdg reserve quadruples. Both sides are k, so the curve
     *      closes on the threshold rather than near it.
     *
     *      **The third is rounded up, and the direction is load bearing.**
     *      Supply runs out at `3 * virtualUsdg` raised. Rounding down makes
     *      that strictly less than a threshold not divisible by three, so the
     *      last tokens are unbuyable while `raised < threshold`: `buy` reverts
     *      with `SupplyExhausted`, `graduate` reverts with `NotReady`, and the
     *      money already in is stuck behind a threshold nobody can reach except
     *      by selling back out. Rounding up costs at most two millionths of a
     *      dollar of overshoot and cannot deadlock.
     */
    uint256 public constant VIRTUAL_TOKENS = 1_000_000_000e18;
    uint256 public immutable virtualUsdg;

    /**
     * The share of the raise that seeds the pool instead of buying stock.
     *
     * @dev **This is the one number where the two halves of the product pull
     *      against each other, so it is a constant rather than something a
     *      creator picks.** Every basis point here is a basis point of backing
     *      the holders do not get, and every basis point withheld from here is
     *      liquidity the token does not have. A creator choosing it would be
     *      choosing how thin to make somebody else's floor.
     *
     *      At 20%: eighty cents of every dollar buys real stock, and the floor
     *      lands near 76% of what a curve buyer paid, because the LP tranche is
     *      minted against the same legs and dilutes them. That number is
     *      measured in `test/Curve.t.sol` rather than asserted here, and it is
     *      the honest headline: **your downside is roughly three quarters of
     *      what you paid, in real equities, rather than zero.** par and
     *      pump.fun put effectively the whole raise into the pool and the
     *      corresponding number for them is zero.
     *
     *      Raising it buys depth and cuts the floor. Lowering it does the
     *      reverse, and at zero the token has nowhere to trade but redemption,
     *      which is where this contract started and why it was not enough.
     */
    uint16 public constant LP_BPS = 2000;
    uint16 internal constant BPS = 10_000;

    /**
     * The fee tier the basket token's own pool is created at.
     *
     * @dev 0.3%, the tier the volatile stock pools on this chain already use.
     *      A basket of equities is not a stablecoin pair and does not want 0.05%.
     */
    uint24 public constant LP_FEE = 3000;

    /**
     * Extra supply minted at graduation purely so the corrective pool swap has
     * something to sell, and burned again in the same transaction.
     *
     * @dev See `_repricePool` for why the swap exists. It can only ever need to
     *      *sell* token, and it can only need to sell into liquidity a stranger
     *      parked in the pool before graduation. Whatever it sells is paid for
     *      in usdg at a price at or above the curve's own closing price, which
     *      is well above the backing the token graduates with, so the stranger
     *      pays more than the tokens are worth and the raise ends up larger.
     *      The only way to stop a graduation here is to keep buying at that
     *      price until this runs out.
     *
     *      Sized at the whole curve supply, which on a ten thousand dollar
     *      raise is about forty thousand dollars of buying at a loss. It costs
     *      nothing to be generous: what the swap does not consume is burned by
     *      `BasketVault.burnUnused` before the transaction ends, so this never
     *      appears in the supply the token actually graduates with.
     */
    uint256 public constant REPRICE_SUPPLY = CURVE_SUPPLY;

    /// USDG raised at which graduation becomes possible. 6 decimals, like USDG.
    uint256 public immutable threshold;

    BasketRouter public immutable router;

    /**
     * Who launched this, and the only address the contract ever pays.
     *
     * @dev It receives the router's creator fee, forwarded at graduation, and
     *      nothing else. It cannot mint, cannot touch the vault, cannot reach
     *      the pool position and cannot change any number here. There is no
     *      setter because there is nothing a new value could be used for.
     */
    address public immutable creator;

    /**
     * The token, and the vault behind it.
     *
     * @dev Deployed from here rather than passed in, which is worth the extra
     *      bytecode. A vault handed in as an argument can have legs that are
     *      not the index's legs, or a minter that is not this curve, and both
     *      of those are silent: the curve raises money, graduates, buys the
     *      index, and hands the legs to a vault whose holders are redeeming
     *      against something else. Constructing it here makes the pairing
     *      structural instead of a deployment step somebody has to get right.
     */
    BasketVault public immutable vault;

    /**
     * What the curve raises in, read from the index rather than supplied.
     *
     * @dev Same reasoning. `router.buy` spends the index's own quote asset, so
     *      a curve raising anything else would collect one currency and be
     *      unable to spend it.
     */
    address public immutable usdg;

    /// The index in the router whose weights graduation buys at.
    uint256 public immutable indexId;

    // --------------------------------------------------------------- state

    uint256 public raised;
    uint256 public sold;
    bool public graduated;

    /// The token's own USDG pool, created and priced at construction. See `_openPool`.
    address public immutable pool;
    bool public immutable usdgIsToken0;

    /**
     * How much the pool being minted into right now may pull, and nothing at
     * all when zero.
     *
     * @dev The same one variable doing two jobs as `BasketRouter._owedCap`, and
     *      for the same reason: it is what stops an arbitrary caller reaching
     *      the mint callback, and it bounds what a real pool can take if it
     *      asks for more than the position it is minting.
     */
    bool private _minting;

    /**
     * True only while `_repricePool` is inside the pool's `swap`, and the only
     * thing that lets `uniswapV3SwapCallback` pay anything at all.
     */
    bool private _repricing;

    mapping(address => uint256) public balanceOf;

    event Bought(address indexed buyer, uint256 usdgIn, uint256 tokensOut, uint256 raised);
    event Sold(address indexed seller, uint256 tokensIn, uint256 usdgOut, uint256 raised);
    event Graduated(uint256 spent, uint256 supply);
    event PoolSeeded(address indexed pool, uint128 liquidity, uint256 usdgIn, uint256 tokensIn);
    event FeesCollected(address indexed creator, uint256 usdgOut, uint256 tokenOut);

    error AlreadyGraduated();
    error NotReady(uint256 raised, uint256 needed);
    error ZeroAmount();
    error SupplyExhausted();
    error TooLittleOut(uint256 got, uint256 wanted);
    error InsufficientBalance();
    error NotGraduated();
    error UnknownCaller();
    error NoPool();
    error PriceOutOfRange();
    error LiquidityTooLarge();
    error RepriceFailed(uint160 got, uint160 wanted);
    error PoolWantsQuote();
    error ThresholdOverCap(uint256 threshold, uint256 cap);
    error ZeroAddress();

    /**
     * Everything a launch decides, in one struct.
     *
     * @dev A struct rather than nine arguments because `via_ir` or not, a
     *      constructor this wide is where somebody eventually transposes two
     *      strings and ships a basket called AICORE with the symbol "AI Core".
     */
    struct Launch {
        BasketRouter router;
        /// Who launched it, and who the router's creator fee is forwarded to.
        address creator;
        /// What the basket is priced and raised in. USDG for everything shipped so far.
        address quote;
        BasketRouter.Leg[] legs;
        uint16 creatorFeeBps;
        uint256 threshold;
        string name;
        string symbol;
        string description;
    }

    /**
     * @dev **The index is published from here, rather than passed in.** The
     *      same argument as the vault below, plus one that only applies to the
     *      index: `BasketRouter` records `msg.sender` as the creator and pays
     *      that address the creator fee, and the router is deployed and cannot
     *      be changed. So whoever calls `createIndex` collects the fee. A
     *      factory calling it would collect every creator's fee into itself,
     *      and a two step launch, publish then attach a curve, leaves the
     *      attach open to anyone: a stranger can register the curve for your
     *      index, with their name, symbol and threshold, before you do.
     *
     *      Publishing it here makes the curve the router's creator, which is
     *      why `graduate` forwards the fee on to `creator` at the end. It also
     *      makes the index, the vault, the token and the pool one indivisible
     *      thing that no deployment step can get wrong.
     */
    constructor(Launch memory p) {
        if (p.threshold == 0) revert ZeroAmount();
        router = p.router;
        creator = p.creator;
        threshold = p.threshold;
        // Rounded up. See VIRTUAL_TOKENS: rounding down can strand the raise.
        virtualUsdg = (p.threshold + 2) / 3;
        usdg = p.quote;

        // Reverts on an unpriced pair, a fee over the cap, weights that do not
        // sum, or metadata out of bounds, so a curve cannot exist for a basket
        // the router would refuse.
        indexId = p.router.createIndex(p.quote, p.legs, p.creatorFeeBps, p.name, p.symbol, p.description);

        // Graduation spends the raise through `router.buy`, which is subject to
        // `Guarded.maxNotional` like any other buy. A curve whose threshold is
        // over that cap raises money it can never spend: every graduation
        // reverts with `OverCap` and the only way out is everybody selling back
        // down the curve. Checked here so that fails at launch, loudly, rather
        // than at the finish line. It is a launch time check and not a promise:
        // the guardian can lower the cap afterwards, and no contract can stop
        // that.
        uint256 cap = p.router.maxNotional();
        if (cap != 0 && p.threshold > cap) revert ThresholdOverCap(p.threshold, cap);

        address[] memory tokens = new address[](p.legs.length);
        for (uint256 i; i < p.legs.length; ++i) {
            tokens[i] = p.legs[i].token;
        }
        BasketVault v = new BasketVault(p.name, p.symbol, tokens, address(this));
        vault = v;

        (pool, usdgIsToken0) = _openPool(address(p.router.factory()), address(v));
    }

    /**
     * Create the token's own USDG pool and price it, here, at deployment.
     *
     * @dev **Why not at graduation, where the liquidity actually goes.**
     *      `initialize` is permissionless and a pool can only be priced once.
     *      If the pool were still unpriced at graduation, anybody could create
     *      it first and initialize it at a price of their choosing, and
     *      graduation would then either have to seed at that price, which mints
     *      the LP tranche against a lie, or revert, which lets a stranger block
     *      every graduation for free. Doing it in the constructor closes that:
     *      the vault's address does not exist until this transaction, so the
     *      first and only `initialize` is this one.
     *
     *      **It does not close the price, and that distinction is the whole of
     *      `_repricePool`.** A pool with no liquidity in it still has a
     *      `swap`, and a swap through no liquidity walks the price to whatever
     *      `sqrtPriceLimitX96` asks for, moves no tokens, and costs nothing but
     *      gas. So between this constructor and graduation the price here is a
     *      number any stranger can set. Nothing may read it and believe it.
     *
     *      The price used is the one the curve arrives at when the raise
     *      completes, which is fixed by the constants rather than by how people
     *      buy: `(virtualUsdg + threshold)` of usdg against
     *      `(VIRTUAL_TOKENS - CURVE_SUPPLY)` of token. Rounding during the raise
     *      moves the real close by a hair and graduation seeds at whatever the
     *      pool then says, so the two never have to agree exactly.
     *
     *      Seeding at the curve's closing price, rather than at what the backing
     *      is worth, is deliberate. The closing price is four times the average
     *      the curve sold at, so the token opens well clear of its floor. Seeding
     *      at the backing instead would open the market exactly on the floor,
     *      where the first sale takes it below and the arbitrage that is meant
     *      to be a backstop becomes the opening trade.
     */
    function _openPool(address factory_, address token) private returns (address p, bool usdgFirst) {
        address quote = usdg;
        usdgFirst = quote < token;

        p = IUniswapV3FactoryFull(factory_).getPool(quote, token, LP_FEE);
        if (p == address(0)) p = IUniswapV3FactoryFull(factory_).createPool(quote, token, LP_FEE);
        if (p == address(0)) revert NoPool();

        (uint160 existing,,,,,,) = IUniswapV3PoolMint(p).slot0();
        if (existing == 0) {
            IUniswapV3PoolMint(p).initialize(_sqrtPriceAtClose(usdgFirst));
        }
    }

    /**
     * `sqrtPriceX96` for the price the curve closes at.
     *
     * @dev Q64.96 of the token1/token0 ratio, so which way up it goes depends on
     *      how the two addresses happen to sort. The square root is taken over
     *      the ratio already shifted by 2^192, because taking it of the ratio
     *      first would floor a number smaller than one to zero.
     */
    function _sqrtPriceAtClose(bool usdgFirst) private view returns (uint160) {
        uint256 usdgAtClose = virtualUsdg + threshold;
        uint256 tokensAtClose = VIRTUAL_TOKENS - CURVE_SUPPLY;
        return _sqrtPriceX96(usdgFirst ? tokensAtClose : usdgAtClose, usdgFirst ? usdgAtClose : tokensAtClose);
    }

    /**
     * sqrt(numerator / denominator) in Q64.96.
     *
     * @dev Range checked rather than cast and hoped for. A silent truncation
     *      here would price the pool at a number nobody chose, once and
     *      permanently, and `initialize` would accept it.
     */
    function _sqrtPriceX96(uint256 numerator, uint256 denominator) private pure returns (uint160) {
        uint256 root = Math.sqrt(FullMath.mulDiv(numerator, 1 << 192, denominator));
        if (root < TickMath.MIN_SQRT_PRICE || root >= TickMath.MAX_SQRT_PRICE) revert PriceOutOfRange();
        return uint160(root);
    }

    // ----------------------------------------------------------- the curve

    function usdgReserve() public view returns (uint256) {
        return virtualUsdg + raised;
    }

    function tokenReserve() public view returns (uint256) {
        return VIRTUAL_TOKENS - sold;
    }

    /**
     * @dev **Both sides round the reserve up, which rounds the trader down.**
     *      This is not a stylistic preference, it is the difference between a
     *      curve and a faucet.
     *
     *      Flooring the new reserve is the obvious way to write it and it is
     *      wrong in both directions at once: flooring `newT` hands the buyer
     *      more tokens than the curve exactly owes, and flooring `newU` hands
     *      the seller more usdg. Put together, buying and immediately selling
     *      back returns *at least* what it cost, every time, so the round trip
     *      is free to attempt and pays out of money other buyers put in.
     *      `test/Curve.t.sol` asserts the round trip loses, and it fails
     *      against the floored version.
     *
     *      Rounding the reserve up leaves the dust inside the curve, where it
     *      belongs to whoever is still holding.
     */
    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return (a + b - 1) / b;
    }

    /// What `usdgIn` buys right now, before it is spent.
    function quoteBuy(uint256 usdgIn) public view returns (uint256) {
        if (usdgIn == 0) return 0;
        uint256 u = usdgReserve();
        uint256 t = tokenReserve();
        uint256 newT = _ceilDiv(u * t, u + usdgIn);
        return newT >= t ? 0 : t - newT;
    }

    /// What `tokensIn` returns right now, before it is sold.
    function quoteSell(uint256 tokensIn) public view returns (uint256) {
        if (tokensIn == 0) return 0;
        uint256 u = usdgReserve();
        uint256 t = tokenReserve();
        uint256 newU = _ceilDiv(u * t, t + tokensIn);
        return newU >= u ? 0 : u - newU;
    }

    /**
     * Buy along the curve.
     *
     * @dev `minOut` is the caller's own bound, the same shape of protection the
     *      router gives on a basket buy: the curve is deterministic but the
     *      state it is read against can move between quoting and mining.
     */
    function buy(uint256 usdgIn, uint256 minOut) external nonReentrant returns (uint256 out) {
        return _buy(msg.sender, usdgIn, minOut);
    }

    /**
     * Buy for somebody else, paid for by the caller.
     *
     * @dev This exists so a launch and the creator's own first buy can be one
     *      transaction. `BasketFactory.launchAndBuy` deploys the curve and is
     *      therefore the only caller in a position to buy in the same
     *      transaction, and a plain `buy` would credit the factory, which has
     *      no function that could ever move the position on again.
     *
     *      It grants nothing. The caller pays and the recipient is credited, so
     *      the worst a stranger can do with it is give somebody tokens. There
     *      is deliberately no allowance, no operator and no transfer here: a
     *      curve position is not transferable, and this does not make it one.
     */
    function buyFor(address to, uint256 usdgIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (to == address(0)) revert ZeroAddress();
        return _buy(to, usdgIn, minOut);
    }

    function _buy(address to, uint256 usdgIn, uint256 minOut) private returns (uint256 out) {
        if (graduated) revert AlreadyGraduated();
        if (usdgIn == 0) revert ZeroAmount();

        out = quoteBuy(usdgIn);
        if (out == 0) revert ZeroAmount();
        if (sold + out > CURVE_SUPPLY) revert SupplyExhausted();
        if (out < minOut) revert TooLittleOut(out, minOut);

        // Paid by whoever called, credited to whoever they named. On the plain
        // `buy` those are the same address.
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        raised += usdgIn;
        sold += out;
        balanceOf[to] += out;

        emit Bought(to, usdgIn, out, raised);
    }

    /**
     * Sell back along the curve, before graduation only.
     *
     * @dev Afterwards the raise has been spent on stock and there is nothing
     *      here to pay with. Exiting then means selling the token, or redeeming
     *      it against the vault, which is the point of the vault.
     */
    function sell(uint256 tokensIn, uint256 minOut) external nonReentrant returns (uint256 out) {
        if (graduated) revert AlreadyGraduated();
        if (tokensIn == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < tokensIn) revert InsufficientBalance();

        out = quoteSell(tokensIn);
        // A sell too small to move the reserve by one unit would otherwise burn
        // the position for nothing.
        if (out == 0) revert ZeroAmount();
        if (out < minOut) revert TooLittleOut(out, minOut);

        balanceOf[msg.sender] -= tokensIn;
        sold -= tokensIn;
        raised -= out;

        usdg.safeTransfer(msg.sender, out);
        emit Sold(msg.sender, tokensIn, out, raised);
    }

    // -------------------------------------------------------- graduation

    /**
     * Spend the raise on the real basket and mint the token against it.
     *
     * @dev Permissionless on purpose. Anybody may call it once the threshold is
     *      met, so graduation does not wait on the creator being awake or
     *      willing. There is nothing here for a caller to extract: the legs go
     *      to the vault and the supply is minted to the vault's holders.
     *
     *      `minOut` is the caller's per leg bound, passed straight to the
     *      router. This is the largest single trade the system ever makes, five
     *      market orders in one block against pools it moves as it goes, so the
     *      bound is not decoration. Passing zeroes graduates at any price and is
     *      the caller's choice to make badly.
     *
     *      If any leg cannot fill, the router reverts and so does this. The
     *      curve stays open and somebody can try again when the pool is deeper.
     */
    function graduate(uint256[] calldata minOut) external nonReentrant {
        if (graduated) revert AlreadyGraduated();
        if (raised < threshold) revert NotReady(raised, threshold);

        graduated = true;
        uint256 spend = raised;

        // The pool is seeded first, and the stock is bought with whatever is
        // left rather than with a second precomputed share. The pool rounds its
        // own amounts up and can ask for a unit either side of the target, and
        // usdg left over from that would otherwise sit here unclaimable. Taking
        // the remainder as the stock budget means the arithmetic cannot strand
        // anything: every unit either seeds the pool or buys a leg.
        _seedPool((spend * LP_BPS) / BPS);
        spend = IERC20(usdg).balanceOf(address(this));

        // The router pulls with transferFrom and delivers the legs to msg.sender,
        // which is this contract. forceApprove rather than approve because the
        // leg and quote tokens here are ordinary third party ERC20s and some do
        // not return a bool.
        SafeERC20.forceApprove(IERC20(usdg), address(router), spend);
        // Guarded's maxNotional applies to this like any other buy, so a chain
        // where the router is size capped needs a threshold under that cap.
        // The constructor checks the threshold against it, which covers every
        // ordinary case, and cannot cover two: the guardian may lower the cap
        // afterwards, and `spend` here is the raise plus whatever the corrective
        // swap brought in, which a stranger can inflate by standing in the way
        // of the reprice. Both revert rather than misprice, both are the
        // guardian raising a number, and the second costs the stranger more
        // than the raise is worth.
        router.buy(indexId, spend, minOut);

        // Everything the router delivered belongs to the vault.
        address[] memory legs = vault.legs();
        uint256 n = legs.length;
        for (uint256 i; i < n; ++i) {
            uint256 held = IERC20(legs[i]).balanceOf(address(this));
            if (held != 0) legs[i].safeTransfer(address(vault), held);
        }

        // The router pays the creator fee to the index's creator, which is this
        // contract, so the usdg left here afterwards is exactly that fee. It is
        // forwarded rather than kept, because a curve holding money is a curve
        // somebody has to be trusted about.
        uint256 fee = IERC20(usdg).balanceOf(address(this));
        if (fee != 0) usdg.safeTransfer(creator, fee);

        emit Graduated(spend, vault.totalSupply());
    }

    /**
     * Put `lpUsdg` and a matching tranche of token into the pool, permanently.
     *
     * @dev **What "burned" means here.** There is no position NFT and nothing is
     *      sent to the zero address. The position is minted with this contract
     *      as its owner, and this contract has no way to reduce its liquidity:
     *      the only `burn` anywhere in this file is the `burn(lower, upper, 0)`
     *      inside `collectFees`, which by definition removes nothing and exists
     *      only to make fees collectable. A locked position on a timer
     *      eventually unlocks; this cannot. See `collectFees` for the exact
     *      argument, and `test/Curve.t.sol` for the measurement of it.
     *
     *      **Full range**, from the lowest usable tick to the highest. It is
     *      capital inefficient and that is the price of never needing anybody to
     *      manage it: a concentrated range can be left behind by the price, and
     *      a position nobody can rebalance that has fallen out of range is not
     *      liquidity, it is a one sided wall. Full range is thin and always
     *      there.
     *
     *      **The supply is minted here**, once, for the curve's buyers and the
     *      pool together. The token amount is computed with the same function
     *      and the same rounding the pool itself uses, so the callback pays
     *      exactly what was minted for it and nothing is left over.
     *
     *      **Every number here comes from the curve's own constants, never from
     *      `slot0`.** The pool price is a number a stranger can set for free
     *      before graduation, and an earlier version of this function sized the
     *      tranche from it. Setting the price a hundred times too low made
     *      `lpUsdg` buy a hundred times the tokens, so the tranche went from 5%
     *      of the supply to 83% of it and the backing behind every curve buyer
     *      fell from 95% to 17%. Setting it far too high did the reverse and
     *      rounded the tranche to zero, which reverted graduation and blocked it
     *      for nothing. The tranche is now fixed at the curve's closing price
     *      and the pool is walked to that price first, so neither is reachable.
     */
    function _seedPool(uint256 lpUsdg) private {
        uint256 lpTokens;
        address p = pool;
        uint160 target = _sqrtPriceAtClose(usdgIsToken0);

        (int24 tickLower, int24 tickUpper) = _range();
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);

        // Fix the usdg side at the budget and let the token side follow, rather
        // than the other way round. The budget is the number that was decided;
        // the token amount is whatever that budget buys at the curve's closing
        // price, which is a constant of this contract rather than anything the
        // pool reports.
        uint128 liquidity;
        if (usdgIsToken0) {
            liquidity = _liquidityForAmount0(target, sqrtUpper, lpUsdg);
            lpTokens = SqrtPriceMath.getAmount1Delta(sqrtLower, target, liquidity, true);
        } else {
            liquidity = _liquidityForAmount1(sqrtLower, target, lpUsdg);
            lpTokens = SqrtPriceMath.getAmount0Delta(target, sqrtUpper, liquidity, true);
        }
        if (liquidity == 0 || lpTokens == 0) revert ZeroAmount();

        // One mint, for the curve's buyers, for the pool, and for whatever the
        // reprice below has to sell. The vault allows exactly one, which is why
        // the pool tranche cannot be an afterthought and why the reprice budget
        // has to be minted before anybody knows whether it is needed.
        vault.graduate(address(this), sold + lpTokens + REPRICE_SUPPLY);

        _repricePool(target);

        _minting = true;
        (uint256 amount0, uint256 amount1) =
            IUniswapV3PoolMint(p).mint(address(this), tickLower, tickUpper, liquidity, "");
        _minting = false;

        // What is left is the unspent reprice budget. The curve keeps exactly
        // `sold`, which is what its buyers `claim`, and the rest stops existing.
        uint256 unused = IERC20(address(vault)).balanceOf(address(this)) - sold;
        vault.burnUnused(unused);

        emit PoolSeeded(p, liquidity, usdgIsToken0 ? amount0 : amount1, usdgIsToken0 ? amount1 : amount0);
    }

    /**
     * Walk the pool to `target` before anything is minted into it.
     *
     * @dev **Why this is needed.** `initialize` happens in the constructor, so
     *      the pool is priced from the first block and nobody else can price
     *      it. But an unliquid V3 pool still has a `swap`, and a swap through
     *      zero liquidity moves the price to `sqrtPriceLimitX96` exactly, moves
     *      no tokens, and costs nothing. Between launch and graduation anybody
     *      can therefore put this pool at any price they like, repeatedly, for
     *      the price of the gas. `_seedPool` used to read that price. See its
     *      note for what that was worth.
     *
     *      **Why the walk always lands.** The token does not exist until the
     *      mint above: total supply is zero for the whole life of the curve. A
     *      Uniswap position that requires only the token is one whose range sits
     *      entirely on the far side of the price, and it cannot be opened
     *      because nobody has a token to open it with. So the only foreign
     *      liquidity that can exist in this pool before graduation is
     *      usdg only, which sits below the price in usdg per token, and the only
     *      direction this walk can meet it in is the one where the token gets
     *      cheaper, which is the direction where *we* are the seller. That is
     *      what `REPRICE_SUPPLY` is for. In the other direction there is
     *      provably nothing to cross, so the callback refuses to pay usdg at
     *      all rather than trusting that.
     *
     *      **Whoever we do meet pays for the privilege.** Every unit sold on the
     *      way down fills between the stranger's price and the curve's closing
     *      price, so all of it is at or above the closing price, which is
     *      already well above the backing the token graduates with. Their usdg
     *      lands here and buys stock with the rest of the raise. Blocking a
     *      graduation this way means buying the whole `REPRICE_SUPPLY` at a
     *      loss.
     */
    function _repricePool(uint160 target) private {
        address p = pool;
        (uint160 sqrtP,,,,,,) = IUniswapV3PoolMint(p).slot0();
        if (sqrtP == target) return;

        // token0 in, price down; token1 in, price up. Which of the two is the
        // basket token depends only on how the addresses sorted, and the
        // callback works it out the same way.
        bool zeroForOne = target < sqrtP;
        bool payingQuote = zeroForOne == usdgIsToken0;

        // Exact input. In the direction we can be made to pay, offer the whole
        // reprice budget and let the price limit stop it. In the direction
        // nothing can be crossed, one unit is enough to enter the loop, and if
        // that unit is ever actually taken the callback reverts.
        int256 amountSpecified = payingQuote ? int256(1) : int256(REPRICE_SUPPLY);

        _repricing = true;
        IUniswapV3PoolMint(p).swap(address(this), zeroForOne, amountSpecified, target, "");
        _repricing = false;

        // Landing short of the limit means the input ran out first, which means
        // somebody is standing in the way with more money than REPRICE_SUPPLY is
        // worth. Reverting is right: seeding at any other price is the bug this
        // function exists to close.
        (sqrtP,,,,,,) = IUniswapV3PoolMint(p).slot0();
        if (sqrtP != target) revert RepriceFailed(sqrtP, target);
    }

    /**
     * The position's tick range: the full one, aligned to the pool's spacing.
     *
     * @dev Derived in one place rather than twice, because `mint` and `collect`
     *      addressing different ranges would mean minting a position and then
     *      collecting from an empty one, which reports zero fees forever and
     *      looks exactly like a pool nobody has traded.
     */
    function _range() private view returns (int24 lower, int24 upper) {
        int24 spacing = IUniswapV3PoolMint(pool).tickSpacing();
        // Truncation is toward zero on both, so both land inside the usable range.
        lower = (TickMath.MIN_TICK / spacing) * spacing;
        upper = (TickMath.MAX_TICK / spacing) * spacing;
    }

    /**
     * Pay the creator the pool's trading fees. Permissionless, and it always
     * pays `creator` whoever calls it.
     *
     * @dev **This is the only revenue a creator has, and it is why this
     *      function exists at all.** The router's creator fee is charged on a
     *      buy, and graduation is the only router buy a basket ever makes, so
     *      that fee is roughly forty dollars once on a ten thousand dollar
     *      raise and then nothing forever. The pool charges 0.3% on every trade
     *      for as long as the token exists, and those fees were accruing to a
     *      position nobody could reach, which is to say they were accruing to
     *      nobody. This routes them to whoever launched the basket.
     *
     *      **It cannot touch the liquidity, and the reason is exact.** A V3
     *      position's `tokensOwed` grows from two things and only two: fees
     *      credited when the position is touched, and principal credited by
     *      `burn` with a nonzero amount. **This contract calls `burn` once, with
     *      zero, on the line below, and has no other burn anywhere.** So
     *      `tokensOwed` can only ever hold fees, and `collect` can only ever
     *      move fees. The `liquidity` seeded at graduation is never reduced by
     *      anything, because nothing here can reduce it.
     *
     *      `burn(0)` removes nothing. It runs the pool's fee accounting for
     *      this position and moves what is owed into `tokensOwed`, which is the
     *      only way to make fees collectable at all.
     *
     *      This is a weaker guarantee than the vault's, which rests on the
     *      absence of any function that moves an asset out. Here there is such a
     *      function and the claim is about what it can reach. `test/Curve.t.sol`
     *      trades against the real pool to generate real fees, collects them,
     *      and asserts the position's liquidity is unchanged to the wei.
     */
    function collectFees() external nonReentrant returns (uint256 usdgOut, uint256 tokenOut) {
        if (!graduated) revert NotGraduated();
        (int24 lower, int24 upper) = _range();

        IUniswapV3PoolMint(pool).burn(lower, upper, 0);
        (uint128 amount0, uint128 amount1) =
            IUniswapV3PoolMint(pool).collect(creator, lower, upper, type(uint128).max, type(uint128).max);

        (usdgOut, tokenOut) = usdgIsToken0 ? (uint256(amount0), uint256(amount1)) : (uint256(amount1), uint256(amount0));
        emit FeesCollected(creator, usdgOut, tokenOut);
    }

    /// Liquidity that `amount0` supports across [sqrtA, sqrtB]. Uniswap's LiquidityAmounts, inlined.
    function _liquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 amount0) private pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 intermediate = FullMath.mulDiv(sqrtA, sqrtB, 1 << 96);
        return _toUint128(FullMath.mulDiv(amount0, intermediate, sqrtB - sqrtA));
    }

    /// Liquidity that `amount1` supports across [sqrtA, sqrtB].
    function _liquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1) private pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return _toUint128(FullMath.mulDiv(amount1, 1 << 96, sqrtB - sqrtA));
    }

    /// @dev `mint` takes a uint128. A truncating cast would ask the pool for a
    ///      fraction of the intended position and pay for it with everything.
    function _toUint128(uint256 x) private pure returns (uint128) {
        if (x > type(uint128).max) revert LiquidityTooLarge();
        return uint128(x);
    }

    /**
     * Pay for the position being minted.
     *
     * @dev Guarded the way the router guards its swap callback. `_minting` is
     *      only true inside `_seedPool`, so an arbitrary caller cannot reach
     *      this, and the pool is checked by address so a hostile pool cannot
     *      either. Both tokens are already here: the usdg from the raise and the
     *      token from the mint above.
     */
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        if (!_minting || msg.sender != pool) revert UnknownCaller();
        (address token0, address token1) = usdgIsToken0 ? (usdg, address(vault)) : (address(vault), usdg);
        if (amount0Owed != 0) token0.safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed != 0) token1.safeTransfer(msg.sender, amount1Owed);
    }

    /**
     * Pay for the corrective swap in `_repricePool`, and only ever in token.
     *
     * @dev Guarded the same way as the mint callback. The refusal to pay usdg is
     *      not caution, it is the invariant: the walk can only cross foreign
     *      liquidity in the direction where this contract is the seller, so a
     *      pool asking for usdg here means an assumption in `_repricePool` is
     *      wrong, and the safe answer to that is to stop rather than to spend
     *      the raise finding out.
     */
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (!_repricing || msg.sender != pool) revert UnknownCaller();
        (address token0, address token1) = usdgIsToken0 ? (usdg, address(vault)) : (address(vault), usdg);

        if (amount0Delta > 0) {
            if (usdgIsToken0) revert PoolWantsQuote();
            token0.safeTransfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            if (!usdgIsToken0) revert PoolWantsQuote();
            token1.safeTransfer(msg.sender, uint256(amount1Delta));
        }
    }

    /**
     * Take delivery of what was bought on the curve, once it has graduated.
     *
     * @dev The curve tracks balances itself while it is open, because the token
     *      does not exist until graduation mints it. This is where a buyer
     *      swaps that bookkeeping entry for the real thing.
     */
    function claim() external nonReentrant returns (uint256 amount) {
        if (!graduated) revert NotGraduated();
        amount = balanceOf[msg.sender];
        if (amount == 0) revert ZeroAmount();
        balanceOf[msg.sender] = 0;
        address(vault).safeTransfer(msg.sender, amount);
    }
}
