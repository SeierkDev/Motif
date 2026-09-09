// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {BasketRouter, IUniswapV3Factory} from "../src/BasketRouter.sol";
import {Orders} from "../src/Orders.sol";
import {PoolPrice} from "../src/PoolPrice.sol";
import {IPermit2} from "../src/IPermit2.sol";

interface IERC20I {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * Random sequences of real calls from random actors, so the properties below
 * are checked against behaviour nobody wrote a scenario for.
 *
 * The unit tests assert that the contracts hold nothing in the three situations
 * I happened to think of. That is not the same as the claim on the front page,
 * which is that they never hold anything at all.
 */
contract Handler is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;
    address constant PERMIT2_ADDR = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    BasketRouter public immutable router;
    Orders public immutable orders;

    address[3] public actors;
    uint256 public created;
    uint256 public bought;
    uint256 public sold;
    uint256 public placed;

    constructor(BasketRouter _router, Orders _orders) {
        router = _router;
        orders = _orders;
        actors = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol")];
        for (uint256 i; i < actors.length; ++i) {
            deal(USDG, actors[i], 400_000e6);
            deal(NVDA, actors[i], 200e18);
            vm.startPrank(actors[i]);
            IERC20I(USDG).approve(address(router), type(uint256).max);
            // Selling pays the pool out of the seller's own allowance, so the
            // legs need approving too. Without these every sell would revert
            // and the sequence would silently stop exercising the exit.
            IERC20I(NVDA).approve(address(router), type(uint256).max);
            IERC20I(TSLA).approve(address(router), type(uint256).max);
            IERC20I(AMC).approve(address(router), type(uint256).max);
            IERC20I(USDG).approve(PERMIT2_ADDR, type(uint256).max);
            IERC20I(NVDA).approve(PERMIT2_ADDR, type(uint256).max);
            IPermit2(PERMIT2_ADDR).approve(USDG, address(orders), type(uint160).max, type(uint48).max);
            IPermit2(PERMIT2_ADDR).approve(NVDA, address(orders), type(uint160).max, type(uint48).max);
            vm.stopPrank();
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function createIndex(uint256 seed, uint16 w) public {
        w = uint16(bound(w, 1, 9_999));
        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](2);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: 500, weightBps: w});
        legs[1] = BasketRouter.Leg({token: seed % 2 == 0 ? TSLA : AMC, fee: 3000, weightBps: uint16(10_000 - w)});
        vm.prank(_actor(seed));
        try router.createIndex(USDG, legs, uint16(seed % 101), "Fuzzed", "FUZZ", "") {
            created++;
        } catch {}
    }

    function buy(uint256 seed, uint256 amount) public {
        if (router.indexCount() == 0) return;
        amount = bound(amount, 1e6, 20_000e6);
        uint256 id = seed % router.indexCount();
        uint256[] memory minOut = new uint256[](router.legsOf(id).length);
        vm.prank(_actor(seed));
        try router.buy(id, amount, minOut) {
            bought++;
        } catch {}
    }

    /**
     * Sell a fraction of whatever the actor holds of each leg.
     *
     * Mixed with `buy`, this is what makes the "holds nothing" invariant mean
     * something for the exit path, where the router pays a pool out of somebody
     * else's allowance rather than out of tokens it is holding.
     */
    function sell(uint256 seed, uint256 frac) public {
        if (router.indexCount() == 0) return;
        uint256 id = seed % router.indexCount();
        address who = _actor(seed);
        BasketRouter.Leg[] memory legs = router.legsOf(id);
        frac = bound(frac, 1, 100);

        uint256[] memory amounts = new uint256[](legs.length);
        uint256[] memory minOut = new uint256[](legs.length);
        for (uint256 i; i < legs.length; ++i) {
            amounts[i] = (IERC20I(legs[i].token).balanceOf(who) * frac) / 100;
        }

        vm.prank(who);
        try router.sell(id, amounts, minOut) {
            sold++;
        } catch {}
    }

    function placeOrder(uint256 seed, uint256 amount, uint8 kind) public {
        amount = bound(amount, 1e15, 5e18);
        Orders.Order memory o;
        o.token = NVDA;
        o.fee = 500;
        o.kind = Orders.Kind(uint8(bound(kind, 0, 3)));
        o.amount = o.kind == Orders.Kind.LimitBuy ? bound(amount, 1e6, 5_000e6) : amount;
        o.trailBps = 500;
        o.maxSlippageBps = 500;
        uint256 spot = PoolPrice.usdgPerToken(FACTORY.getPool(USDG, NVDA, 500), USDG < NVDA);
        o.trigger = (spot * (80 + (seed % 40))) / 100;
        vm.prank(_actor(seed));
        try orders.place(o) {
            placed++;
        } catch {}
    }

    function executeOrder(uint256 seed) public {
        if (orders.count() == 0) return;
        vm.prank(_actor(seed));
        try orders.execute(seed % orders.count()) {} catch {}
    }

    function cancelOrder(uint256 seed) public {
        if (orders.count() == 0) return;
        uint256 id = seed % orders.count();
        vm.prank(orders.get(id).owner);
        try orders.cancel(id) {} catch {}
    }
}

contract InvariantsForkTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;

    BasketRouter router;
    Orders orders;
    Handler handler;

    function _quotes() internal pure returns (address[] memory q) {
        q = new address[](1);
        q[0] = USDG;
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
        router = new BasketRouter(FACTORY, makeAddr("fees"), address(this), 0, _quotes());
        orders = new Orders(FACTORY, USDG, address(this), 0);
        handler = new Handler(router, orders);
        targetContract(address(handler));
    }

    /// The claim on the front page, checked against random behaviour rather
    /// than three scenarios I thought of.
    function invariant_contracts_never_hold_anything() public view {
        address[4] memory tokens = [USDG, NVDA, TSLA, AMC];
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(IERC20I(tokens[i]).balanceOf(address(router)), 0, "router held a balance");
            assertEq(IERC20I(tokens[i]).balanceOf(address(orders)), 0, "orders held a balance");
        }
    }

    /// A published basket is arithmetic that has to add up, always.
    function invariant_every_basket_weights_to_exactly_ten_thousand() public view {
        uint256 n = router.indexCount();
        for (uint256 id; id < n; ++id) {
            BasketRouter.Leg[] memory legs = router.legsOf(id);
            uint256 total;
            for (uint256 i; i < legs.length; ++i) total += legs[i].weightBps;
            assertEq(total, 10_000, "weights drifted off 100%");
        }
    }

    /// Not an invariant, a receipt. Printed once per run so a handler action
    /// that silently reverts every time cannot look like a passing suite.
    function afterInvariant() public view {
        console.log("created", handler.created());
        console.log("bought", handler.bought());
        console.log("sold", handler.sold());
    }

    /// An order can never fill past what its owner asked for.
    function invariant_an_order_never_overfills() public view {
        uint256 n = orders.count();
        for (uint256 id; id < n; ++id) {
            Orders.Order memory o = orders.get(id);
            assertLe(o.filled, o.amount, "an order filled past its size");
        }
    }
}
