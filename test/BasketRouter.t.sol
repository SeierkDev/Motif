// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BasketRouter, IUniswapV3Factory, IERC20Minimal} from "../src/BasketRouter.sol";
import {Guarded} from "../src/Guarded.sol";

interface IERC20Read {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/**
 * Fork tests against Robinhood Chain mainnet.
 *
 * These run against the real Uniswap V3 factory and the real pools rather than
 * mocks, because the whole reason the first version of this contract was wrong
 * is that it was written against an assumed venue. A mock would have passed.
 */
contract BasketRouterForkTest is Test {
    // Discovered on chain, not taken from any documentation. The canonical
    // mainnet V3 factory address has nothing on this chain.
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;
    address constant SLV = 0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;

    uint24 constant FEE_LOW = 500;
    uint24 constant FEE_MID = 3000;

    BasketRouter router;
    address creator = makeAddr("creator");
    address protocolFeeTo = makeAddr("protocolFeeTo");
    address buyer = makeAddr("buyer");

    uint256 constant SPEND = 500e6; // USDG has 6 decimals

    /// USDG is the only asset baskets may be priced in for now.
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
        router = new BasketRouter(FACTORY, protocolFeeTo, address(this), 0, _quotes());
    }

    function _fiveLegs() internal pure returns (BasketRouter.Leg[] memory legs) {
        legs = new BasketRouter.Leg[](5);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: FEE_LOW, weightBps: 3000});
        legs[1] = BasketRouter.Leg({token: TSLA, fee: FEE_MID, weightBps: 2000});
        legs[2] = BasketRouter.Leg({token: AMC, fee: FEE_MID, weightBps: 2000});
        legs[3] = BasketRouter.Leg({token: SLV, fee: FEE_MID, weightBps: 2000});
        legs[4] = BasketRouter.Leg({token: SGOV, fee: FEE_MID, weightBps: 1000});
    }

    function _createIndex() internal returns (uint256 id) {
        vm.prank(creator);
        id = router.createIndex(USDG, _fiveLegs(), 50, "Test Basket", "TEST", ""); // 50 bps creator fee
    }

    function _fundAndApprove(uint256 amount) internal {
        deal(USDG, buyer, amount);
        vm.prank(buyer);
        IERC20Read(USDG).approve(address(router), amount);
    }

    /// The exit test for Phase 1: five legs in, five real tokens in the wallet.
    function test_buy_lands_every_leg_in_the_buyers_wallet() public {
        uint256 id = _createIndex();
        _fundAndApprove(SPEND);

        uint256[] memory minOut = new uint256[](5); // no floor, we are proving delivery
        vm.prank(buyer);
        router.buy(id, SPEND, minOut);

        address[5] memory tokens = [NVDA, TSLA, AMC, SLV, SGOV];
        for (uint256 i; i < 5; ++i) {
            assertGt(IERC20Read(tokens[i]).balanceOf(buyer), 0, "leg did not arrive");
        }
        assertEq(IERC20Read(USDG).balanceOf(buyer), 0, "input not fully spent");
    }

    /// Nothing may ever rest in the router, which is the whole custody claim.
    function test_router_holds_nothing_afterwards() public {
        uint256 id = _createIndex();
        _fundAndApprove(SPEND);
        uint256[] memory minOut = new uint256[](5);
        vm.prank(buyer);
        router.buy(id, SPEND, minOut);

        address[6] memory all = [USDG, NVDA, TSLA, AMC, SLV, SGOV];
        for (uint256 i; i < 6; ++i) {
            assertEq(IERC20Read(all[i]).balanceOf(address(router)), 0, "router kept a balance");
        }
    }

    /// A partial basket is never delivered. One missed leg unwinds everything.
    function test_missed_minimum_reverts_the_whole_basket() public {
        uint256 id = _createIndex();
        _fundAndApprove(SPEND);

        uint256[] memory minOut = new uint256[](5);
        minOut[3] = type(uint128).max; // unreachable on leg four

        vm.prank(buyer);
        vm.expectRevert();
        router.buy(id, SPEND, minOut);

        // Legs one to three executed inside the call and must have been undone.
        assertEq(IERC20Read(USDG).balanceOf(buyer), SPEND, "input was not returned");
        assertEq(IERC20Read(NVDA).balanceOf(buyer), 0, "leg one survived a reverted basket");
        assertEq(IERC20Read(TSLA).balanceOf(buyer), 0, "leg two survived a reverted basket");
    }

    /// Fees leave in the same transaction and land where they should.
    function test_fees_reach_creator_and_protocol() public {
        uint256 id = _createIndex();
        _fundAndApprove(SPEND);
        uint256[] memory minOut = new uint256[](5);

        vm.prank(buyer);
        router.buy(id, SPEND, minOut);

        assertEq(IERC20Read(USDG).balanceOf(creator), (SPEND * 50) / 10_000, "creator fee wrong");
        assertEq(
            IERC20Read(USDG).balanceOf(protocolFeeTo),
            (SPEND * router.PROTOCOL_FEE_BPS()) / 10_000,
            "protocol fee wrong"
        );
    }

    /// The callback is the one externally reachable hole. It must refuse
    /// anyone who is not a real pool inside a swap this router started.
    function test_callback_rejects_a_stranger() public {
        bytes memory data = abi.encode(USDG, NVDA, FEE_LOW, address(router));
        vm.expectRevert(BasketRouter.UnknownCaller.selector);
        router.uniswapV3SwapCallback(1, 0, data);
    }

    /// Even the real pool cannot pull funds outside a basket.
    function test_callback_rejects_the_real_pool_outside_a_buy() public {
        address pool = FACTORY.getPool(USDG, NVDA, FEE_LOW);
        assertTrue(pool != address(0), "expected a live USDG/NVDA pool");
        vm.prank(pool);
        vm.expectRevert(BasketRouter.UnknownCaller.selector);
        router.uniswapV3SwapCallback(1, 0, abi.encode(USDG, NVDA, FEE_LOW, address(router)));
    }

    /**
     * A pool cannot take more than the leg it was handed, even a real one.
     *
     * Anyone may publish an index pointing a leg at any token, so anyone may
     * make this router call a pool they deployed themselves. On the sell path
     * the callback pays out of the seller's own allowance, so without this
     * bound a hostile pool would be able to ask for all of it rather than the
     * amount its swap was for.
     *
     * `_owedCap` is private and only ever nonzero mid swap, so the test writes
     * it directly. Slot 4, from `forge inspect BasketRouter storage`.
     */
    function test_callback_will_not_pay_more_than_the_leg() public {
        address pool = FACTORY.getPool(USDG, NVDA, FEE_LOW);
        vm.store(address(router), bytes32(uint256(4)), bytes32(uint256(100e6)));

        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.PoolWantsTooMuch.selector, 101e6, 100e6));
        router.uniswapV3SwapCallback(int256(101e6), 0, abi.encode(USDG, NVDA, FEE_LOW, address(router)));
    }

    /// An index with a dead leg must fail at publication, not at the first buy.
    function test_create_index_rejects_a_pool_that_does_not_exist() public {
        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](1);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: 12345, weightBps: 10_000});
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.NoPoolForLeg.selector, NVDA, uint24(12345)));
        router.createIndex(USDG, legs, 0, "Test Basket", "TEST", "");
    }

    function test_weights_must_sum_to_ten_thousand() public {
        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](1);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: FEE_LOW, weightBps: 9999});
        vm.prank(creator);
        vm.expectRevert(BasketRouter.WeightsMustSumToBps.selector);
        router.createIndex(USDG, legs, 0, "Test Basket", "TEST", "");
    }

    function test_creator_fee_is_capped() public {
        vm.prank(creator);
        vm.expectRevert(BasketRouter.CreatorFeeTooHigh.selector);
        router.createIndex(USDG, _fiveLegs(), 101, "Test Basket", "TEST", "");
    }

    // ------------------------------------------------------------------ sell

    function _legTokens() internal pure returns (address[5] memory) {
        return [NVDA, TSLA, AMC, SLV, SGOV];
    }

    /// Buy the basket, then approve every leg back to the router, which is what
    /// a seller does. Returns what landed in the wallet, leg by leg.
    function _buyThenApproveLegs(uint256 id) internal returns (uint256[] memory held) {
        _fundAndApprove(SPEND);
        uint256[] memory minOut = new uint256[](5);
        vm.prank(buyer);
        router.buy(id, SPEND, minOut);

        address[5] memory tokens = _legTokens();
        held = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            held[i] = IERC20Read(tokens[i]).balanceOf(buyer);
            vm.prank(buyer);
            IERC20Read(tokens[i]).approve(address(router), type(uint256).max);
        }
    }

    /// The exit. Five legs go out, quote asset comes back, in one transaction.
    function test_sell_returns_the_quote_asset_and_takes_the_legs() public {
        uint256 id = _createIndex();
        uint256[] memory held = _buyThenApproveLegs(id);
        assertEq(IERC20Read(USDG).balanceOf(buyer), 0, "buyer should have spent everything");

        uint256[] memory minOut = new uint256[](5);
        vm.prank(buyer);
        uint256 out = router.sell(id, held, minOut);

        assertGt(out, 0, "sell returned nothing");
        assertEq(IERC20Read(USDG).balanceOf(buyer), out, "proceeds did not reach the seller");

        address[5] memory tokens = _legTokens();
        for (uint256 i; i < 5; ++i) {
            assertEq(IERC20Read(tokens[i]).balanceOf(buyer), 0, "a leg was left behind");
        }
    }

    /**
     * A round trip costs the pool fee and the buy fees, and nothing else.
     *
     * Measured rather than asserted from the code: the creator and the protocol
     * balances are read after the buy and again after the sell, and neither may
     * move. An exit fee is the thing this contract must not grow later without
     * somebody noticing.
     */
    function test_sell_charges_no_fee() public {
        uint256 id = _createIndex();
        uint256[] memory held = _buyThenApproveLegs(id);

        uint256 creatorBefore = IERC20Read(USDG).balanceOf(creator);
        uint256 protocolBefore = IERC20Read(USDG).balanceOf(protocolFeeTo);
        assertGt(creatorBefore, 0, "the buy should already have paid the creator");

        uint256[] memory minOut = new uint256[](5);
        vm.prank(buyer);
        router.sell(id, held, minOut);

        assertEq(IERC20Read(USDG).balanceOf(creator), creatorBefore, "the sell paid a creator fee");
        assertEq(IERC20Read(USDG).balanceOf(protocolFeeTo), protocolBefore, "the sell paid a protocol fee");
    }

    /// The custody claim again, from the other direction.
    function test_router_holds_nothing_after_a_sell() public {
        uint256 id = _createIndex();
        uint256[] memory held = _buyThenApproveLegs(id);
        uint256[] memory minOut = new uint256[](5);
        vm.prank(buyer);
        router.sell(id, held, minOut);

        address[6] memory all = [USDG, NVDA, TSLA, AMC, SLV, SGOV];
        for (uint256 i; i < 6; ++i) {
            assertEq(IERC20Read(all[i]).balanceOf(address(router)), 0, "router kept a balance");
        }
    }

    /// Selling part of a position leaves the rest where it was.
    function test_partial_sell_keeps_the_remainder() public {
        uint256 id = _createIndex();
        uint256[] memory held = _buyThenApproveLegs(id);

        uint256[] memory half = new uint256[](5);
        for (uint256 i; i < 5; ++i) half[i] = held[i] / 2;

        uint256[] memory minOut = new uint256[](5);
        vm.prank(buyer);
        router.sell(id, half, minOut);

        address[5] memory tokens = _legTokens();
        for (uint256 i; i < 5; ++i) {
            assertEq(IERC20Read(tokens[i]).balanceOf(buyer), held[i] - half[i], "remainder is wrong");
        }
    }

    /// A zero skips a leg rather than reverting, so somebody who already sold
    /// one ticker elsewhere can still exit the rest in one transaction.
    function test_sell_skips_zero_legs() public {
        uint256 id = _createIndex();
        uint256[] memory held = _buyThenApproveLegs(id);

        uint256[] memory only = new uint256[](5);
        only[0] = held[0]; // NVDA alone

        uint256[] memory minOut = new uint256[](5);
        vm.prank(buyer);
        router.sell(id, only, minOut);

        assertEq(IERC20Read(NVDA).balanceOf(buyer), 0, "the chosen leg did not sell");
        assertEq(IERC20Read(TSLA).balanceOf(buyer), held[1], "a skipped leg moved");
        assertEq(IERC20Read(SGOV).balanceOf(buyer), held[4], "a skipped leg moved");
    }

    /// Selling nothing at all is a mistake, not a no op that still costs gas.
    function test_selling_nothing_reverts() public {
        uint256 id = _createIndex();
        _buyThenApproveLegs(id);

        uint256[] memory zeros = new uint256[](5);
        vm.prank(buyer);
        vm.expectRevert(BasketRouter.NothingToSell.selector);
        router.sell(id, zeros, zeros);
    }

    /// One missed floor unwinds the whole exit, including the legs that filled.
    function test_missed_minimum_reverts_the_whole_sell() public {
        uint256 id = _createIndex();
        uint256[] memory held = _buyThenApproveLegs(id);

        uint256[] memory minOut = new uint256[](5);
        minOut[3] = type(uint128).max; // unreachable on leg four

        vm.prank(buyer);
        vm.expectRevert();
        router.sell(id, held, minOut);

        assertEq(IERC20Read(USDG).balanceOf(buyer), 0, "proceeds survived a reverted sell");
        assertEq(IERC20Read(NVDA).balanceOf(buyer), held[0], "leg one was not returned");
        assertEq(IERC20Read(TSLA).balanceOf(buyer), held[1], "leg two was not returned");
    }

    function test_sell_rejects_mismatched_arrays() public {
        uint256 id = _createIndex();
        uint256[] memory held = _buyThenApproveLegs(id);
        uint256[] memory shortArray = new uint256[](4);

        vm.prank(buyer);
        vm.expectRevert(BasketRouter.AmountsLengthMismatch.selector);
        router.sell(id, shortArray, new uint256[](5));

        vm.prank(buyer);
        vm.expectRevert(BasketRouter.MinimumsLengthMismatch.selector);
        router.sell(id, held, shortArray);
    }

    function test_sell_is_blocked_while_paused() public {
        uint256 id = _createIndex();
        uint256[] memory held = _buyThenApproveLegs(id);
        router.pause();

        vm.prank(buyer);
        vm.expectRevert(Guarded.ContractPaused.selector);
        router.sell(id, held, new uint256[](5));
    }

    /**
     * The cap is measured in the quote asset, not in the tokens being sold.
     *
     * This is the exact bug that got shipped in `Orders` first: `maxNotional`
     * is a 6 decimal USDG figure, and a sell is sized in 18 decimal shares, so
     * comparing the two rejected every sale of more than 0.000000000025 of a
     * share. Written as a differential, because a bare revert test here passed
     * once for entirely the wrong reason.
     */
    function test_sell_cap_is_measured_in_the_quote_asset() public {
        uint256 id = _createIndex();
        uint256[] memory held = _buyThenApproveLegs(id);
        uint256[] memory minOut = new uint256[](5);

        // Far below the 1e18 scale leg amounts, and far above the proceeds.
        router.setMaxNotional(SPEND);

        uint256 snapshot = vm.snapshotState();
        vm.prank(buyer);
        uint256 out = router.sell(id, held, minOut);
        assertGt(out, 0, "a sell well inside the cap was rejected");
        assertLt(out, SPEND, "expected proceeds under the cap for this test to mean anything");
        vm.revertToState(snapshot);

        // Now put the cap under the proceeds. Same call, same amounts.
        router.setMaxNotional(out - 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Guarded.OverCap.selector, out, out - 1));
        router.sell(id, held, minOut);
    }
}
