// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Orders} from "../src/Orders.sol";
import {PoolPrice} from "../src/PoolPrice.sol";
import {IUniswapV3Factory} from "../src/BasketRouter.sol";
import {IPermit2} from "../src/IPermit2.sol";

interface IERC20S {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * @title Orders and corporate actions
 *
 * @dev **The gap this file closes.** `uiMultiplier` appeared in
 *      `Rebalancer.sol` and nowhere else, so `Orders` traded straight through a
 *      split. That is the worse of the two places to be missing it. A rebalance
 *      is a ratio and a ratio survives a split; a stop is an absolute price and
 *      does not. A two for one split halves what one token is worth, the pool
 *      price halves with it, and every stop under that level reads as triggered
 *      by a crash that never happened.
 *
 *      Nothing was ever sold at the wrong price, and `test_why_this_was_not_a
 *      _theft` measures why: the fill floor anchors on the owner's pre-split
 *      trigger, so it demands about twice what the tokens are now worth and the
 *      swap reverts. But that is a safe accident rather than a design. `ready`
 *      reported the order fillable, every execution reverted `Underfilled`, and
 *      nothing said the word split.
 */
contract SplitForkTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant PERMIT2_ADDR = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint24 constant FEE = 500;
    uint16 constant SLIPPAGE_BPS = 300;

    Orders orders;
    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");
    uint256 spot;

    function _forkUrl() internal view returns (string memory) {
        return vm.envOr("MOTIF_RPC", string("https://rpc.mainnet.chain.robinhood.com"));
    }

    function setUp() public {
        vm.createSelectFork(_forkUrl());
        orders = new Orders(FACTORY, USDG, address(this), 0);

        deal(NVDA, owner, 20e18);
        deal(USDG, owner, 20_000e6);
        vm.startPrank(owner);
        IERC20S(NVDA).approve(PERMIT2_ADDR, type(uint256).max);
        IPermit2(PERMIT2_ADDR).approve(NVDA, address(orders), type(uint160).max, type(uint48).max);
        vm.stopPrank();

        spot = PoolPrice.usdgPerToken(FACTORY.getPool(USDG, NVDA, FEE), USDG < NVDA);
        assertGt(spot, 1e18, "pool price should be a sane dollar figure");
    }

    /// A stop that is already armed: the trigger sits above spot, so it fires.
    function _armedStop(uint256 amount) internal returns (uint256 id) {
        Orders.Order memory o;
        o.token = NVDA;
        o.fee = FEE;
        o.maxSlippageBps = SLIPPAGE_BPS;
        o.kind = Orders.Kind.StopLoss;
        o.trigger = (spot * 101) / 100;
        o.amount = amount;
        vm.prank(owner);
        id = orders.place(o);
    }

    /// A two for one split doubles the multiplier. The same lever
    /// `Rebalancer.t.sol` pulls, because a real one cannot be produced to order.
    function _split() internal {
        vm.mockCall(NVDA, abi.encodeWithSignature("uiMultiplier()"), abi.encode(uint256(2e18)));
    }

    // ------------------------------------------------------------- the freeze

    function test_a_split_freezes_a_stop() public {
        uint256 id = _armedStop(2e18);
        uint256 was = orders.multiplierAt(id);

        (bool ok,,) = orders.ready(id);
        assertTrue(ok, "the stop should be armed before the split");

        _split();

        string memory why;
        (ok, why,) = orders.ready(id);
        assertFalse(ok, "a split must freeze the order, not fire it");
        assertEq(why, "corporate action pending", "the reason has to name the cause");

        vm.expectRevert(abi.encodeWithSelector(Orders.CorporateActionPending.selector, id, was, uint256(2e18)));
        orders.execute(id);
    }

    /// A TWAP has no trigger at all and anchors its floor on spot, so it was the
    /// one order that would have sold straight through a split at the new price.
    function test_a_split_freezes_a_twap() public {
        Orders.Order memory o;
        o.token = NVDA;
        o.fee = FEE;
        o.maxSlippageBps = SLIPPAGE_BPS;
        o.kind = Orders.Kind.Twap;
        o.amount = 2e18;
        o.slices = 4;
        o.interval = 1 hours;
        vm.prank(owner);
        uint256 id = orders.place(o);

        (bool ok,,) = orders.ready(id);
        assertTrue(ok, "a fresh twap should be fillable");

        _split();
        (ok,,) = orders.ready(id);
        assertFalse(ok, "a twap must freeze too");
    }

    /**
     * The measurement that says why the old behaviour was a wedge rather than a
     * theft, and why it was invisible.
     *
     * The floor is `amountIn * trigger / 1e30` less slippage, anchored on the
     * pre-split trigger. After a two for one split the same tokens fetch half
     * as much, so the floor asks for roughly twice what the pool can pay and
     * `execute` reverts every single time.
     */
    function test_why_this_was_not_a_theft() public view {
        uint256 amountIn = 2e18;
        uint256 preSplitTrigger = (spot * 101) / 100;

        uint256 floor = ((amountIn * preSplitTrigger) / 1e30) * (10_000 - SLIPPAGE_BPS) / 10_000;
        // What the same tokens are worth once the split has halved the price.
        uint256 postSplitProceeds = (amountIn * (spot / 2)) / 1e30;

        assertGt(floor, postSplitProceeds, "the floor has to be unreachable, that is the whole point");
        console.log("floor demanded (usdg 6dp)", floor);
        console.log("post split value  (6dp)  ", postSplitProceeds);
        console.log("ratio x100               ", (floor * 100) / postSplitProceeds);
        // Not far off exactly twice, less the slippage the owner allowed.
        assertGt((floor * 100) / postSplitProceeds, 180, "should be near double");
    }

    // -------------------------------------------------------- acknowledgement

    function test_only_the_owner_can_acknowledge() public {
        uint256 id = _armedStop(2e18);
        _split();
        vm.prank(stranger);
        vm.expectRevert(Orders.NotOwner.selector);
        orders.acknowledgeCorporateAction(id, spot);
    }

    function test_acknowledging_an_unchanged_order_is_refused() public {
        uint256 id = _armedStop(2e18);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Orders.NoChange.selector, id));
        orders.acknowledgeCorporateAction(id, spot);
    }

    /// The owner restates the level, and the order works again.
    function test_acknowledging_restates_the_level_and_the_stop_resumes() public {
        uint256 id = _armedStop(2e18);
        _split();

        uint256 restated = (spot * 101) / 100; // armed against today's pool
        vm.prank(owner);
        orders.acknowledgeCorporateAction(id, restated);

        assertEq(orders.multiplierAt(id), 2e18, "the new multiplier has to be recorded");
        assertEq(orders.get(id).trigger, restated, "the owner's number, not a derived one");

        (bool ok, string memory why,) = orders.ready(id);
        assertTrue(ok, why);

        uint256 nvdaBefore = IERC20S(NVDA).balanceOf(owner);
        uint256 usdgBefore = IERC20S(USDG).balanceOf(owner);
        orders.execute(id);
        assertEq(nvdaBefore - IERC20S(NVDA).balanceOf(owner), 2e18, "the whole amount should have gone");
        assertGt(IERC20S(USDG).balanceOf(owner) - usdgBefore, 0, "and usdg should have come back");
    }

    /// A trailing stop names a distance, not a price, so the thing to restate
    /// is the peak and the only honest peak is the price right now.
    function test_a_trailing_stop_reanchors_to_the_current_price() public {
        Orders.Order memory o;
        o.token = NVDA;
        o.fee = FEE;
        o.maxSlippageBps = SLIPPAGE_BPS;
        o.kind = Orders.Kind.TrailingStop;
        o.trailBps = 500;
        o.amount = 2e18;
        vm.prank(owner);
        uint256 id = orders.place(o);

        _split();
        vm.prank(owner);
        orders.acknowledgeCorporateAction(id, 0); // ignored for this kind

        Orders.Order memory after_ = orders.get(id);
        assertEq(after_.peak, spot, "the peak should re-anchor to the pool");
        assertEq(after_.trigger, (spot * 9_500) / 10_000, "and the trigger falls out of trailBps");
    }

    /// A token with no `uiMultiplier` at all must not be frozen forever.
    function test_a_token_without_erc8056_is_never_frozen() public {
        vm.mockCallRevert(NVDA, abi.encodeWithSignature("uiMultiplier()"), "no such method");
        uint256 id = _armedStop(2e18);
        assertEq(orders.multiplierAt(id), 1e18, "an unsplittable token reads as unsplit");
        (bool ok, string memory why,) = orders.ready(id);
        assertTrue(ok, why);
    }
}
