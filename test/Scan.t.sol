// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Orders} from "../src/Orders.sol";
import {Guarded} from "../src/Guarded.sol";
import {PoolPrice} from "../src/PoolPrice.sol";
import {BasketRouter, IUniswapV3Factory} from "../src/BasketRouter.sol";
import {Rebalancer} from "../src/Rebalancer.sol";
import {OracleLib, IAggregatorV3} from "../src/OracleLib.sol";
import {IPermit2} from "../src/IPermit2.sol";

interface IERC20S {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IERC20Permit {
    function approve(address, uint256) external returns (bool);
}

contract SFeed is IAggregatorV3 {
    int256 public a;
    uint256 public t;
    constructor(int256 _a) { a = _a; t = block.timestamp; }
    function decimals() external pure returns (uint8) { return 8; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, a, t, t, 1);
    }
}

/// Findings from the full scan, written as tests so they are demonstrated
/// rather than asserted, and so the fixes cannot regress.
contract ScanForkTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;

    uint256 constant CAP = 25_000e6; // the review window cap, in USDG

    address guardian = makeAddr("guardian");
    address holder = makeAddr("holder");
    address keeper = makeAddr("keeper");

    Orders orders;
    BasketRouter router;
    uint256 spot;
    uint256 amcSpot;

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
        orders = new Orders(FACTORY, USDG, guardian, CAP);
        router = new BasketRouter(FACTORY, makeAddr("fees"), guardian, CAP, _quotes());
        spot = PoolPrice.usdgPerToken(FACTORY.getPool(USDG, NVDA, 500), USDG < NVDA);
        // Price the mock feeds off the real pools. A feed that disagrees with
        // the pool makes every swap miss its oracle anchored floor, which would
        // make this test revert for a reason that has nothing to do with a cap.
        amcSpot = PoolPrice.usdgPerToken(FACTORY.getPool(USDG, AMC, 3000), USDG < AMC);

        deal(NVDA, holder, 100e18);
        deal(AMC, holder, 100_000e18);
        deal(USDG, holder, 500_000e6);
        _permit(holder, NVDA, address(orders));
        _permit(holder, USDG, address(orders));
    }

    /**
     * FINDING 1, high.
     *
     * `maxNotional` is a USDG figure with 6 decimals, but a sell order is sized
     * in the stock token with 18. One NVDA is 1e18, the cap is 2.5e10, so every
     * stop loss, limit sell and trailing stop is rejected the moment a cap is
     * set, however small the position. The existing suites missed it because
     * they build Orders with a cap of zero, and the one cap test uses a
     * LimitBuy, which really is denominated in USDG.
     */
    function test_finding1_a_sell_order_of_one_share_is_not_over_the_cap() public {
        Orders.Order memory o;
        o.token = NVDA;
        o.fee = 500;
        o.kind = Orders.Kind.StopLoss;
        o.trigger = (spot * 90) / 100;
        o.amount = 1e18; // one NVDA, about $230, far under a $25,000 cap
        o.maxSlippageBps = 300;

        vm.prank(holder);
        uint256 id = orders.place(o);
        assertEq(orders.get(id).amount, 1e18, "a one share stop should be placeable");
    }

    /// And the cap must still bite on a genuinely oversized sell.
    function test_finding1_a_huge_sell_order_is_still_capped() public {
        Orders.Order memory o;
        o.token = NVDA;
        o.fee = 500;
        o.kind = Orders.Kind.StopLoss;
        o.trigger = (spot * 90) / 100;
        o.amount = 1_000e18; // about $230,000
        o.maxSlippageBps = 300;

        vm.prank(holder);
        vm.expectRevert();
        orders.place(o);
    }

    /// A buy order is denominated in USDG and must keep behaving as before.
    function test_finding1_a_buy_order_is_still_capped_in_usdg() public {
        Orders.Order memory o;
        o.token = NVDA;
        o.fee = 500;
        o.kind = Orders.Kind.LimitBuy;
        o.trigger = spot * 2;
        o.amount = 30_000e6;
        o.maxSlippageBps = 300;

        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(Guarded.OverCap.selector, uint256(30_000e6), CAP));
        orders.place(o);
    }

    /**
     * FINDING 2, medium.
     *
     * The Rebalancer is constructed with a `maxNotional` and never consults it.
     * The cap is meant to bound what one call can pull from an allowance, and a
     * rebalance pulls from an allowance, so leaving it out puts the largest
     * positions outside the very limit that exists for them.
     */
    function test_finding2_rebalance_respects_the_cap() public {
        // A differential rather than a hardcoded figure. The same wallet and
        // the same drift, run twice: once with a cap far below the position and
        // once with none. If only the capped run reverts, the cap is what
        // stopped it, and nothing here breaks when the market moves.
        assertTrue(_rebalanceReverts(1_000e6), "a cap under the position should stop a rebalance");
        assertFalse(_rebalanceReverts(0), "with no cap the same rebalance should go through");
    }

    function _rebalanceReverts(uint256 cap) internal returns (bool reverted) {
        uint256 snap = vm.snapshotState();

        Rebalancer rb = new Rebalancer(router, FACTORY, USDG, address(this), guardian, cap);
        rb.registerFeed(NVDA, new SFeed(int256(spot / 1e10)));
        rb.registerFeed(AMC, new SFeed(int256(amcSpot / 1e10)));

        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](2);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: 500, weightBps: 5000});
        legs[1] = BasketRouter.Leg({token: AMC, fee: 3000, weightBps: 5000});
        uint256 id = router.createIndex(USDG, legs, 0, "Scan", "SCAN", "");

        _permit(holder, NVDA, address(rb));
        _permit(holder, AMC, address(rb));
        vm.prank(holder);
        rb.subscribe(id, 100, 500, 1 hours, 0);

        vm.prank(keeper);
        try rb.rebalance(holder) { reverted = false; } catch { reverted = true; }

        vm.revertToState(snap);
    }

    /**
     * A scale check on the price maths, because every other test compares the
     * price to itself and would happily pass if it were wrong by a constant
     * factor. NVDA is a few hundred dollars, and both pool orderings are
     * exercised: USDG sorts below NVDA and above AMC, so the two branches of
     * the reciprocal are both covered here.
     */
    function test_pool_price_is_in_dollars_not_off_by_a_factor() public view {
        uint256 nvda = PoolPrice.usdgPerToken(FACTORY.getPool(USDG, NVDA, 500), USDG < NVDA);
        assertGt(nvda, 50e18, "NVDA priced impossibly low");
        assertLt(nvda, 2_000e18, "NVDA priced impossibly high");

        uint256 amc = PoolPrice.usdgPerToken(FACTORY.getPool(USDG, AMC, 3000), USDG < AMC);
        assertGt(amc, 1e16, "AMC priced impossibly low");
        assertLt(amc, 200e18, "AMC priced impossibly high");
    }
}
