// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {BasketRouter, IUniswapV3Factory} from "../src/BasketRouter.sol";
import {BasketCurve} from "../src/BasketCurve.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {BasketFactory} from "../src/BasketFactory.sol";

interface IERC20C {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IUniV3Pool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/**
 * @title The curve, and the one transaction that turns a raise into a basket
 *
 * `test/Floor.t.sol` proves the property the product rests on: a token backed
 * by stock that anyone can always redeem. This file is about how the backing
 * gets there. It runs against the real pools on a mainnet fork rather than a
 * mock, for the reason the rest of this repo does: a mock would agree with
 * whatever this file assumed, and the assumption is the part worth doubting.
 *
 * Three things are being tested, in rising order of how much they would cost to
 * get wrong:
 *
 * 1. The curve prices sensibly and cannot be milked by a round trip.
 * 2. **The threshold is always reachable.** Supply must not run out before the
 *    raise is complete, or the money already in is stuck.
 * 3. Graduation spends the whole raise on the real legs, puts them somewhere
 *    nobody can take them from, and mints exactly what was sold against them.
 */
contract CurveTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    uint24 constant FEE_LOW = 500;
    uint24 constant FEE_MID = 3000;

    /// USDG is 6 decimals, so this is ten thousand dollars.
    uint256 constant THRESHOLD = 10_000e6;

    BasketRouter router;
    BasketFactory factory;
    BasketCurve curve;
    BasketVault vault;
    uint256 indexId;

    address creator = makeAddr("creator");
    address protocolFeeTo = makeAddr("protocolFeeTo");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    /**
     * Where to fork from.
     *
     * @dev The public rpc by default, so `forge test` still works on a clone
     *      with nothing configured. CI overrides it to a local anvil that forks
     *      the public rpc once and then serves every repeat from memory, which
     *      is what stops the sweep being refused.
     *
     *      **The bigger win is the block.** `createSelectFork` with no block
     *      number takes the latest, and the chain advances between suites, so
     *      ten test contracts fork ten different blocks and forge's cache, which
     *      is keyed on the block, never hits. Anvil pins one block for the whole
     *      run and every suite shares it.
     */
    function _forkUrl() internal view returns (string memory) {
        return vm.envOr("MOTIF_RPC", string("https://rpc.mainnet.chain.robinhood.com"));
    }

    function setUp() public {
        vm.createSelectFork(_forkUrl());

        address[] memory quotes = new address[](1);
        quotes[0] = USDG;
        router = new BasketRouter(FACTORY, protocolFeeTo, address(this), 0, quotes);

        factory = new BasketFactory(router, USDG);
        curve = _launch(THRESHOLD, "AI Core", "AICORE");
        vault = curve.vault();
        indexId = curve.indexId();
    }

    /// A launch through the factory, by `creator`, at the standard 60/40 legs.
    function _launch(uint256 threshold, string memory name, string memory symbol) internal returns (BasketCurve c) {
        vm.prank(creator);
        (c,) = factory.launch(_legs(), 50, threshold, name, symbol, "", "");
    }

    function _legs() internal pure returns (BasketRouter.Leg[] memory legs) {
        legs = new BasketRouter.Leg[](2);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: FEE_LOW, weightBps: 6000});
        legs[1] = BasketRouter.Leg({token: TSLA, fee: FEE_MID, weightBps: 4000});
    }

    function _buy(BasketCurve c, address who, uint256 amount) internal returns (uint256 out) {
        deal(USDG, who, amount);
        vm.startPrank(who);
        IERC20C(USDG).approve(address(c), amount);
        out = c.buy(amount, 0);
        vm.stopPrank();
    }

    function _zeros() internal pure returns (uint256[] memory) {
        return new uint256[](2);
    }

    uint160 constant MIN_SQRT = 4_295_128_739;
    uint160 constant MAX_SQRT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;

    /// Buy the basket token out of its own pool, paying usdg, as a real trader would.
    function _swapUsdgForToken(address who, uint256 usdgIn) internal returns (uint256 out) {
        address p = curve.pool();
        bool usdgIsToken0 = curve.usdgIsToken0();
        deal(USDG, address(this), usdgIn);
        (int256 a0, int256 a1) = IUniV3Pool(p)
            .swap(who, usdgIsToken0, int256(usdgIn), usdgIsToken0 ? MIN_SQRT + 1 : MAX_SQRT - 1, abi.encode(p));
        out = uint256(-(usdgIsToken0 ? a1 : a0));
    }

    /**
     * Walk an unliquid pool to `target`, which is what a stranger can do to any
     * of these pools between launch and graduation.
     *
     * @dev This is the whole attack surface in one function: `initialize` is
     *      closed by the constructor, but `swap` is not, and a swap through a
     *      pool with no liquidity in it moves the price to the limit exactly,
     *      moves no tokens, and costs nothing but gas. The callback below
     *      asserts the "moves no tokens" half rather than assuming it.
     */
    function _shove(address p, uint256 target) internal {
        (uint160 sqrtP,,,,,,) = IUniV3Pool(p).slot0();
        if (target >= MAX_SQRT) target = MAX_SQRT - 1;
        if (target <= MIN_SQRT) target = MIN_SQRT + 1;
        if (uint160(target) == sqrtP) return;

        _shoving = p;
        IUniV3Pool(p).swap(address(this), uint160(target) < sqrtP, int256(1), uint160(target), "");
        _shoving = address(0);

        (uint160 landed,,,,,,) = IUniV3Pool(p).slot0();
        assertEq(landed, uint160(target), "the shove did not land");
    }

    /// The pool `_shove` is currently walking, and nothing the rest of the time.
    address private _shoving;

    /// Pays for the swap above, either side, out of the test contract's own balance.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender == _shoving) {
            // Free, which is exactly why the curve cannot trust what it finds.
            assertLe(amount0Delta, 0, "the shove cost token0");
            assertLe(amount1Delta, 0, "the shove cost token1");
            return;
        }
        require(msg.sender == curve.pool(), "unexpected pool");
        (address token0, address token1) = curve.usdgIsToken0() ? (USDG, address(vault)) : (address(vault), USDG);
        if (amount0Delta > 0) IERC20C(token0).transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20C(token1).transfer(msg.sender, uint256(amount1Delta));
    }

    /**
     * A real round trip through the pool, in and back out.
     *
     * @dev Both directions, because a one way trade only accrues fees in the
     *      token that went in, and a test that collected one side would not
     *      notice the other being dropped.
     */
    function _tradeBothWays(uint256 usdgIn) internal {
        address p = curve.pool();
        bool usdgFirst = curve.usdgIsToken0();
        deal(USDG, address(this), usdgIn);

        (int256 a0, int256 a1) =
            IUniV3Pool(p).swap(address(this), usdgFirst, int256(usdgIn), usdgFirst ? MIN_SQRT + 1 : MAX_SQRT - 1, "");
        uint256 got = uint256(-(usdgFirst ? a1 : a0));

        IUniV3Pool(p).swap(address(this), !usdgFirst, int256(got), !usdgFirst ? MIN_SQRT + 1 : MAX_SQRT - 1, "");
    }

    // ------------------------------------------------------------- the curve

    /**
     * Being early is worth something, which is the whole reason a curve is here
     * rather than a fixed price sale. Two identical spends, and the second must
     * buy less.
     */
    /**
     * A creator taking the first position in their own basket, in the launch.
     *
     * @dev The reason it has to be one transaction rather than a launch and
     *      then a buy: between those two the curve is open and its cheapest
     *      tokens are the first ones, so whoever is watching takes the opening
     *      position the creator was paying for. What this pins is that the
     *      position lands on the creator rather than on the factory, which is
     *      the trap, since `buy` credits `msg.sender` and the factory is the
     *      one calling.
     */
    function test_a_creator_can_take_the_first_position_in_the_launch() public {
        deal(USDG, creator, 1_000e6);
        vm.startPrank(creator);
        IERC20C(USDG).approve(address(factory), 1_000e6);
        (BasketCurve c,, uint256 out) =
            factory.launchAndBuy(_legs(), 50, THRESHOLD, "Dev Buy", "DEVB", "", "", 1_000e6, 0);
        vm.stopPrank();

        assertGt(out, 0, "bought nothing");
        assertEq(c.balanceOf(creator), out, "the position is not the creator's");
        assertEq(c.balanceOf(address(factory)), 0, "the factory kept the position");
        assertEq(c.raised(), 1_000e6, "the raise did not move");
        assertEq(IERC20C(USDG).balanceOf(address(factory)), 0, "the factory kept usdg");
        assertEq(
            IERC20C(USDG).allowance(address(factory), address(c)), 0, "an approval outlived the call"
        );
    }

    /// The same launch buys exactly what a separate first buy would have.
    function test_the_launch_buy_is_priced_like_any_other_first_buy() public {
        deal(USDG, creator, 1_000e6);
        vm.startPrank(creator);
        IERC20C(USDG).approve(address(factory), 1_000e6);
        (,, uint256 inLaunch) =
            factory.launchAndBuy(_legs(), 50, THRESHOLD, "One", "ONE", "", "", 1_000e6, 0);
        vm.stopPrank();

        BasketCurve plain = _launch(THRESHOLD, "Two", "TWO");
        uint256 separately = _buy(plain, alice, 1_000e6);

        assertEq(inLaunch, separately, "the launch buy is priced differently");
    }

    /// `buyFor` gives, it does not take: the caller pays, the named address is
    /// credited, and nothing else moves.
    function test_buy_for_pays_from_the_caller_and_credits_the_other() public {
        deal(USDG, alice, 500e6);
        vm.startPrank(alice);
        IERC20C(USDG).approve(address(curve), 500e6);
        uint256 out = curve.buyFor(bob, 500e6, 0);
        vm.stopPrank();

        assertEq(curve.balanceOf(bob), out, "bob was not credited");
        assertEq(curve.balanceOf(alice), 0, "alice was credited too");
        assertEq(IERC20C(USDG).balanceOf(alice), 0, "alice did not pay");
    }

    function test_a_launch_buy_of_nothing_is_refused() public {
        vm.prank(creator);
        vm.expectRevert(BasketFactory.ZeroAmount.selector);
        factory.launchAndBuy(_legs(), 50, THRESHOLD, "Zero", "ZERO", "", "", 0, 0);
    }

    function test_price_rises_with_each_buy() public {
        uint256 first = _buy(curve, alice, 1_000e6);
        uint256 second = _buy(curve, bob, 1_000e6);

        console.log("first  $1000 bought", first / 1e18);
        console.log("second $1000 bought", second / 1e18);

        assertGt(first, second, "the second buyer did not pay more");
        assertEq(curve.raised(), 2_000e6, "raised wrong");
        assertEq(curve.sold(), first + second, "sold wrong");
    }

    /**
     * A round trip must never return more than it cost. If it can, the curve is
     * a faucet and the first person to notice empties it.
     *
     * The differential is signed on purpose: the question is not "did the sell
     * work" but "how much did the round tripper end up with, against what they
     * put in".
     */
    function test_a_round_trip_never_pays_out_more_than_it_cost() public {
        uint256 spend = 1_000e6;
        uint256 got = _buy(curve, alice, spend);

        vm.prank(alice);
        uint256 back = curve.sell(got, 0);

        int256 profit = int256(back) - int256(spend);
        console.log("round trip on $1000, profit in USDG units:");
        console.logInt(profit);

        assertLe(back, spend, "the curve paid out more than it took in");
        // Only rounding should be lost, not a fee: there is no fee here.
        assertGe(back, spend - 10, "the round trip lost more than rounding");

        assertEq(curve.sold(), 0, "supply not returned");
        // The invariant that holds for as long as the curve is open: what it
        // holds is what it says it raised.
        assertEq(IERC20C(USDG).balanceOf(address(curve)), curve.raised(), "balance and raised disagree");
    }

    /// Nobody can sell tokens they never bought.
    function test_cannot_sell_what_you_do_not_hold() public {
        _buy(curve, alice, 1_000e6);

        vm.prank(bob);
        vm.expectRevert(BasketCurve.InsufficientBalance.selector);
        curve.sell(1e18, 0);
    }

    /// The supply is a cap, not a suggestion.
    function test_supply_cannot_be_oversold() public {
        _buy(curve, alice, THRESHOLD);

        deal(USDG, bob, 50_000e6);
        vm.startPrank(bob);
        IERC20C(USDG).approve(address(curve), 50_000e6);
        vm.expectRevert(BasketCurve.SupplyExhausted.selector);
        curve.buy(50_000e6, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------- the reachability trap

    /**
     * **The one that would have stranded real money.**
     *
     * Supply runs out at `3 * virtualUsdg` raised. `virtualUsdg` is a third of
     * the threshold, and a third of a number that is not divisible by three has
     * to round somewhere. Rounding down puts the supply cap *below* the
     * threshold: the last tokens cannot be bought because `buy` reverts with
     * `SupplyExhausted`, and graduation cannot happen because `raised` never
     * reaches `threshold`. Everything already paid in is behind a door that
     * only opens by everyone selling back out.
     *
     * The threshold here is deliberately not divisible by three. This test
     * fails against a curve that rounds the other way.
     */
    function test_the_threshold_is_reachable_whatever_the_number() public {
        uint256 awkward = 10_000e6 + 1; // not divisible by three
        BasketCurve c = _launch(awkward, "Odd", "ODD");

        uint256 out = _buy(c, alice, awkward);

        assertGe(c.raised(), c.threshold(), "threshold not reached");
        assertLe(c.sold(), c.CURVE_SUPPLY(), "sold past the cap");
        assertGt(out, 0, "bought nothing");

        // And graduation is genuinely open, which is the point of the above.
        c.graduate(_zeros());
        assertTrue(c.graduated(), "could not graduate");
    }

    /**
     * With a threshold that divides cleanly, the constants are exact: buying the
     * whole threshold in one go sells the whole curve supply, to the wei. That
     * is the arithmetic the virtual reserves were chosen for, so it is worth
     * pinning rather than trusting.
     */
    function test_the_constants_close_exactly_on_a_clean_threshold() public {
        uint256 clean = 9_999e6; // divisible by three
        BasketCurve c = _launch(clean, "Clean", "CLEAN");

        _buy(c, alice, clean);

        assertEq(c.raised(), clean, "raised wrong");
        assertEq(c.sold(), c.CURVE_SUPPLY(), "the curve did not close on the threshold");
    }

    // ------------------------------------------------------------ graduation

    function test_graduation_needs_the_threshold() public {
        _buy(curve, alice, THRESHOLD - 1e6);

        vm.expectRevert(abi.encodeWithSelector(BasketCurve.NotReady.selector, THRESHOLD - 1e6, THRESHOLD));
        curve.graduate(_zeros());
    }

    /**
     * The transaction the whole design turns on. The raise goes out, real stock
     * comes back, it lands in the vault, and supply is minted against it.
     */
    function test_graduation_buys_the_basket_and_backs_the_token() public {
        // Two buyers filling the raise exactly. Not a penny more: the supply is
        // sized to the threshold, so a spend past it has no tokens left to buy
        // and reverts SupplyExhausted, which is the curve being right rather
        // than the test being unlucky.
        uint256 aliceGot = _buy(curve, alice, 6_000e6);
        uint256 bobGot = _buy(curve, bob, 4_000e6);
        uint256 spend = curve.raised();
        assertEq(spend, THRESHOLD, "the raise did not land on the threshold");

        // Permissionless: somebody with no position calls it.
        vm.prank(stranger);
        curve.graduate(_zeros());

        uint256 nvda = IERC20C(NVDA).balanceOf(address(vault));
        uint256 tsla = IERC20C(TSLA).balanceOf(address(vault));
        console.log("spent USDG", spend);
        console.log("vault NVDA", nvda);
        console.log("vault TSLA", tsla);

        assertGt(nvda, 0, "no NVDA behind the token");
        assertGt(tsla, 0, "no TSLA behind the token");

        // Nothing sticks to the curve on the way through. Not a unit of usdg:
        // the pool rounds its own amounts and the remainder became stock rather
        // than dust nobody can reach. The token balance it does keep is exactly
        // what the curve's buyers have yet to claim.
        assertEq(IERC20C(USDG).balanceOf(address(curve)), 0, "USDG left in the curve");
        assertEq(IERC20C(NVDA).balanceOf(address(curve)), 0, "NVDA left in the curve");
        assertEq(IERC20C(TSLA).balanceOf(address(curve)), 0, "TSLA left in the curve");
        assertEq(IERC20C(address(vault)).balanceOf(address(curve)), curve.sold(), "token stranded in the curve");

        // And the caller took nothing for doing it.
        assertEq(IERC20C(NVDA).balanceOf(stranger), 0, "the caller was paid");
        assertEq(IERC20C(USDG).balanceOf(stranger), 0, "the caller was paid");

        // Supply is what the curve sold plus the tranche that went into the
        // pool, and nothing else. Every token is either claimable by the person
        // who paid for it or sitting in liquidity nobody can withdraw.
        uint256 lpTokens = vault.totalSupply() - curve.sold();
        assertEq(curve.sold(), aliceGot + bobGot, "sold does not match what was bought");
        assertEq(IERC20C(address(vault)).balanceOf(curve.pool()), lpTokens, "the tranche is not in the pool");
        assertTrue(vault.graduated(), "vault not graduated");
    }

    /**
     * The bound is passed straight to the router, so an unfillable graduation
     * reverts whole and the curve stays open for somebody to try again. A
     * partially graduated basket would be wrong weights backing a token nobody
     * could value.
     */
    function test_an_unfillable_graduation_reverts_and_leaves_the_curve_open() public {
        _buy(curve, alice, THRESHOLD);

        uint256[] memory absurd = new uint256[](2);
        absurd[0] = 1_000_000e18;
        absurd[1] = 1_000_000e18;

        vm.expectRevert();
        curve.graduate(absurd);

        assertFalse(curve.graduated(), "graduated anyway");
        assertEq(IERC20C(USDG).balanceOf(address(curve)), THRESHOLD, "the raise moved");

        // Still open for business.
        curve.graduate(_zeros());
        assertTrue(curve.graduated(), "could not graduate afterwards");
    }

    /**
     * Graduation is the largest single trade the system ever makes, and
     * `docs/04-tokenised-baskets.md` leaves its slippage as an open question.
     * This measures it rather than arguing about it: the same spend, at the same
     * block, through the curve and through an ordinary router buy, must deliver
     * the same legs. Anything the curve added would show up as a difference.
     */
    function test_graduation_costs_no_more_than_an_ordinary_buy() public {
        _buy(curve, alice, THRESHOLD);
        uint256 raise = curve.raised();

        uint256 snap = vm.snapshotState();

        // Graduate first, and read what it actually spent on stock rather than
        // assuming it. The pool rounds its own amounts, so the stock budget is
        // the raise less whatever the pool really took, not a share computed
        // twice and hoped to agree.
        curve.graduate(_zeros());
        uint256 gradNvda = IERC20C(NVDA).balanceOf(address(vault));
        uint256 gradTsla = IERC20C(TSLA).balanceOf(address(vault));
        uint256 spend = raise - IERC20C(USDG).balanceOf(curve.pool());

        vm.revertToState(snap);

        // The plain path: a buyer spending exactly that through the router.
        deal(USDG, bob, spend);
        vm.startPrank(bob);
        IERC20C(USDG).approve(address(router), spend);
        router.buy(indexId, spend, _zeros());
        vm.stopPrank();
        uint256 plainNvda = IERC20C(NVDA).balanceOf(bob);
        uint256 plainTsla = IERC20C(TSLA).balanceOf(bob);

        console.log("plain buy NVDA     ", plainNvda);
        console.log("graduation NVDA    ", gradNvda);
        console.logInt(int256(gradNvda) - int256(plainNvda));

        assertEq(gradNvda, plainNvda, "graduation got less NVDA than a plain buy");
        assertEq(gradTsla, plainTsla, "graduation got less TSLA than a plain buy");
    }

    /// The raise has been spent, so there is nothing left here to trade against.
    function test_the_curve_closes_at_graduation() public {
        _buy(curve, alice, THRESHOLD);
        curve.graduate(_zeros());

        deal(USDG, bob, 100e6);
        vm.startPrank(bob);
        IERC20C(USDG).approve(address(curve), 100e6);
        vm.expectRevert(BasketCurve.AlreadyGraduated.selector);
        curve.buy(100e6, 0);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(BasketCurve.AlreadyGraduated.selector);
        curve.sell(1e18, 0);

        vm.expectRevert(BasketCurve.AlreadyGraduated.selector);
        curve.graduate(_zeros());
    }

    // ------------------------------------------------------- the whole route

    /**
     * End to end, in the order a real buyer lives it: buy on the curve, the
     * basket graduates, claim the token, redeem it, and hold real NVDA and TSLA
     * in your own wallet.
     *
     * This is the sentence the site is allowed to say, so it is the sentence
     * that has to be true.
     */
    function test_buy_on_the_curve_and_redeem_real_stock() public {
        uint256 aliceGot = _buy(curve, alice, 6_000e6);
        uint256 bobGot = _buy(curve, bob, 4_000e6);
        curve.graduate(_zeros());

        uint256 vaultNvda = IERC20C(NVDA).balanceOf(address(vault));
        uint256 vaultTsla = IERC20C(TSLA).balanceOf(address(vault));
        uint256 lpTokens = vault.totalSupply() - curve.sold();

        vm.prank(alice);
        uint256 claimed = curve.claim();
        assertEq(claimed, aliceGot, "claimed the wrong amount");
        assertEq(vault.balanceOf(alice), aliceGot, "token not delivered");
        assertEq(curve.balanceOf(alice), 0, "curve position not cleared");

        vm.prank(alice);
        vault.redeem(aliceGot);

        uint256 nvda = IERC20C(NVDA).balanceOf(alice);
        uint256 tsla = IERC20C(TSLA).balanceOf(alice);
        console.log("alice redeemed NVDA", nvda);
        console.log("alice redeemed TSLA", tsla);

        assertGt(nvda, 0, "no NVDA came back");
        assertGt(tsla, 0, "no TSLA came back");

        // Her share, computed against the whole supply that existed when she
        // burned, which includes the tranche sitting in the pool.
        uint256 supplyAtBurn = aliceGot + bobGot + lpTokens;
        assertEq(nvda, (vaultNvda * aliceGot) / supplyAtBurn, "NVDA share wrong");
        assertEq(tsla, (vaultTsla * aliceGot) / supplyAtBurn, "TSLA share wrong");

        // And bob's share is untouched by her leaving.
        vm.prank(bob);
        curve.claim();
        vm.prank(bob);
        vault.redeem(bobGot);
        assertGt(IERC20C(NVDA).balanceOf(bob), 0, "bob got nothing");

        // What is left outstanding is exactly the pool's tranche. It stays
        // redeemable, by whoever buys it out of the pool.
        assertEq(vault.totalSupply(), lpTokens, "supply left behind is not the pool tranche");
    }

    /// Nothing to claim before there is a token, and nothing to claim twice.
    function test_claiming_is_once_and_only_after_graduation() public {
        _buy(curve, alice, THRESHOLD);

        vm.prank(alice);
        vm.expectRevert(BasketCurve.NotGraduated.selector);
        curve.claim();

        curve.graduate(_zeros());

        vm.prank(alice);
        curve.claim();
        vm.prank(alice);
        vm.expectRevert(BasketCurve.ZeroAmount.selector);
        curve.claim();
    }

    // ------------------------------------------------------------ the pool

    /**
     * The pool exists and is priced before a single token is sold.
     *
     * @dev Not a detail. `initialize` is permissionless and can only happen
     *      once, so a pool still unpriced at graduation is one a stranger can
     *      price first, for free, at whatever number they like. Doing it in the
     *      constructor means there is no window: the vault's address does not
     *      exist until that transaction.
     */
    function test_the_pool_is_priced_before_anybody_can_price_it() public view {
        address p = curve.pool();
        assertTrue(p != address(0), "no pool");
        (uint160 sqrtP,,,,,,) = IUniV3Pool(p).slot0();
        assertGt(sqrtP, 0, "pool left unpriced");
    }

    /**
     * **A stranger setting the pool price must not be able to change what
     * graduation mints, in either direction.**
     *
     * This is a regression test for a real bug, and the numbers are why it is
     * worth the length. `_seedPool` used to read `slot0` and size the tranche
     * from it: the usdg budget was fixed and the token side was whatever that
     * budget bought at whatever price the pool happened to say. Since the pool
     * has no liquidity until this very transaction, that price was free for
     * anybody to set.
     *
     * Priced a hundred times too low, the budget bought a hundred times the
     * tokens: the tranche went from a twentieth of the supply to five sixths of
     * it, and the backing behind everybody who funded the raise fell from 95% to
     * 17%. Priced far too high the tranche rounded to nothing and graduation
     * reverted, which blocked the raise for the price of a shove.
     *
     * Three identical launches. One left alone, one shoved a hundredfold each
     * way. All three must mint the same tranche, to the wei, and all three must
     * seed at the price the curve itself closes at rather than the one they were
     * shoved to.
     */
    function test_a_shoved_pool_price_cannot_change_what_graduation_mints() public {
        // One curve, three histories, rather than three curves. They have to be
        // the same curve: a vault deployed at a different address sorts the
        // other way round against usdg, which flips which side of the position
        // is computed from the budget and which follows, and the two round to
        // numbers tens of thousands of wei apart. That is a rounding difference
        // and not an attack, and comparing across it would either hide a real
        // one behind a tolerance or fail on nothing.
        BasketCurve c = _launch(THRESHOLD, "Shoved", "SHOVE");

        uint256 snap = vm.snapshotState();
        uint256 honest = _graduateShoved(c, 0);
        vm.revertToStateAndDelete(snap);

        snap = vm.snapshotState();
        uint256 low = _graduateShoved(c, -1);
        vm.revertToStateAndDelete(snap);

        uint256 high = _graduateShoved(c, 1);

        console.log("tranche, pool left alone   ", honest);
        console.log("tranche, price shoved down ", low);
        console.log("tranche, price shoved up   ", high);

        assertEq(low, honest, "a shove down changed the tranche");
        assertEq(high, honest, "a shove up changed the tranche");
    }

    /// Shove the pool, run the raise to the end, graduate, and report the tranche.
    function _graduateShoved(BasketCurve c, int8 direction) internal returns (uint256 tranche) {
        address p = c.pool();
        (uint160 atLaunch,,,,,,) = IUniV3Pool(p).slot0();

        if (direction < 0) _shove(p, uint256(atLaunch) / 100);
        if (direction > 0) _shove(p, uint256(atLaunch) * 100);

        _buy(c, alice, THRESHOLD);
        c.graduate(_zeros());

        (uint160 seeded,,,,,,) = IUniV3Pool(p).slot0();
        assertEq(seeded, atLaunch, "graduation seeded at a price a stranger chose");

        BasketVault v = c.vault();
        tranche = v.totalSupply() - c.sold();

        // The budget minted for the corrective swap is burned in the same
        // transaction. Anything still here would be supply with a claim on the
        // backing that nobody can ever exercise, which is every holder diluted.
        assertEq(IERC20C(address(v)).balanceOf(address(c)), c.sold(), "reprice budget left behind as supply");
    }

    /**
     * The same basket, launched twice, is the same basket. A leg named twice is
     * not a smaller version of that: the vault pays every leg out of one balance
     * on redemption, so a token listed twice is paid twice, and a holder taking
     * a share `s` of the supply would walk off with `s * (2 - s)` of it. The
     * router allows it because to the router they are two swaps. Here they are
     * refused at launch.
     */
    function test_a_basket_cannot_name_the_same_leg_twice() public {
        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](2);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: FEE_LOW, weightBps: 5000});
        legs[1] = BasketRouter.Leg({token: NVDA, fee: FEE_LOW, weightBps: 5000});

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketVault.DuplicateLeg.selector, NVDA));
        factory.launch(legs, 50, THRESHOLD, "Double", "DBL", "", "");
    }

    /**
     * A curve whose threshold is over the router's size cap raises money it can
     * never spend: graduation is a `router.buy` and it would revert `OverCap`
     * every time, with the raise stuck behind a threshold that has already been
     * met. Caught at launch instead.
     */
    function test_a_threshold_over_the_routers_cap_cannot_launch() public {
        address[] memory quotes = new address[](1);
        quotes[0] = USDG;
        BasketRouter capped = new BasketRouter(FACTORY, protocolFeeTo, address(this), 5_000e6, quotes);
        BasketFactory cappedFactory = new BasketFactory(capped, USDG);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketCurve.ThresholdOverCap.selector, THRESHOLD, uint256(5_000e6)));
        cappedFactory.launch(_legs(), 50, THRESHOLD, "Capped", "CAP", "", "");
    }

    /**
     * After graduation the token has somewhere to trade. This buys it out of the
     * pool with real USDG and sells it back, which is the whole point of the
     * tranche: before this step the only exit was redemption.
     */
    function test_the_token_can_be_traded_after_graduation() public {
        _buy(curve, alice, THRESHOLD);
        curve.graduate(_zeros());

        address p = curve.pool();
        assertGt(IERC20C(address(vault)).balanceOf(p), 0, "pool holds no token");
        assertGt(IERC20C(USDG).balanceOf(p), 0, "pool holds no usdg");

        uint256 got = _swapUsdgForToken(stranger, 100e6);
        console.log("$100 bought from the pool", got);
        assertGt(got, 0, "could not buy from the pool");

        // And the token bought this way is a real claim: it redeems.
        vm.prank(stranger);
        vault.redeem(got);
        assertGt(IERC20C(NVDA).balanceOf(stranger), 0, "pool bought token did not redeem");
    }

    /**
     * **The property the whole shape depends on.** The pool must open above what
     * the basket behind it is worth.
     *
     * If it opened at or below the backing, the first trade would take it below,
     * and the arbitrage that is supposed to be a floor under the market would
     * instead be the opening trade against the liquidity that was just seeded.
     * Opening above means the floor sits underneath the price where a floor
     * belongs.
     */
    function test_the_pool_opens_above_the_floor() public {
        _buy(curve, alice, THRESHOLD);
        curve.graduate(_zeros());

        // Buy the token out of the pool, redeem it for stock, and sell the stock
        // straight back. Everything is priced by the real pools, so no oracle is
        // needed and the answer is a single signed number: what the round trip
        // did to the money.
        uint256 spent = 200e6;
        uint256 bought = _swapUsdgForToken(stranger, spent);
        assertGt(bought, 0, "bought nothing");

        vm.startPrank(stranger);
        vault.redeem(bought);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = IERC20C(NVDA).balanceOf(stranger);
        amounts[1] = IERC20C(TSLA).balanceOf(stranger);
        IERC20C(NVDA).approve(address(router), amounts[0]);
        IERC20C(TSLA).approve(address(router), amounts[1]);
        uint256 back = router.sell(indexId, amounts, _zeros());
        vm.stopPrank();

        int256 profit = int256(back) - int256(spent);
        console.log("bought from the pool, redeemed, sold the stock back:");
        console.log("  usdg in ", spent);
        console.log("  usdg out", back);
        console.logInt(profit);

        // If this were profitable the pool would be sitting below the backing,
        // and the arbitrage meant to hold the floor up would instead be the
        // first trade against the liquidity just seeded. It opens above.
        assertLt(back, spent, "the pool opened at or below the floor");
    }

    /**
     * What the LP tranche actually costs the people who funded it, measured
     * rather than claimed, because it is the number the copy has to be honest
     * about.
     *
     * Twenty percent of the raise seeds the pool instead of buying stock, and
     * the tranche minted against it dilutes the same legs, so a curve buyer's
     * floor lands below what they paid. The test pins the band rather than an
     * exact figure, since the legs are bought at real pool prices.
     */
    function test_what_the_pool_tranche_costs_the_floor() public {
        uint256 got = _buy(curve, alice, THRESHOLD);
        curve.graduate(_zeros());

        vm.prank(alice);
        curve.claim();

        // Redeem the lot and see what a $10,000 raise leaves you holding.
        (, uint256[] memory backing) = vault.backingOf(got);
        uint256 lpTokens = vault.totalSupply() - curve.sold();

        console.log("curve supply sold ", curve.sold());
        console.log("pool tranche      ", lpTokens);
        console.log("supply            ", vault.totalSupply());

        // The tranche is a fifth of the raise at four times the average price
        // the curve sold at, so it lands near a twentieth of the supply.
        assertApproxEqRel(lpTokens, curve.sold() / 20, 0.02e18, "the tranche is not the size the constants imply");

        // And the floor is the backing, which is real and is not zero.
        assertGt(backing[0], 0, "no NVDA behind the float");
        assertGt(backing[1], 0, "no TSLA behind the float");
    }

    /**
     * The liquidity is not locked on a timer, it is unreachable. Nothing in this
     * contract can move it, so the check is that the functions which would are
     * absent rather than guarded.
     */
    function test_the_liquidity_cannot_be_pulled_back_out() public {
        _buy(curve, alice, THRESHOLD);
        curve.graduate(_zeros());

        address p = curve.pool();
        uint256 poolUsdg = IERC20C(USDG).balanceOf(p);
        uint256 poolToken = IERC20C(address(vault)).balanceOf(p);

        // No burn, no sweep, no owner. A call to any of them is a call to a
        // function that does not exist.
        //
        // `collectFees` is the exception and it is deliberate: the curve does
        // have one function that reaches into the pool, because the pool's
        // trading fees are a creator's only revenue. What it cannot do is move
        // the principal, and that is asserted by measuring the position rather
        // than by the absence of code. See
        // test_the_creator_earns_the_pools_trading_fees.
        (bool a,) =
            address(curve).call(abi.encodeWithSignature("burn(int24,int24,uint128)", int24(0), int24(0), uint128(0)));
        (bool c,) = address(curve).call(abi.encodeWithSignature("sweep(address)", USDG));
        (bool d,) = address(curve).call(abi.encodeWithSignature("owner()"));
        assertFalse(a, "the curve has a burn");
        assertFalse(c, "the curve has a sweep");
        assertFalse(d, "the curve has an owner");

        // And nobody else can burn a position they do not own: a stranger
        // calling burn on the pool touches their own empty position, not ours.
        vm.prank(stranger);
        (bool e,) =
            p.call(abi.encodeWithSignature("burn(int24,int24,uint128)", int24(-887220), int24(887220), uint128(1)));
        assertFalse(e, "a stranger burned liquidity they do not own");

        assertEq(IERC20C(USDG).balanceOf(p), poolUsdg, "usdg left the pool");
        assertEq(IERC20C(address(vault)).balanceOf(p), poolToken, "token left the pool");

        // Collecting with nothing traded takes nothing, so the one function
        // that does reach the pool cannot be used to drain an untraded one.
        uint128 liquidityBefore = IUniV3Pool(p).liquidity();
        (uint256 usdgOut, uint256 tokenOut) = curve.collectFees();
        assertEq(usdgOut + tokenOut, 0, "collected fees that were never earned");
        assertEq(IUniV3Pool(p).liquidity(), liquidityBefore, "the liquidity moved");
        assertEq(IERC20C(USDG).balanceOf(p), poolUsdg, "usdg left the pool on collect");
        assertEq(IERC20C(address(vault)).balanceOf(p), poolToken, "token left the pool on collect");
    }

    /**
     * **The creator's actual revenue, and the thing it must not be able to
     * take.**
     *
     * The router's creator fee is charged on a buy and graduation is the only
     * buy a basket ever makes, so it pays about forty dollars once and then
     * nothing forever. The pool charges 0.3% on every trade for the life of the
     * token, and those fees were accruing to a position nobody could reach.
     *
     * What has to be true is that collecting them cannot reach the liquidity
     * itself. `burn` is called once, with zero, so `tokensOwed` can only ever
     * hold fees. This trades against the real pool to make real fees, collects
     * them, and reads the position's liquidity back.
     */
    function test_the_creator_earns_the_pools_trading_fees() public {
        _buy(curve, alice, THRESHOLD);
        curve.graduate(_zeros());

        uint128 liquidityBefore = IUniV3Pool(curve.pool()).liquidity();
        assertGt(liquidityBefore, 0, "no liquidity was seeded");

        _tradeBothWays(500e6);

        uint256 usdgBefore = IERC20C(USDG).balanceOf(creator);
        uint256 tokenBefore = IERC20C(address(vault)).balanceOf(creator);

        (uint256 usdgOut, uint256 tokenOut) = curve.collectFees();
        console.log("creator fees on a $500 round trip, usdg ", usdgOut);
        console.log("creator fees on a $500 round trip, token", tokenOut);

        assertGt(usdgOut, 0, "no usdg fees");
        assertGt(tokenOut, 0, "no token fees");
        assertEq(IERC20C(USDG).balanceOf(creator) - usdgBefore, usdgOut, "usdg did not reach the creator");
        assertEq(IERC20C(address(vault)).balanceOf(creator) - tokenBefore, tokenOut, "token did not reach the creator");

        // The whole safety argument, in one assertion: the position is exactly
        // as large as it was. Fees left, principal did not.
        assertEq(IUniV3Pool(curve.pool()).liquidity(), liquidityBefore, "the liquidity moved");
    }

    /**
     * Collecting twice does not pay twice, and anybody may call it but only the
     * creator is ever paid.
     */
    function test_fees_pay_the_creator_and_only_once() public {
        _buy(curve, alice, THRESHOLD);
        curve.graduate(_zeros());
        _tradeBothWays(500e6);

        vm.prank(stranger);
        (uint256 usdgOut,) = curve.collectFees();
        assertGt(usdgOut, 0, "nothing collected");
        assertEq(IERC20C(USDG).balanceOf(stranger), 0, "the caller was paid");

        // Nothing has traded since, so there is nothing left owed.
        (uint256 again, uint256 againToken) = curve.collectFees();
        assertEq(again + againToken, 0, "collected the same fees twice");
    }

    /// There is no pool position to collect from until graduation has made one.
    function test_fees_cannot_be_collected_before_graduation() public {
        _buy(curve, alice, 1_000e6);
        vm.expectRevert(BasketCurve.NotGraduated.selector);
        curve.collectFees();
    }

    /// The mint callback is only reachable from the pool, mid mint.
    /**
     * The swap callback is the one that can move the token, so it is the one
     * worth pinning.
     *
     * `_repricePool` is the only thing that ever opens it, and it opens it for
     * exactly one call. Outside that window nobody may reach it, the real pool
     * included: a pool that could call this at any time could ask for the
     * curve's whole balance.
     */
    function test_the_swap_callback_rejects_a_stranger() public {
        vm.prank(stranger);
        vm.expectRevert(BasketCurve.UnknownCaller.selector);
        curve.uniswapV3SwapCallback(1, 1, "");

        vm.prank(curve.pool());
        vm.expectRevert(BasketCurve.UnknownCaller.selector);
        curve.uniswapV3SwapCallback(1, 1, "");
    }

    /**
     * The reprice budget can only ever be burned by the curve, once.
     *
     * The vault's guarantee is that nobody can take the backing, and a burn is
     * the one thing that changes the supply the backing is divided by. It only
     * ever destroys the caller's own balance, so it can only give up a claim,
     * but a minter that could call it twice could burn tokens its buyers had
     * not claimed yet. Graduation uses its one call; there is no second.
     */
    function test_the_reprice_budget_can_only_be_burned_once_and_only_by_the_curve() public {
        _buy(curve, alice, THRESHOLD);
        curve.graduate(_zeros());

        vm.prank(stranger);
        vm.expectRevert(BasketVault.NotMinter.selector);
        vault.burnUnused(1);

        // The curve has already spent its one burn inside `graduate`.
        vm.prank(address(curve));
        vm.expectRevert(BasketVault.AlreadySettled.selector);
        vault.burnUnused(1);

        // And nothing was left holding a claim nobody can exercise: the curve
        // keeps exactly what its buyers have yet to claim.
        assertEq(vault.balanceOf(address(curve)), curve.sold(), "reprice budget survived graduation");
    }

    function test_the_mint_callback_rejects_a_stranger() public {
        vm.prank(stranger);
        vm.expectRevert(BasketCurve.UnknownCaller.selector);
        curve.uniswapV3MintCallback(1, 1, "");

        // Not even the real pool, outside a mint of ours.
        vm.prank(curve.pool());
        vm.expectRevert(BasketCurve.UnknownCaller.selector);
        curve.uniswapV3MintCallback(1, 1, "");
    }

    // --------------------------------------------------------- the pairing

    /**
     * The vault is built by the curve from the index's own legs, so there is no
     * deployment step where a curve can be pointed at a vault holding something
     * else. A curve for an index nobody published cannot be built at all.
     */
    function test_the_vault_is_the_index() public {
        address[] memory legs = vault.legs();
        BasketRouter.Leg[] memory published = router.legsOf(indexId);

        assertEq(legs.length, published.length, "leg count differs");
        for (uint256 i; i < legs.length; ++i) {
            assertEq(legs[i], published[i].token, "leg differs from the index");
        }
        assertEq(vault.minter(), address(curve), "somebody else can mint");
        assertEq(curve.usdg(), router.inputOf(indexId), "raising a currency the index cannot spend");
        assertEq(curve.creator(), creator, "the launcher is not the creator");

        // A basket the router would refuse cannot be launched at all, because
        // the index is published from inside the curve's own constructor.
        BasketRouter.Leg[] memory bad = _legs();
        bad[0].weightBps = 1; // no longer sums to ten thousand
        vm.expectRevert(BasketRouter.WeightsMustSumToBps.selector);
        factory.launch(bad, 50, THRESHOLD, "Nope", "NOPE", "", "");
    }

    // -------------------------------------------------------- the factory

    /**
     * A launch is one transaction and it leaves something to find.
     *
     * Without the event there is nothing to index: the site cannot list a
     * basket nobody told it about, which is why every curve before this one had
     * to be pasted into an environment variable by hand.
     */
    function test_a_launch_is_one_transaction_and_is_findable() public {
        uint256 before = factory.count();

        vm.prank(alice);
        (BasketCurve c, uint256 id) = factory.launch(_legs(), 25, 5_000e6, "Second", "SEC", "another one", "");

        assertEq(factory.count(), before + 1, "not recorded");
        assertEq(factory.curves(before), address(c), "not in the list");
        assertEq(factory.curveOfIndex(id), address(c), "index does not point back");
        assertEq(c.creator(), alice, "wrong creator");
        assertEq(c.threshold(), 5_000e6, "wrong threshold");
        assertEq(c.indexId(), id, "index id disagrees");

        // The whole thing exists already: index, token, vault and pool.
        assertTrue(address(c.vault()) != address(0), "no vault");
        assertTrue(c.pool() != address(0), "no pool");
        assertEq(router.legsOf(id).length, 2, "index not published");
        assertEq(factory.all().length, before + 1, "all() disagrees with count()");
    }

    /**
     * A creator's own picture rides on the launch, and only as a link.
     *
     * The composition is still the artwork and a basket with no picture draws
     * one from its weights, which is why every tile on this site is a tile
     * rather than a grey placeholder. But a basket token is a token people
     * name and share, and refusing them a picture is refusing them the thing
     * they came to do.
     *
     * The contract can say three things about a url and no more: how long it
     * is, that it is optional, and that it starts like a link. It cannot fetch
     * one and cannot tell an image from anything else, so it rejects the shapes
     * that certainly are not links and leaves the rest to whoever renders it.
     */
    function test_a_launch_carries_a_picture_and_only_a_link() public {
        string memory url = "https://motif.fund/v1/images/abc";

        vm.recordLogs();
        vm.prank(alice);
        factory.launch(_legs(), 25, 5_000e6, "Pictured", "PIC", "", url);

        // The image has to be in the log, because that is the only place an
        // indexer looks: it is not on the curve, not on the vault, and not
        // anywhere a call could read it back from.
        bytes32 topic = keccak256(
            "Launched(address,address,uint256,address,address,uint256,uint16,uint256,string,string,string,string)"
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            (,,,,,,,, string memory image) = abi.decode(
                logs[i].data, (address, address, uint256, uint16, uint256, string, string, string, string)
            );
            assertEq(image, url, "the picture did not survive the log");
            found = true;
        }
        assertTrue(found, "no Launched event");

        for (uint256 i; i < 3; ++i) {
            string memory bad = i == 0
                ? "javascript:alert(1)"
                : i == 1 ? "data:image/svg+xml;base64,AAAA" : "http://motif.fund/insecure.png";
            vm.prank(alice);
            vm.expectRevert(BasketFactory.BadImage.selector);
            factory.launch(_legs(), 25, 5_000e6, "Bad", "BAD", "", bad);
        }

        // And it is bounded, for the same reason the name and the description
        // are: a launch must not be made expensive for everybody reading the log.
        string memory tooLong = string(abi.encodePacked("https://", new bytes(200)));
        vm.prank(alice);
        vm.expectRevert(BasketFactory.BadImage.selector);
        factory.launch(_legs(), 25, 5_000e6, "Long", "LONG", "", tooLong);
    }

    /**
     * The creator fee reaches the creator.
     *
     * The router pays it to whoever published the index, and that is the curve,
     * because publishing from anywhere else either hands every creator's fee to
     * a factory or leaves the curve open for a stranger to attach first. So the
     * curve forwards it, and this is the test that it actually arrives.
     */
    function test_the_creator_is_paid_their_fee() public {
        _buy(curve, alice, THRESHOLD);
        uint256 before = IERC20C(USDG).balanceOf(creator);

        curve.graduate(_zeros());

        uint256 paid = IERC20C(USDG).balanceOf(creator) - before;
        console.log("creator fee on a $10,000 raise, in usdg units:", paid);

        // 50 bps of the stock budget, which is the raise less the pool tranche.
        uint256 stockSpend = THRESHOLD - IERC20C(USDG).balanceOf(curve.pool());
        assertEq(paid, (stockSpend * 50) / 10_000, "creator fee wrong");
        assertGt(paid, 0, "creator was paid nothing");

        // And the curve kept none of it.
        assertEq(IERC20C(USDG).balanceOf(address(curve)), 0, "usdg left in the curve");
    }
}
