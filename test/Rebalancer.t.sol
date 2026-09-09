// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BasketRouter, IUniswapV3Factory} from "../src/BasketRouter.sol";
import {Rebalancer} from "../src/Rebalancer.sol";
import {OracleLib, IAggregatorV3} from "../src/OracleLib.sol";
import {IPermit2} from "../src/IPermit2.sol";
import {PoolPrice} from "../src/PoolPrice.sol";

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// A feed we can move. The real ones cannot be made to do anything on demand,
/// and the whole point of these tests is controlling the price.
interface IERC20Permit {
    function approve(address, uint256) external returns (bool);
}

contract MockFeed is IAggregatorV3 {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public immutable dec;

    constructor(int256 a, uint8 d) {
        answer = a;
        updatedAt = block.timestamp;
        dec = d;
    }

    function set(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function decimals() external view returns (uint8) {
        return dec;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract RebalancerForkTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;

    uint24 constant FEE_NVDA = 500;
    uint24 constant FEE_AMC = 3000;

    BasketRouter router;
    Rebalancer rb;
    MockFeed nvdaFeed;
    MockFeed amcFeed;

    address owner = makeAddr("owner");
    address holder = makeAddr("holder");
    address keeper = makeAddr("keeper");
    uint256 indexId;

    uint32 constant MAX_AGE = 1 hours;
    uint32 constant COOLDOWN = 6 hours;

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

    /// USDG per token, 1e18, straight off the pool the router would swap through.
    function _spot(address token, uint24 fee) internal view returns (uint256) {
        return PoolPrice.usdgPerToken(FACTORY.getPool(USDG, token, fee), USDG < token);
    }

    function setUp() public {
        vm.createSelectFork(_forkUrl());
        router = new BasketRouter(FACTORY, makeAddr("protocolFeeTo"), address(this), 0, _quotes());
        rb = new Rebalancer(router, FACTORY, USDG, owner, address(this), 0);

        /*
         * The feeds are built from the pools rather than written down.
         *
         * They were `230e8` and `3e8`, which were right when they were typed.
         * A rebalance sizes its own `minOut` off the oracle and then swaps
         * through the pool, so an oracle that disagrees with the pool by more
         * than `maxSlippageBps` reverts `SlippageTooHigh` no matter how well
         * the rebalancer works. NVDA drifted about 1.9% under $230 against a 1%
         * bound and took six tests down with it, none of which are about what
         * NVDA costs. Read off the pool, the two agree by construction and the
         * tests are back to measuring the thing they are named after. Same
         * lesson, and the same fix, as the hard coded push in `Orders.t.sol`.
         */
        nvdaFeed = new MockFeed(int256(_spot(NVDA, FEE_NVDA) / 1e10), 8);
        amcFeed = new MockFeed(int256(_spot(AMC, FEE_AMC) / 1e10), 8);
        vm.startPrank(owner);
        rb.registerFeed(NVDA, nvdaFeed);
        rb.registerFeed(AMC, amcFeed);
        vm.stopPrank();

        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](2);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: FEE_NVDA, weightBps: 5000});
        legs[1] = BasketRouter.Leg({token: AMC, fee: FEE_AMC, weightBps: 5000});
        indexId = router.createIndex(USDG, legs, 0, "Test Basket", "TEST", "");

        // A wallet that is 70/30 against a 50/50 target, so there is real drift.
        deal(NVDA, holder, 3e18); //   3 NVDA  = $690
        deal(AMC, holder, 100e18); // 100 AMC  = $300
        _permit(holder, NVDA, address(rb));
        _permit(holder, AMC, address(rb));
        vm.prank(holder);
        rb.subscribe(indexId, 500, 100, MAX_AGE, COOLDOWN); // trigger at 5% drift
    }

    /**
     * @dev The expectation is read off the pools rather than written down, for
     *      the reason the feeds are. It was `990e18` and `1970` bps, which was
     *      3 NVDA at $230 and 100 AMC at $3 on the day it was typed. The wallet
     *      is worth $931 now and the assertion failed on commits that touched
     *      nothing it covers. This test is about whether drift is measured
     *      against the target weights, not about what NVDA costs.
     */
    function test_drift_is_measured_against_target_weights() public view {
        uint256 nv = 3 * _spot(NVDA, FEE_NVDA);
        uint256 am = 100 * _spot(AMC, FEE_AMC);
        uint256 expected = nv + am;
        uint256 w = (nv * 10_000) / expected;
        // Two legs against a 50/50 target, so both sit the same distance out.
        // Signed either way rather than assuming NVDA is the heavy one, since
        // an inverted subtraction here would panic rather than say anything.
        uint256 expDrift = w > 5_000 ? w - 5_000 : 5_000 - w;

        (, uint256 total, uint256 drift) = rb.positionOf(holder);
        assertApproxEqRel(total, expected, 0.01e18, "total value wrong");
        assertApproxEqAbs(drift, expDrift, 30, "drift not measured correctly");
    }

    function test_rebalance_moves_the_wallet_back_toward_target() public {
        (,, uint256 before) = rb.positionOf(holder);
        vm.prank(keeper);
        rb.rebalance(holder);
        (,, uint256 after_) = rb.positionOf(holder);
        assertLt(after_, before, "drift did not fall");
        assertLt(after_, 500, "should be inside tolerance after a rebalance");
    }

    /// The custody claim, again. Nothing may rest in the contract.
    function test_rebalancer_holds_nothing_afterwards() public {
        vm.prank(keeper);
        rb.rebalance(holder);
        assertEq(IERC20T(USDG).balanceOf(address(rb)), 0, "kept USDG");
        assertEq(IERC20T(NVDA).balanceOf(address(rb)), 0, "kept NVDA");
        assertEq(IERC20T(AMC).balanceOf(address(rb)), 0, "kept AMC");
    }

    /// A weekend, or a deviation feed that has simply not moved.
    function test_stale_price_stops_a_rebalance() public {
        nvdaFeed.setUpdatedAt(block.timestamp - 3 hours);
        vm.prank(keeper);
        vm.expectRevert();
        rb.rebalance(holder);

        (bool ok, string memory why) = rb.shouldRebalance(holder);
        assertFalse(ok);
        assertEq(why, "price too stale");
    }

    /// The trap this phase exists for: a split must freeze trading, not trigger it.
    function test_a_split_freezes_rebalancing() public {
        // A two for one split doubles the multiplier.
        vm.mockCall(NVDA, abi.encodeWithSignature("uiMultiplier()"), abi.encode(uint256(2e18)));

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Rebalancer.CorporateActionPending.selector, NVDA, 1e18, 2e18));
        rb.rebalance(holder);

        (bool ok, string memory why) = rb.shouldRebalance(holder);
        assertFalse(ok);
        assertEq(why, "corporate action pending");
    }

    /// And only the holder can unfreeze it.
    function test_holder_can_acknowledge_a_split_and_resume() public {
        vm.mockCall(NVDA, abi.encodeWithSignature("uiMultiplier()"), abi.encode(uint256(2e18)));
        vm.prank(holder);
        rb.acknowledgeCorporateActions();
        assertEq(rb.multiplierAt(holder, NVDA), 2e18, "multiplier not updated");

        vm.prank(keeper);
        rb.rebalance(holder); // no longer frozen
    }

    /// Idempotency: a keeper retrying a transaction it thinks failed must not
    /// run the same correction twice.
    function test_cooldown_blocks_an_immediate_second_rebalance() public {
        vm.prank(keeper);
        rb.rebalance(holder);
        vm.prank(keeper);
        vm.expectRevert();
        rb.rebalance(holder);
    }

    function test_cooldown_expires() public {
        vm.prank(keeper);
        rb.rebalance(holder);
        // Skew it again and wait out the cooldown.
        deal(NVDA, holder, 10e18);
        vm.warp(block.timestamp + COOLDOWN + 1);
        // The warp took both feeds past MAX_AGE, so they are re-read rather
        // than written down. A hard coded $230 here was the same bug as the one
        // setUp used to have: the oracle disagreed with the pool by more than
        // the 1% bound and every rebalance reverted SlippageTooHigh.
        nvdaFeed.set(int256(_spot(NVDA, FEE_NVDA) / 1e10));
        amcFeed.set(int256(_spot(AMC, FEE_AMC) / 1e10));
        vm.prank(keeper);
        rb.rebalance(holder);
    }

    /// Anyone may keep, which is what makes failover the absence of a mechanism.
    function test_any_address_can_act_as_keeper() public {
        vm.prank(makeAddr("a stranger"));
        rb.rebalance(holder);
    }

    /// The holder's off switch has to actually work.
    function test_unsubscribe_stops_the_keeper() public {
        vm.prank(holder);
        rb.unsubscribe();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Rebalancer.NotSubscribed.selector, holder));
        rb.rebalance(holder);
    }

    function test_no_rebalance_when_already_in_tolerance() public {
        // Price NVDA so the wallet already sits near 50/50. Derived from the
        // AMC side rather than fixed at $100, which only balanced while AMC
        // was $3 and would have gone the way of the two above.
        nvdaFeed.set(int256((100 * _spot(AMC, FEE_AMC)) / 3 / 1e10));
        vm.prank(keeper);
        vm.expectRevert();
        rb.rebalance(holder);
    }

    /// A feed can be added but never repointed underneath a live subscription.
    function test_feed_cannot_be_repointed() public {
        // Deploy first: `new` is itself a call and would eat the expectRevert.
        MockFeed impostor = new MockFeed(1e8, 8);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Rebalancer.FeedAlreadySet.selector, NVDA));
        rb.registerFeed(NVDA, impostor);
    }

    /**
     * A leg with no registered feed is answered, not thrown.
     *
     * `shouldRebalance` is the view a keeper asks before it spends gas and the
     * view the portfolio page asks to say whether anything is due, so its whole
     * job is to give a reason. It used to read `feedOf[token].ageOf()` without
     * checking the feed was there, and an unregistered feed is address(0): a
     * high level call to an address with no code reverts before returning
     * anything, so the view that exists to explain reverted with nothing
     * attached. That is not a hypothetical shape either. **No feed is
     * registered on mainnet at all**, so it is the state every subscription
     * there would be in.
     *
     * A fresh Rebalancer with the same index and no feeds is the cheapest way
     * to reach it, because feeds cannot be unregistered once set.
     */
    function test_a_leg_with_no_feed_is_reported_rather_than_reverting() public {
        Rebalancer bare = new Rebalancer(router, FACTORY, USDG, owner, address(this), 0);
        _permit(holder, NVDA, address(bare));
        _permit(holder, AMC, address(bare));
        vm.prank(holder);
        bare.subscribe(indexId, 500, 100, MAX_AGE, COOLDOWN);

        (bool ok, string memory why) = bare.shouldRebalance(holder);
        assertFalse(ok, "it should not be rebalanceable with no prices");
        assertEq(why, "no price feed for a leg", "it did not say why");

        // And the one that already answered by name keeps doing so.
        vm.expectRevert(abi.encodeWithSelector(OracleLib.NoFeed.selector, NVDA));
        bare.positionOf(holder);
    }

    function test_only_owner_registers_feeds() public {
        MockFeed feed = new MockFeed(1e8, 8);
        vm.prank(makeAddr("nobody"));
        vm.expectRevert(Rebalancer.NotOwner.selector);
        rb.registerFeed(USDG, feed);
    }
}
