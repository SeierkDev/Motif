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

interface IERC20G {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IERC20Permit {
    function approve(address, uint256) external returns (bool);
}

contract Feed is IAggregatorV3 {
    int256 public a;
    uint256 public t;

    constructor(int256 _a) {
        a = _a;
        t = block.timestamp;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, a, t, t, 1);
    }
}

/// The security gate: the kill switch, the size cap, and the slippage hole the
/// review turned up.
contract GuardedForkTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;

    address guardian = makeAddr("guardian");
    address holder = makeAddr("holder");
    address keeper = makeAddr("keeper");

    BasketRouter router;
    Orders orders;
    uint256 spot;

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
        router = new BasketRouter(FACTORY, makeAddr("fees"), guardian, 25_000e6, _quotes());
        orders = new Orders(FACTORY, USDG, guardian, 25_000e6);
        spot = PoolPrice.usdgPerToken(FACTORY.getPool(USDG, NVDA, 500), USDG < NVDA);

        deal(USDG, holder, 200_000e6);
        deal(NVDA, holder, 50e18);
        vm.prank(holder);
        IERC20G(USDG).approve(address(router), type(uint256).max);
        _permit(holder, USDG, address(orders));
        _permit(holder, NVDA, address(orders));
    }

    function _index() internal returns (uint256) {
        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](2);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: 500, weightBps: 5000});
        legs[1] = BasketRouter.Leg({token: AMC, fee: 3000, weightBps: 5000});
        return router.createIndex(USDG, legs, 0, "Test Basket", "TEST", "");
    }

    // ------------------------------------------------------------ kill switch

    function test_guardian_can_stop_buying() public {
        uint256 id = _index();
        vm.prank(guardian);
        router.pause();
        uint256[] memory minOut = new uint256[](2);
        vm.prank(holder);
        vm.expectRevert(Guarded.ContractPaused.selector);
        router.buy(id, 100e6, minOut);
    }

    /// Pausing moves nothing, because nothing was ever held.
    function test_pausing_costs_the_holder_nothing() public {
        uint256 before = IERC20G(USDG).balanceOf(holder);
        vm.prank(guardian);
        router.pause();
        assertEq(IERC20G(USDG).balanceOf(holder), before);
        assertEq(IERC20G(USDG).balanceOf(address(router)), 0);
    }

    function test_only_the_guardian_can_pause() public {
        vm.prank(keeper);
        vm.expectRevert(Guarded.NotGuardian.selector);
        router.pause();
    }

    function test_unpause_restores_service() public {
        uint256 id = _index();
        vm.startPrank(guardian);
        router.pause();
        router.unpause();
        vm.stopPrank();
        uint256[] memory minOut = new uint256[](2);
        vm.prank(holder);
        router.buy(id, 100e6, minOut);
    }

    /// The one way door. After this there is no guardian and no pause.
    function test_renouncing_is_permanent() public {
        vm.prank(guardian);
        router.renounceGuardian();
        assertEq(router.guardian(), address(0));
        assertEq(router.maxNotional(), 0);

        vm.prank(guardian);
        vm.expectRevert(Guarded.NotGuardian.selector);
        router.pause();
    }

    // -------------------------------------------------------------- size cap

    function test_cap_bounds_a_single_purchase() public {
        uint256 id = _index();
        uint256[] memory minOut = new uint256[](2);
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(Guarded.OverCap.selector, uint256(30_000e6), uint256(25_000e6)));
        router.buy(id, 30_000e6, minOut);
    }

    function test_cap_allows_anything_under_it() public {
        uint256 id = _index();
        uint256[] memory minOut = new uint256[](2);
        vm.prank(holder);
        router.buy(id, 24_999e6, minOut);
    }

    function test_cap_bounds_an_order_too() public {
        Orders.Order memory o;
        o.token = NVDA;
        o.fee = 500;
        o.kind = Orders.Kind.LimitBuy;
        o.trigger = spot * 2;
        o.amount = 30_000e6;
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(Guarded.OverCap.selector, uint256(30_000e6), uint256(25_000e6)));
        orders.place(o);
    }

    function test_guardian_can_raise_the_cap() public {
        vm.prank(guardian);
        router.setMaxNotional(1_000_000e6);
        uint256 id = _index();
        uint256[] memory minOut = new uint256[](2);
        vm.prank(holder);
        router.buy(id, 30_000e6, minOut);
    }

    // ---------------------------------------------- the bug the review found

    /**
     * `maxSlippageBps` was recorded at subscribe and then never read, so a
     * permissionless keeper could sandwich a rebalance and take the position.
     * This is the regression test: a tolerance the swap cannot meet must revert
     * rather than fill at any price.
     */
    function test_rebalancer_enforces_the_holders_slippage() public {
        Rebalancer rb = new Rebalancer(router, FACTORY, USDG, address(this), guardian, 0);
        // Price the feeds far above what the pool will actually pay, so any
        // fill necessarily misses the floor the holder asked for.
        rb.registerFeed(NVDA, new Feed(int256((spot / 1e10) * 3)));
        rb.registerFeed(AMC, new Feed(int256(1e8)));

        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](2);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: 500, weightBps: 5000});
        legs[1] = BasketRouter.Leg({token: AMC, fee: 3000, weightBps: 5000});
        uint256 id = router.createIndex(USDG, legs, 0, "Test Basket", "TEST", "");

        deal(AMC, holder, 100e18);
        _permit(holder, NVDA, address(rb));
        _permit(holder, AMC, address(rb));
        vm.prank(holder);
        rb.subscribe(id, 100, 100, 1 hours, 0);

        vm.prank(keeper);
        vm.expectRevert();
        rb.rebalance(holder);
    }

    function test_subscription_slippage_is_capped() public {
        Rebalancer rb = new Rebalancer(router, FACTORY, USDG, address(this), guardian, 0);
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(Rebalancer.SlippageCapExceeded.selector, uint16(2000)));
        rb.subscribe(0, 100, 2000, 1 hours, 0);
    }

    /// A TWAP with no interval is one order a keeper can drain inside a block.
    function test_twap_requires_an_interval() public {
        Orders.Order memory o;
        o.token = NVDA;
        o.fee = 500;
        o.kind = Orders.Kind.Twap;
        o.buying = true;
        o.amount = 1_000e6;
        o.slices = 4;
        o.interval = 0;
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(Orders.BadOrder.selector, "twap needs an interval"));
        orders.place(o);
    }

    /// Handing the guardian to nobody while paused would brick the contract
    /// with no way back. Renouncing is the deliberate version and it unpauses.
    function test_guardian_cannot_be_handed_to_nobody() public {
        vm.startPrank(guardian);
        router.pause();
        vm.expectRevert(Guarded.UseRenounce.selector);
        router.transferGuardian(address(0));
        vm.stopPrank();
    }

    function test_renouncing_unpauses_on_the_way_out() public {
        vm.startPrank(guardian);
        router.pause();
        router.renounceGuardian();
        vm.stopPrank();
        assertFalse(router.paused(), "renounce left it bricked");
    }
}
