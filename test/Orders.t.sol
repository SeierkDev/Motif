// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Orders} from "../src/Orders.sol";
import {PoolPrice} from "../src/PoolPrice.sol";
import {BasketRouter, IUniswapV3Factory, IUniswapV3Pool, SafeTransfer} from "../src/BasketRouter.sol";
import {Rebalancer} from "../src/Rebalancer.sol";
import {OracleLib, IAggregatorV3} from "../src/OracleLib.sol";
import {IPermit2} from "../src/IPermit2.sol";

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// Pushes a real pool around so a stop has something to fire on.
interface IERC20Permit {
    function approve(address, uint256) external returns (bool);
}

contract Swapper {
    using SafeTransfer for address;

    IUniswapV3Factory immutable factory;

    constructor(IUniswapV3Factory f) {
        factory = f;
    }

    function push(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) external {
        address pool = factory.getPool(tokenIn, tokenOut, fee);
        bool zeroForOne = tokenIn < tokenOut;
        IUniswapV3Pool(pool).swap(
            msg.sender,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? 4_295_128_740 : 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341,
            abi.encode(tokenIn, tokenOut, fee)
        );
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        (address tokenIn,,) = abi.decode(data, (address, address, uint24));
        uint256 owed = a0 > 0 ? uint256(a0) : uint256(a1);
        tokenIn.safeTransfer(msg.sender, owed);
    }
}

/// A Chainlink feed that can be made to go quiet, so a weekend can be simulated.
contract MockFeed is IAggregatorV3 {
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 a) {
        answer = a;
        updatedAt = block.timestamp;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract OrdersForkTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    uint24 constant FEE = 500;

    Orders orders;
    Swapper swapper;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");

    uint256 spot; // USDG per NVDA, 1e18

    /// USDG is the only asset baskets may be priced in for now.
    function _quotes() internal pure returns (address[] memory q) {
        q = new address[](1);
        q[0] = USDG;
    }


    address constant PERMIT2_ADDR = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// The two step the real UI does: approve Permit2 once on the token, then
    /// grant the spender a bounded, expiring permission through it.
    function _permit(address who, address token, address spender) internal {
        vm.startPrank(who);
        IERC20Permit(token).approve(PERMIT2_ADDR, type(uint256).max);
        IPermit2(PERMIT2_ADDR).approve(token, spender, type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }


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
        orders = new Orders(FACTORY, USDG, address(this), 0);
        swapper = new Swapper(FACTORY);

        deal(NVDA, owner, 20e18);
        deal(USDG, owner, 20_000e6);
        _permit(owner, NVDA, address(orders));
        _permit(owner, USDG, address(orders));

        spot = PoolPrice.usdgPerToken(FACTORY.getPool(USDG, NVDA, FEE), USDG < NVDA);
        assertGt(spot, 1e18, "pool price should be a sane dollar figure");
    }

    function _blank() internal view returns (Orders.Order memory o) {
        o.token = NVDA;
        o.fee = FEE;
        o.maxSlippageBps = 300;
    }

    function _stopAt(uint256 trigger, uint256 amount) internal returns (uint256 id) {
        Orders.Order memory o = _blank();
        o.kind = Orders.Kind.StopLoss;
        o.trigger = trigger;
        o.amount = amount;
        vm.prank(owner);
        id = orders.place(o);
    }

    /**
     * THE EXIT TEST FOR PHASE 5.
     *
     * Three days pass with no oracle update, which is exactly a weekend on a
     * 24/5 feed. The rebalancer, which reads the oracle, correctly refuses to do
     * anything. The stop, which reads the pool, fires. That difference is the
     * entire product claim.
     */
    function test_stop_fires_on_a_weekend_when_the_oracle_is_dead() public {
        uint256 id = _stopAt((spot * 101) / 100, 2e18); // armed: spot is under it

        // Stand up a rebalancer on the same tokens, with a feed that stops updating.
        BasketRouter router = new BasketRouter(FACTORY, makeAddr("fees"), address(this), 0, _quotes());
        Rebalancer rb = new Rebalancer(router, FACTORY, USDG, address(this), address(this), 0);
        MockFeed feed = new MockFeed(int256(spot / 1e10)); // 8 decimals
        rb.registerFeed(NVDA, feed);

        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](1);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: FEE, weightBps: 10_000});
        uint256 indexId = router.createIndex(USDG, legs, 0, "Test Basket", "TEST", "");
        vm.prank(owner);
        rb.subscribe(indexId, 500, 100, 1 hours, 1 hours);

        // The market shuts on Friday and nothing updates for three days.
        vm.warp(block.timestamp + 3 days);

        (bool rebalanceOk, string memory why) = rb.shouldRebalance(owner);
        assertFalse(rebalanceOk, "the oracle path should be dead over a weekend");
        assertEq(why, "price too stale");

        (bool orderOk,,) = orders.ready(id);
        assertTrue(orderOk, "the pool path should still be live");

        uint256 usdgBefore = IERC20T(USDG).balanceOf(owner);
        vm.prank(keeper);
        orders.execute(id);

        assertGt(IERC20T(USDG).balanceOf(owner), usdgBefore, "the stop did not pay out");
        assertEq(IERC20T(NVDA).balanceOf(owner), 18e18, "wrong quantity sold");
    }

    function test_stop_does_not_fire_above_the_trigger() public {
        uint256 id = _stopAt((spot * 90) / 100, 1e18); // 10% below spot
        (bool ok, string memory why,) = orders.ready(id);
        assertFalse(ok);
        assertEq(why, "price above the stop");
        vm.prank(keeper);
        vm.expectRevert();
        orders.execute(id);
    }

    /// The pool actually moving is what a stop is for.
    /**
     * Push the pool down until it is actually under `target`, and say so
     * loudly if it will not go.
     *
     * @dev The two tests below sold a hard coded 2,700 NVDA under a comment
     *      saying that moved this pool about 0.68%. It did, on the day it was
     *      written. The pool has deepened since and the same sale no longer
     *      clears a 0.5% stop, so both went red and stayed red on main across
     *      four commits, none of which touched anything they cover.
     *
     *      **A number measured off a live pool has a shelf life, and the
     *      conclusion is what a test should pin.** These two are about whether
     *      a fall arms a stop, not about how many tokens a fall costs, so the
     *      size is found rather than remembered. Steps are additive rather
     *      than doubled so the price lands just under the target instead of
     *      far below it, which would put the fill under the floor the trigger
     *      anchors and turn a passing test into an `Underfilled` revert.
     *
     *      **The stops sit 10bps under spot rather than 50, and that is an rpc
     *      budget decision rather than a cosmetic one.** What this costs the
     *      public endpoint is the tick range walked, not the number of swaps:
     *      every tick crossed is storage the fork has to fetch for the first
     *      time. Halving the distance to the trigger is the lever that
     *      actually reduces distinct requests, and a 0.1% fall arms a 0.1%
     *      stop exactly as truthfully as a 0.5% one arms a 0.5% stop.
     */
    function _pushBelow(uint256 target) internal returns (uint256 price) {
        uint256 step = 1_000e18;
        for (uint256 i; i < 40; ++i) {
            deal(NVDA, address(swapper), step);
            swapper.push(NVDA, USDG, FEE, step);
            price = PoolPrice.usdgPerToken(FACTORY.getPool(USDG, NVDA, FEE), USDG < NVDA);
            if (price < target) break;
        }
        assertLt(price, target, "the pool would not move under the target");
    }

    function test_a_real_price_fall_arms_the_stop() public {
        uint256 trigger = (spot * 9990) / 10_000;
        uint256 id = _stopAt(trigger, 1e18);
        (bool ok,,) = orders.ready(id);
        assertFalse(ok, "should start out of the money");

        uint256 after_ = _pushBelow(trigger);
        assertLt(after_, spot, "the push should have moved the pool down");

        (bool nowOk,,) = orders.ready(id);
        assertTrue(nowOk, "the stop should now be armed");
        vm.prank(keeper);
        orders.execute(id);
    }

    function test_limit_sell_fires_above_the_trigger() public {
        Orders.Order memory o = _blank();
        o.kind = Orders.Kind.LimitSell;
        o.trigger = (spot * 95) / 100; // already above it
        o.amount = 1e18;
        vm.prank(owner);
        uint256 id = orders.place(o);

        uint256 before = IERC20T(USDG).balanceOf(owner);
        vm.prank(keeper);
        orders.execute(id);
        assertGt(IERC20T(USDG).balanceOf(owner), before);
    }

    function test_limit_buy_fires_below_the_trigger() public {
        Orders.Order memory o = _blank();
        o.kind = Orders.Kind.LimitBuy;
        o.trigger = (spot * 105) / 100; // spot is under the limit
        o.amount = 500e6; // USDG
        vm.prank(owner);
        uint256 id = orders.place(o);

        uint256 before = IERC20T(NVDA).balanceOf(owner);
        vm.prank(keeper);
        orders.execute(id);
        assertGt(IERC20T(NVDA).balanceOf(owner), before, "no tokens bought");
    }

    function test_trailing_stop_tightens_when_the_price_rises() public {
        Orders.Order memory o = _blank();
        o.kind = Orders.Kind.TrailingStop;
        o.trailBps = 500; // 5%
        o.amount = 1e18;
        vm.prank(owner);
        uint256 id = orders.place(o);

        uint256 firstTrigger = orders.get(id).trigger;

        // Buy a large parcel to push the price up, then let anyone poke.
        deal(USDG, address(swapper), 400_000e6);
        swapper.push(USDG, NVDA, FEE, 400_000e6);
        vm.prank(makeAddr("a stranger"));
        orders.poke(id);

        assertGt(orders.get(id).trigger, firstTrigger, "the trail did not tighten");
    }

    function test_trailing_stop_fires_after_a_fall_from_the_peak() public {
        Orders.Order memory o = _blank();
        o.kind = Orders.Kind.TrailingStop;
        o.trailBps = 10; // 0.1%. See the rpc budget note on _pushBelow.
        o.amount = 1e18;
        vm.prank(owner);
        uint256 id = orders.place(o);

        (bool ok,,) = orders.ready(id);
        assertFalse(ok, "should not arm on placement");

        // The trigger the contract derived from trailBps, rather than a repeat
        // of the arithmetic, so the two cannot drift apart.
        _pushBelow(orders.get(id).trigger);

        (bool armed,,) = orders.ready(id);
        assertTrue(armed, "a fall past the trail should arm it");
    }

    function test_twap_fills_one_slice_per_interval() public {
        Orders.Order memory o = _blank();
        o.kind = Orders.Kind.Twap;
        o.buying = true;
        o.amount = 400e6; // USDG
        o.slices = 4;
        o.interval = 1 hours;
        vm.prank(owner);
        uint256 id = orders.place(o);

        vm.prank(keeper);
        orders.execute(id);
        assertEq(orders.get(id).filled, 100e6, "first slice wrong");

        vm.prank(keeper);
        vm.expectRevert();
        orders.execute(id); // too soon

        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(keeper);
        orders.execute(id);
        assertEq(orders.get(id).filled, 200e6, "second slice wrong");
    }

    /// Anchoring the floor to the owner's own trigger is what stops a keeper
    /// pushing the pool and then filling the stop at whatever it likes.
    function test_floor_is_anchored_to_the_trigger_not_to_spot() public {
        // Armed, because spot is under the trigger, but spot is a full 1% under
        // it and the owner will only accept 0.5%. If the floor were computed
        // from spot this would fill happily, which is exactly the hole that
        // lets somebody push the pool and then buy the stop cheaply.
        Orders.Order memory o = _blank();
        o.kind = Orders.Kind.StopLoss;
        o.trigger = (spot * 101) / 100;
        o.maxSlippageBps = 50;
        o.amount = 1e18;
        vm.prank(owner);
        uint256 id = orders.place(o);

        (bool armed,,) = orders.ready(id);
        assertTrue(armed, "should be armed on the trigger");

        vm.prank(keeper);
        vm.expectRevert(); // Underfilled against the owner's own number
        orders.execute(id);
    }

    /// The consequence of that anchoring, stated as a test so nobody is
    /// surprised by it: these are stop limits, not stop markets. A gap through
    /// the trigger wider than the tolerance does not fill at any price.
    function test_a_gap_wider_than_the_tolerance_does_not_fill() public {
        Orders.Order memory o = _blank();
        o.kind = Orders.Kind.StopLoss;
        o.trigger = (spot * 110) / 100; // as if the price gapped 10% below the stop
        o.maxSlippageBps = 300;
        o.amount = 1e18;
        vm.prank(owner);
        uint256 id = orders.place(o);

        vm.prank(keeper);
        vm.expectRevert();
        orders.execute(id);
    }

    function test_cancel_stops_execution() public {
        uint256 id = _stopAt((spot * 101) / 100, 1e18);
        vm.prank(owner);
        orders.cancel(id);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Orders.Inactive.selector, id));
        orders.execute(id);
    }

    function test_only_the_owner_can_cancel() public {
        uint256 id = _stopAt((spot * 101) / 100, 1e18);
        vm.prank(keeper);
        vm.expectRevert(Orders.NotOwner.selector);
        orders.cancel(id);
    }

    /// The real off switch: revoking the allowance kills every order at once.
    function test_revoking_the_allowance_stops_execution() public {
        uint256 id = _stopAt((spot * 101) / 100, 1e18);
        vm.prank(owner);
        IPermit2(PERMIT2_ADDR).approve(NVDA, address(orders), 0, type(uint48).max);

        (bool ok, string memory why,) = orders.ready(id);
        assertFalse(ok);
        assertEq(why, "permit revoked or too small");
    }

    function test_expiry_is_honoured() public {
        Orders.Order memory o = _blank();
        o.kind = Orders.Kind.StopLoss;
        o.trigger = (spot * 101) / 100;
        o.amount = 1e18;
        o.expiry = uint64(block.timestamp + 1 days);
        vm.prank(owner);
        uint256 id = orders.place(o);

        vm.warp(block.timestamp + 2 days);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Orders.Expired.selector, id));
        orders.execute(id);
    }

    function test_contract_holds_nothing_afterwards() public {
        uint256 id = _stopAt((spot * 101) / 100, 2e18);
        vm.prank(keeper);
        orders.execute(id);
        assertEq(IERC20T(NVDA).balanceOf(address(orders)), 0, "kept NVDA");
        assertEq(IERC20T(USDG).balanceOf(address(orders)), 0, "kept USDG");
    }

    function test_callback_rejects_a_stranger() public {
        vm.expectRevert(Orders.UnknownCaller.selector);
        orders.uniswapV3SwapCallback(1, 0, abi.encode(USDG, NVDA, FEE));
    }

    function test_rejects_a_pool_that_does_not_exist() public {
        Orders.Order memory o = _blank();
        o.fee = 12345;
        o.kind = Orders.Kind.StopLoss;
        o.trigger = spot;
        o.amount = 1e18;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Orders.NoPool.selector, NVDA, uint24(12345)));
        orders.place(o);
    }

    /**
     * The reason for the extra hop. A plain approval is unbounded in time, so a
     * stop left running for a year is an open ended claim on the wallet. A
     * Permit2 grant lapses, and a lapsed grant stops the keeper dead.
     */
    function test_an_expired_permit_stops_the_order() public {
        uint256 id = _stopAt((spot * 101) / 100, 1e18);
        (bool armed,,) = orders.ready(id);
        assertTrue(armed, "should start armed");

        // Grant a permission that expires in an hour, then wait two.
        vm.prank(owner);
        IPermit2(PERMIT2_ADDR).approve(NVDA, address(orders), type(uint160).max, uint48(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 2 hours);

        (bool ok, string memory why,) = orders.ready(id);
        assertFalse(ok, "an expired permit must stop it");
        assertEq(why, "permit expired");

        vm.prank(keeper);
        vm.expectRevert();
        orders.execute(id);
    }

    /// And a permit smaller than the order is refused rather than part filled.
    function test_a_permit_smaller_than_the_order_is_refused() public {
        uint256 id = _stopAt((spot * 101) / 100, 5e18);
        vm.prank(owner);
        IPermit2(PERMIT2_ADDR).approve(NVDA, address(orders), uint160(1e18), type(uint48).max);

        (bool ok, string memory why,) = orders.ready(id);
        assertFalse(ok);
        assertEq(why, "permit revoked or too small");
    }
}
