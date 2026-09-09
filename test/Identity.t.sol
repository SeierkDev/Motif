// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BasketRouter, IUniswapV3Factory} from "../src/BasketRouter.sol";
import {Guarded} from "../src/Guarded.sol";

interface IERC20I {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// Phase 7: a basket stops being an integer, a creator can back their own idea
/// at launch, and the quote asset becomes a choice instead of a hazard.
contract IdentityForkTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    BasketRouter router;
    address guardian = makeAddr("guardian");
    address creator = makeAddr("creator");

    /*
     * A local copy of the router's event, which has to be kept in step with it.
     *
     * This one had not been. The router's `IndexCreated` gained `image`, this
     * copy did not, and a `vm.expectEmit` against the wrong shape fails with
     * "IndexCreated != expected IndexCreated", which names the event and not
     * the reason. It went unseen for eight commits because the rpc refused this
     * group before it ever got this far.
     */
    event IndexCreated(
        uint256 indexed id,
        address indexed creator,
        uint16 creatorFeeBps,
        uint256 legs,
        string name,
        string symbol,
        string description,
        string image
    );

    function _quotes() internal pure returns (address[] memory q) {
        q = new address[](1);
        q[0] = USDG;
    }

    function _legs() internal pure returns (BasketRouter.Leg[] memory legs) {
        legs = new BasketRouter.Leg[](2);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: 500, weightBps: 6000});
        legs[1] = BasketRouter.Leg({token: TSLA, fee: 3000, weightBps: 4000});
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
        router = new BasketRouter(FACTORY, makeAddr("fees"), guardian, 0, _quotes());
        deal(USDG, creator, 100_000e6);
        vm.prank(creator);
        IERC20I(USDG).approve(address(router), type(uint256).max);
    }

    // ------------------------------------------------------------- identity

    /// The whole point of the phase: a launch carries a name people can share.
    function test_a_launch_carries_a_name_and_ticker() public {
        vm.expectEmit(true, true, false, true);
        emit IndexCreated(0, creator, 25, 2, "AI Core", "AICORE", "NVDA and TSLA, weighted 60/40.", "");
        vm.prank(creator);
        router.createIndex(USDG, _legs(), 25, "AI Core", "AICORE", "NVDA and TSLA, weighted 60/40.");
    }

    function test_a_nameless_basket_is_refused() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.BadMetadata.selector, "name 1 to 48 bytes"));
        router.createIndex(USDG, _legs(), 0, "", "AICORE", "");
    }

    function test_a_tickerless_basket_is_refused() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.BadMetadata.selector, "symbol 1 to 12 bytes"));
        router.createIndex(USDG, _legs(), 0, "AI Core", "", "");
    }

    /// Bounded so one launch cannot make the log arbitrarily expensive to read.
    function test_metadata_is_length_bounded() public {
        string memory long = new string(300);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.BadMetadata.selector, "description over 280 bytes"));
        router.createIndex(USDG, _legs(), 0, "AI Core", "AICORE", long);
    }

    // --------------------------------------------------------------- picture

    /**
     * A motif may carry a picture, and the rule is the factory's rule.
     *
     * @dev The tile drew nothing but the weight bands, which carry real
     *      information and are also the reason a grid of baskets drawn from
     *      twelve tickers all looked alike. The picture sits on top and the
     *      bands move to a strip along the bottom, which is what
     *      `BasketFactory` already does for a basket token, so both halves of
     *      the site read the same way.
     *
     *      The bands never go away. They are the only thing on a tile that says
     *      what the basket is actually made of, and a picture never says that.
     */
    function test_a_motif_can_carry_a_picture() public {
        vm.prank(creator);
        uint256 id = router.createIndex(
            USDG, _legs(), 0, "AI Core", "AICORE", "", "https://example.com/a.png"
        );
        assertEq(router.legsOf(id).length, 2, "the basket is unaffected by the picture");
    }

    function test_ipfs_is_a_link_too() public {
        vm.prank(creator);
        router.createIndex(USDG, _legs(), 0, "AI Core", "AICORE", "", "ipfs://bafyfake");
    }

    /// A browser will not load one on an https page, so recording it would be
    /// writing a dead link into a log that can never be edited.
    function test_http_is_refused() public {
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(BasketRouter.BadMetadata.selector, "image must be https:// or ipfs://")
        );
        router.createIndex(USDG, _legs(), 0, "AI Core", "AICORE", "", "http://example.com/a.png");
    }

    /// The one a site rendering whatever the log says would otherwise render.
    function test_a_script_url_is_refused() public {
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(BasketRouter.BadMetadata.selector, "image must be https:// or ipfs://")
        );
        router.createIndex(USDG, _legs(), 0, "AI Core", "AICORE", "", "javascript:alert(1)");
    }

    function test_the_picture_link_is_length_bounded() public {
        string memory long = string.concat("https://example.com/", new string(200));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.BadMetadata.selector, "image over 200 bytes"));
        router.createIndex(USDG, _legs(), 0, "AI Core", "AICORE", "", long);
    }

    /**
     * The six argument overload still publishes, with no picture.
     *
     * @dev It exists so `BasketCurve` compiles untouched, which keeps
     *      `BasketFactory` off the 24,576 byte deploy limit it sits 3,597 bytes
     *      under. A basket token has its own picture in the factory's own log,
     *      so the curve has nothing to pass.
     */
    function test_the_old_six_argument_shape_still_works() public {
        vm.prank(creator);
        uint256 id = router.createIndex(USDG, _legs(), 0, "AI Core", "AICORE", "");
        assertEq(router.legsOf(id).length, 2);
    }

    /**
     * And the same for a creator buy, for a different reason.
     *
     * @dev Nothing in this repository calls the eight argument `createAndBuy`.
     *      The site does, when there is no picture, because a router published
     *      before pictures existed implements only that selector and has no
     *      fallback, so the longer shape reverts against it with nothing
     *      attached. One build of the site therefore has to be able to reach
     *      either router, and this pins the shape that lets it.
     */
    function test_the_old_eight_argument_creator_buy_still_works() public {
        uint256[] memory minOut = new uint256[](2);

        // The picture lives in the log rather than in storage, so the log is
        // where an empty one is checked.
        vm.expectEmit(true, true, false, true, address(router));
        emit BasketRouter.IndexCreated(0, creator, 25, 2, "AI Core", "AICORE", "", "");

        vm.prank(creator);
        router.createAndBuy(USDG, _legs(), 25, "AI Core", "AICORE", "", 1_000e6, minOut);

        assertEq(router.indexCount(), 1);
        assertGt(IERC20I(NVDA).balanceOf(creator), 0, "creator did not receive NVDA");
    }

    // ----------------------------------------------------------- creator buy

    /// A creator putting money behind their own idea, in one transaction.
    function test_create_and_buy_publishes_and_fills_together() public {
        uint256[] memory minOut = new uint256[](2);
        vm.prank(creator);
        uint256 id =
            router.createAndBuy(USDG, _legs(), 25, "AI Core", "AICORE", "", "", 1_000e6, minOut);

        assertEq(id, 0, "should be the first basket");
        assertEq(router.indexCount(), 1);
        assertGt(IERC20I(NVDA).balanceOf(creator), 0, "creator did not receive NVDA");
        assertGt(IERC20I(TSLA).balanceOf(creator), 0, "creator did not receive TSLA");
        assertEq(IERC20I(USDG).balanceOf(address(router)), 0, "router kept a balance");
    }

    /// A failed creator buy must not leave a published basket behind.
    function test_a_failed_creator_buy_unwinds_the_launch() public {
        uint256[] memory minOut = new uint256[](2);
        minOut[0] = type(uint128).max;
        vm.prank(creator);
        vm.expectRevert();
        router.createAndBuy(USDG, _legs(), 25, "AI Core", "AICORE", "", "", 1_000e6, minOut);
        assertEq(router.indexCount(), 0, "a reverted launch still published");
    }

    // ---------------------------------------------------------- quote asset

    /// The threat model treated an arbitrary quote asset as a hazard. The
    /// allowlist keeps it shut and makes the capability a deliberate choice.
    function test_an_unlisted_quote_asset_is_refused() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.QuoteNotAllowed.selector, NVDA));
        router.createIndex(NVDA, _legs(), 0, "Beats NVDA", "VSNVDA", "");
    }

    /// And once the guardian allows one, a basket can be priced against it.
    /// Quoting in NVDA is a bet that the basket beats NVDA.
    function test_guardian_can_allow_a_new_quote_asset() public {
        vm.prank(guardian);
        router.setQuoteAllowed(NVDA, true);
        assertTrue(router.quoteAllowed(NVDA));

        // An NVDA/TSLA pool turns out to exist on this chain, so this is not a
        // hypothetical: a basket priced in NVDA and holding TSLA is buildable
        // today, and buying it is a bet that TSLA outruns NVDA.
        assertTrue(FACTORY.getPool(NVDA, TSLA, 3000) != address(0), "expected an NVDA/TSLA pool");

        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](1);
        legs[0] = BasketRouter.Leg({token: TSLA, fee: 3000, weightBps: 10_000});
        vm.prank(creator);
        uint256 id = router.createIndex(NVDA, legs, 0, "Beats NVDA", "VSNVDA", "");
        assertEq(router.inputOf(id), NVDA, "basket should be priced in NVDA");
    }

    function test_only_the_guardian_changes_the_allowlist() public {
        vm.prank(creator);
        vm.expectRevert(Guarded.NotGuardian.selector);
        router.setQuoteAllowed(NVDA, true);
    }

    /// Removing a quote asset stops new baskets and leaves existing ones alone.
    function test_removing_a_quote_asset_leaves_existing_baskets_working() public {
        vm.prank(creator);
        uint256 id = router.createIndex(USDG, _legs(), 0, "AI Core", "AICORE", "");

        vm.prank(guardian);
        router.setQuoteAllowed(USDG, false);

        uint256[] memory minOut = new uint256[](2);
        vm.prank(creator);
        router.buy(id, 500e6, minOut); // still fine

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.QuoteNotAllowed.selector, USDG));
        router.createIndex(USDG, _legs(), 0, "Another", "TWO", "");
    }
}
