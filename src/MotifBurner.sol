// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUniswapV3Factory, SafeTransfer} from "./BasketRouter.sol";
import {IUniswapV3PoolSwap} from "./TokenSwap.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// The Pons bonding curve MOTIF trades on until it graduates. Only what is called here.
interface IPonsCurve {
    /// Spend exactly `quoteIn` of native ETH, sent as the call's value, on at
    /// least `minOut` tokens for `recipient`. Reverts `NativeValueMismatch` when
    /// the value and `quoteIn` differ, and `SlippageExceeded` under `minOut`.
    function buy(uint256 quoteIn, uint256 minOut, address recipient) external payable returns (uint256 out);
    function graduated() external view returns (bool);
    function token() external view returns (address);
    function isNativeQuote() external view returns (bool);
}

interface IWETH9 {
    function withdraw(uint256 amount) external;
}

interface IERC20Read {
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IBurnable {
    function burn(uint256 amount) external;
}

/**
 * @title MotifBurner
 * @notice Turns the protocol's 0.10% into MOTIF and destroys it.
 *
 * @dev **Where the money comes from.** `BasketRouter` pays its protocol fee to
 *      `protocolFeeTo`, which is immutable and is a wallet. Pointing it here
 *      would mean redeploying the router and abandoning every motif published
 *      on it, so this pulls instead: the fee wallet approves this contract
 *      once, and each burn takes what has arrived since the last one. The
 *      wallet can revoke that approval. That is the one trust assumption left,
 *      and it is a public one, because the allowance is readable by anybody.
 *
 *      **Pulled in the transaction it is spent in.** Nothing waits here. A burn
 *      pulls the USDG, swaps it to WETH, unwraps it, buys MOTIF on its curve and
 *      burns everything it holds, or it reverts and nothing moved. So a route
 *      that breaks strands nothing: the burn fails and the fees stay where they
 *      were. The curve graduating is the break that will certainly come, and
 *      after it this contract simply stops working and a successor with the
 *      post graduation route replaces it.
 *
 *      **No owner, no withdrawal, no settings.** Every address is fixed at
 *      deployment. The only ways out of this contract for any token are the
 *      pool on the way in and `burn` on the way out.
 *
 *      **Why ten dollars, and why fifty.** A burn is 325,577 gas measured on a
 *      fork, around twelve cents when this was written. Under ten dollars that
 *      is a real share of what gets burned; at ten it is about 1.2 percent.
 *      The ceiling is about who else could profit. Anyone may call this and
 *      anyone may pass zero as the floor, so the question is whether a sandwich
 *      around it pays. On a constant product curve it pays only when the burn
 *      is larger than the curve's fee times its quote reserve, which was one
 *      percent of 3.76 ETH, about $93, when this was written. Fifty sits well
 *      under that, and the reserve only grows until graduation.
 *      `test/Burner.t.sol` runs the sandwich against the real curve rather than
 *      trusting the algebra.
 */
contract MotifBurner is ReentrancyGuardTransient {
    using SafeTransfer for address;

    /// The least one burn will spend, in USDG's six decimals. Ten dollars.
    uint256 public constant MIN_BURN = 10e6;
    /// The most one burn will spend. Fifty dollars.
    uint256 public constant MAX_BURN = 50e6;

    /// The ends of the V3 price range. The real floor is the caller's `minMotifOut`.
    uint160 internal constant MIN_SQRT_RATIO = 4_295_128_739;
    uint160 internal constant MAX_SQRT_RATIO = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;

    address public immutable usdg;
    address public immutable weth;
    address public immutable motif;
    IPonsCurve public immutable curve;
    /// The USDG/WETH pool, resolved from the real factory once, at deployment.
    address public immutable pool;
    /// Where the protocol fee lands. The deploy script reads it off the router.
    address public immutable source;
    bool internal immutable usdgIsToken0;

    /// Running totals, so the whole record is one read away from anybody.
    uint256 public burns;
    uint256 public usdgSpent;
    uint256 public motifBurned;

    /**
     * How much the pool may pull during the swap this contract started, and
     * nothing at all when zero. The same guard as `TokenSwap._owedCap`: it is
     * what stops anybody else reaching the callback.
     */
    uint256 private _owedCap;

    /// `motifBurned` is everything destroyed, which includes any MOTIF somebody
    /// sent here before the call. `motifBought` is this call's purchase alone.
    event Burned(address indexed caller, uint256 usdgIn, uint256 ethSpent, uint256 motifBought, uint256 motifBurned);

    error ZeroAddress();
    error NotNativeQuote();
    error NoPool();
    error Graduated();
    error BelowThreshold(uint256 available, uint256 minimum);
    error UnknownCaller();
    error PoolWantsTooMuch(uint256 owed, uint256 cap);
    error OnlyWeth();

    constructor(
        address usdg_,
        address weth_,
        IUniswapV3Factory factory_,
        uint24 poolFee_,
        IPonsCurve curve_,
        address source_
    ) {
        if (
            usdg_ == address(0) || weth_ == address(0) || address(factory_) == address(0)
                || address(curve_) == address(0) || source_ == address(0)
        ) revert ZeroAddress();

        // The whole route ends in native ETH. A curve quoted in anything else
        // would be handed ETH it does not take, on every single call.
        if (!curve_.isNativeQuote()) revert NotNativeQuote();

        address pool_ = factory_.getPool(usdg_, weth_, poolFee_);
        if (pool_ == address(0)) revert NoPool();

        usdg = usdg_;
        weth = weth_;
        curve = curve_;
        // Read off the curve rather than passed in, so the token burned and the
        // token bought cannot disagree.
        motif = curve_.token();
        pool = pool_;
        source = source_;
        usdgIsToken0 = usdg_ < weth_;
    }

    /**
     * @notice What a burn would spend right now, in USDG.
     *
     * @dev Whatever is already here, plus what the fee wallet both holds and
     *      has allowed, capped at `MAX_BURN`. USDG sent here directly counts, so
     *      a donation is burned rather than stranded.
     */
    function available() public view returns (uint256 amount) {
        IERC20Read t = IERC20Read(usdg);
        uint256 held = t.balanceOf(source);
        uint256 allowed = t.allowance(source, address(this));
        amount = t.balanceOf(address(this)) + (held < allowed ? held : allowed);
        if (amount > MAX_BURN) amount = MAX_BURN;
    }

    /**
     * @notice Whether a burn would go through, what it would spend, and if not, why.
     * @dev For the keeper and the site. A revert costs gas and says less.
     */
    function ready() external view returns (bool ok, uint256 amount, string memory why) {
        if (curve.graduated()) return (false, 0, "MOTIF has graduated off its curve, so this route is closed");
        amount = available();
        if (amount >= MIN_BURN) return (true, amount, "");
        if (IERC20Read(usdg).allowance(source, address(this)) == 0) {
            return (false, amount, "the fee wallet has not approved this contract");
        }
        return (false, amount, "under the ten dollar minimum");
    }

    /**
     * @notice Spend up to fifty dollars of protocol fees on MOTIF and burn it.
     *
     * @param minMotifOut The least MOTIF the purchase must return, enforced by
     *        the curve. Zero is allowed: a sandwich at this size loses money,
     *        which `test/Burner.t.sol` measures rather than assumes.
     * @return bought What this call's purchase returned.
     *
     * @dev Open to anybody. Whoever calls pays the gas and gains nothing, and
     *      that is fine: the keeper calls it on a timer and nobody needs to.
     */
    function burn(uint256 minMotifOut) external nonReentrant returns (uint256 bought) {
        if (curve.graduated()) revert Graduated();

        uint256 amount = available();
        if (amount < MIN_BURN) revert BelowThreshold(amount, MIN_BURN);

        uint256 here = IERC20Read(usdg).balanceOf(address(this));
        if (amount > here) usdg.safeTransferFrom(source, address(this), amount - here);

        // USDG to WETH, exact input, paid out to this contract. `amount` is at
        // most fifty dollars, so the int256 cast cannot wrap.
        _owedCap = amount;
        (int256 amount0, int256 amount1) = IUniswapV3PoolSwap(pool).swap(
            address(this),
            usdgIsToken0,
            int256(amount),
            usdgIsToken0 ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        _owedCap = 0;

        // A negative delta is what the pool paid out.
        int256 delta = usdgIsToken0 ? -amount1 : -amount0;
        uint256 ethIn = delta > 0 ? uint256(delta) : 0;

        IWETH9(weth).withdraw(ethIn);
        bought = curve.buy{value: ethIn}(ethIn, minMotifOut, address(this));

        // Everything held, not only what was just bought. MOTIF sent here has
        // nowhere else to go, and burning it is the only thing this can do.
        uint256 burned = IERC20Read(motif).balanceOf(address(this));
        IBurnable(motif).burn(burned);

        burns += 1;
        usdgSpent += amount;
        motifBurned += burned;
        emit Burned(msg.sender, amount, ethIn, bought, burned);
    }

    /// @notice Called by the pool mid swap to collect the USDG side.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        uint256 cap = _owedCap;
        if (cap == 0 || msg.sender != pool) revert UnknownCaller();

        // A positive delta is what this contract owes the pool.
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        if (owed > cap) revert PoolWantsTooMuch(owed, cap);

        usdg.safeTransfer(msg.sender, owed);
    }

    /// ETH arrives from unwrapping and from nowhere else. WETH9 sends it with a
    /// 2,300 gas stipend, which one comparison against an immutable fits in.
    receive() external payable {
        if (msg.sender != weth) revert OnlyWeth();
    }
}
