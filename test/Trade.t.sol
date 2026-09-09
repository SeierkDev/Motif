// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {BasketRouter, IUniswapV3Factory} from "../src/BasketRouter.sol";
import {BasketCurve} from "../src/BasketCurve.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {BasketFactory} from "../src/BasketFactory.sol";
import {TokenSwap} from "../src/TokenSwap.sol";

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * @title Selling a basket token at the market, rather than only at its floor
 *
 * A graduated basket has two ways out and they pay different amounts.
 * `redeem` pays the backing, always, to anybody, and is the floor the whole
 * design rests on. The pool pays whatever the market says, which at graduation
 * is well above that floor.
 *
 * Until `TokenSwap` there was only the first, because a Uniswap V3 pool calls
 * back into its caller for the input and a wallet has no code to answer with.
 * The site could therefore show a price nobody could trade at, and a holder
 * looking for a sell button found a redeem button and an address. That reads
 * as a token you are not allowed to sell.
 *
 * So the thing worth measuring here is not that a swap swaps. It is that the
 * market exit is real, that it pays more than the floor exit at the moment a
 * basket graduates, and that the contract in front of the pool cannot be made
 * to spend anybody's approval but its caller's.
 */
contract TradeForkTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    uint24 constant FEE_LOW = 500;
    uint24 constant FEE_MID = 3000;
    /// The tier BasketCurve opens a basket token's own pool at.
    uint24 constant LP_FEE = 3000;

    uint256 constant THRESHOLD = 10_000e6;

    BasketRouter router;
    BasketFactory factory;
    BasketCurve curve;
    BasketVault vault;
    TokenSwap swapper;

    address creator = makeAddr("creator");
    address protocolFeeTo = makeAddr("protocolFeeTo");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    function _forkUrl() internal view returns (string memory) {
        return vm.envOr("MOTIF_RPC", string("https://rpc.mainnet.chain.robinhood.com"));
    }

    function setUp() public {
        vm.createSelectFork(_forkUrl());

        address[] memory quotes = new address[](1);
        quotes[0] = USDG;
        router = new BasketRouter(FACTORY, protocolFeeTo, address(this), 0, quotes);
        factory = new BasketFactory(router, USDG);
        swapper = new TokenSwap(FACTORY);

        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](2);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: FEE_LOW, weightBps: 6000});
        legs[1] = BasketRouter.Leg({token: TSLA, fee: FEE_MID, weightBps: 4000});

        vm.prank(creator);
        (curve,) = factory.launch(legs, 50, THRESHOLD, "AI Core", "AICORE", "", "");
        vault = curve.vault();

        // Fill the raise and graduate, so the pool this file trades in exists
        // with the liquidity graduation seeded into it.
        deal(USDG, alice, THRESHOLD);
        vm.startPrank(alice);
        IERC20T(USDG).approve(address(curve), THRESHOLD);
        curve.buy(THRESHOLD, 0);
        vm.stopPrank();
        curve.graduate(new uint256[](2));
        assertTrue(curve.graduated(), "setup did not graduate");
    }

    /// Buy the token out of its own pool with usdg, the way a trader would.
    function _buyFromPool(address who, uint256 usdgIn) internal returns (uint256 out) {
        deal(USDG, who, usdgIn);
        vm.startPrank(who);
        IERC20T(USDG).approve(address(swapper), usdgIn);
        out = swapper.swap(USDG, address(vault), LP_FEE, usdgIn, 0, block.timestamp);
        vm.stopPrank();
    }

    function _sellToPool(address who, uint256 tokensIn) internal returns (uint256 out) {
        vm.startPrank(who);
        IERC20T(address(vault)).approve(address(swapper), tokensIn);
        out = swapper.swap(address(vault), USDG, LP_FEE, tokensIn, 0, block.timestamp);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- the exit

    /**
     * The sell that did not exist. A holder who claimed their curve position
     * puts it into the pool and gets usdg back, in one transaction, without
     * touching the vault.
     */
    function test_a_holder_can_sell_into_the_pool() public {
        vm.prank(alice);
        uint256 held = curve.claim();
        assertGt(held, 0, "nothing claimed");

        // A hundredth of the position. The pool was seeded with a twentieth of
        // the supply, so anything much larger is measuring how far one trade
        // moves a thin pool rather than whether selling works at all.
        uint256 sell = held / 100;
        uint256 before = IERC20T(USDG).balanceOf(alice);
        uint256 got = _sellToPool(alice, sell);

        console.log("sold, tokens", sell);
        console.log("received usdg", got);
        assertGt(got, 0, "the pool paid nothing");
        assertEq(IERC20T(USDG).balanceOf(alice) - before, got, "the proceeds did not reach the seller");
        assertEq(IERC20T(address(vault)).balanceOf(alice), held - sell, "the wrong amount left the wallet");
    }

    /// And the other direction, which is the only way to buy after graduation.
    function test_anybody_can_buy_the_token_out_of_the_pool() public {
        uint256 got = _buyFromPool(bob, 200e6);
        console.log("$200 bought, tokens", got);
        assertGt(got, 0, "bought nothing");
        assertEq(IERC20T(address(vault)).balanceOf(bob), got, "the token did not reach the buyer");
    }

    /**
     * **The reason this contract exists rather than pointing people at redeem.**
     *
     * A basket graduates trading above its backing, by design: the pool is
     * seeded at the curve's closing price and the backing is diluted by the
     * tranche that seeds it. So at that moment the market exit pays more than
     * the floor exit, and a site that offered only the floor would be quietly
     * telling holders to take the worse of the two.
     *
     * Measured both ways on the same position at the same block, so the numbers
     * are comparable rather than merely both true.
     */
    function test_selling_at_the_market_beats_redeeming_at_the_floor() public {
        vm.prank(alice);
        uint256 held = curve.claim();
        uint256 slice = held / 200;

        uint256 snap = vm.snapshotState();

        // Route one: sell it in the pool.
        uint256 market = _sellToPool(alice, slice);

        vm.revertToStateAndDelete(snap);

        // Route two: redeem it for stock and sell the stock back through the
        // router, which is what a holder had to do before this existed.
        vm.startPrank(alice);
        vault.redeem(slice);
        uint256 nvda = IERC20T(NVDA).balanceOf(alice);
        uint256 tsla = IERC20T(TSLA).balanceOf(alice);
        IERC20T(NVDA).approve(address(router), nvda);
        IERC20T(TSLA).approve(address(router), tsla);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = nvda;
        amounts[1] = tsla;
        uint256 usdgBefore = IERC20T(USDG).balanceOf(alice);
        router.sell(curve.indexId(), amounts, new uint256[](2));
        uint256 floor = IERC20T(USDG).balanceOf(alice) - usdgBefore;
        vm.stopPrank();

        console.log("selling in the pool, usdg  ", market);
        console.log("redeeming and selling, usdg", floor);
        assertGt(market, floor, "the market exit did not beat the floor exit");
    }

    // ------------------------------------------------------------ the bounds

    function test_a_minimum_that_cannot_be_met_reverts_the_whole_swap() public {
        deal(USDG, bob, 200e6);
        vm.startPrank(bob);
        IERC20T(USDG).approve(address(swapper), 200e6);
        vm.expectRevert();
        swapper.swap(USDG, address(vault), LP_FEE, 200e6, type(uint128).max, block.timestamp);
        vm.stopPrank();
        assertEq(IERC20T(USDG).balanceOf(bob), 200e6, "a reverted swap still spent the money");
    }

    function test_a_deadline_in_the_past_reverts() public {
        deal(USDG, bob, 100e6);
        vm.startPrank(bob);
        IERC20T(USDG).approve(address(swapper), 100e6);
        vm.expectRevert(abi.encodeWithSelector(TokenSwap.Expired.selector, block.timestamp - 1));
        swapper.swap(USDG, address(vault), LP_FEE, 100e6, 0, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_a_pair_with_no_pool_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(TokenSwap.NoPool.selector, USDG, address(vault), uint24(100)));
        swapper.swap(USDG, address(vault), 100, 1e6, 0, block.timestamp);
    }

    function test_zero_in_reverts() public {
        vm.expectRevert(TokenSwap.ZeroAmount.selector);
        swapper.swap(USDG, address(vault), LP_FEE, 0, 0, block.timestamp);
    }

    // ----------------------------------------------------------- the approval

    /**
     * An allowance to this contract is worth nothing to anybody but its owner,
     * and that is the whole safety claim. `payer` is encoded by `swap` as its
     * own `msg.sender` and there is no path that sets it to anything else, so
     * the only way to reach the callback at all is to be the pool, mid swap,
     * for a swap this contract started.
     */
    function test_the_callback_rejects_a_stranger() public {
        vm.prank(stranger);
        vm.expectRevert(TokenSwap.UnknownCaller.selector);
        swapper.uniswapV3SwapCallback(1e6, 0, abi.encode(USDG, address(vault), LP_FEE, alice));
    }

    /**
     * The pool itself cannot reach it outside a swap either. This is the case
     * that matters: the address check alone would pass here, and the cap is
     * what actually refuses.
     */
    function test_the_real_pool_cannot_reach_the_callback_outside_a_swap() public {
        vm.prank(curve.pool());
        vm.expectRevert(TokenSwap.UnknownCaller.selector);
        swapper.uniswapV3SwapCallback(1e6, 0, abi.encode(USDG, address(vault), LP_FEE, alice));
    }

    /// Nothing is ever left here, so there is nothing for anybody to come back for.
    function test_it_holds_nothing_afterwards() public {
        vm.prank(alice);
        uint256 held = curve.claim();
        _sellToPool(alice, held / 100);
        _buyFromPool(bob, 200e6);

        assertEq(IERC20T(USDG).balanceOf(address(swapper)), 0, "usdg left behind");
        assertEq(IERC20T(address(vault)).balanceOf(address(swapper)), 0, "token left behind");
        assertEq(IERC20T(NVDA).balanceOf(address(swapper)), 0, "nvda left behind");
    }

    /**
     * A round trip through the pool has to lose, or the pool is a faucet. It
     * loses the 0.3% twice plus the price it moved, and that is the same
     * property `test/Curve.t.sol` pins on the curve itself.
     */
    function test_a_round_trip_through_the_pool_loses() public {
        uint256 spent = 200e6;
        uint256 got = _buyFromPool(bob, spent);
        uint256 back = _sellToPool(bob, got);
        console.log("usdg in ", spent);
        console.log("usdg out", back);
        assertLt(back, spent, "buying and selling back returned at least what it cost");
    }
}
