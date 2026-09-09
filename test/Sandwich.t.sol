// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {BasketRouter, IUniswapV3Factory} from "../src/BasketRouter.sol";
import {Rebalancer} from "../src/Rebalancer.sol";
import {IAggregatorV3} from "../src/OracleLib.sol";
import {IPermit2} from "../src/IPermit2.sol";

interface IERC20S {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

contract Feed is IAggregatorV3 {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public immutable dec;

    constructor(int256 a, uint8 d) {
        answer = a;
        updatedAt = block.timestamp;
        dec = d;
    }

    function decimals() external view returns (uint8) {
        return dec;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/**
 * @title What a rebalance is actually worth sandwiching
 *
 * A keeper's `rebalance` goes through the public mempool, so anybody can see it
 * coming and trade around it. That it is *possible* was never in question. The
 * question is whether it is worth doing, because the answer decides whether
 * this needs a private submission path or only a documented bound.
 *
 * Everything here runs against the real NVDA/USDG pool on a mainnet fork. Gas is
 * ignored throughout, which is generous to the attacker: this is an L2 where two
 * swaps cost a fraction of a cent, so gas is not what protects anyone.
 *
 * The attack on a seller is: sell first to push the price down, let the victim
 * sell into the hole, then buy back cheaper. Two things bound it. The victim's
 * floor is anchored to the oracle, so pushing too far makes their transaction
 * revert and the attacker collects nothing. And the attacker pays the pool fee
 * on the way out and again on the way back, on their own size rather than on
 * the victim's.
 */
contract SandwichForkTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;
    address constant PERMIT2_ADDR = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint24 constant FEE_NVDA = 500; // 0.05%, paid twice by a sandwicher
    uint24 constant FEE_AMC = 3000;

    int256 constant NVDA_USD = 230e8;
    uint256 constant NVDA_PRICE = 230;

    BasketRouter router;
    Rebalancer rb;

    address owner = makeAddr("owner");
    address holder = makeAddr("holder");
    address keeper = makeAddr("keeper");
    address attacker = makeAddr("attacker");

    uint256 basketId;
    uint256 nvdaOnly; // a single leg index, used only as the attacker's venue

    function _quotes() internal pure returns (address[] memory q) {
        q = new address[](1);
        q[0] = USDG;
    }

    function _permit(address who, address token, address spender) internal {
        vm.startPrank(who);
        IERC20S(token).approve(PERMIT2_ADDR, type(uint256).max);
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
        router = new BasketRouter(FACTORY, makeAddr("fees"), address(this), 0, _quotes());
        rb = new Rebalancer(router, FACTORY, USDG, owner, address(this), 0);

        vm.startPrank(owner);
        rb.registerFeed(NVDA, new Feed(NVDA_USD, 8));
        rb.registerFeed(AMC, new Feed(3e8, 8));
        vm.stopPrank();

        BasketRouter.Leg[] memory legs = new BasketRouter.Leg[](2);
        legs[0] = BasketRouter.Leg({token: NVDA, fee: FEE_NVDA, weightBps: 5000});
        legs[1] = BasketRouter.Leg({token: AMC, fee: FEE_AMC, weightBps: 5000});
        basketId = router.createIndex(USDG, legs, 0, "Sandwich Target", "TARGET", "");

        BasketRouter.Leg[] memory one = new BasketRouter.Leg[](1);
        one[0] = BasketRouter.Leg({token: NVDA, fee: FEE_NVDA, weightBps: 10_000});
        nvdaOnly = router.createIndex(USDG, one, 0, "NVDA Only", "NVDAONLY", "");

        vm.startPrank(attacker);
        IERC20S(USDG).approve(address(router), type(uint256).max);
        IERC20S(NVDA).approve(address(router), type(uint256).max);
        vm.stopPrank();

        _permit(holder, NVDA, address(rb));
        _permit(holder, AMC, address(rb));
    }

    /* ------------------------------------------------------------ the venue */

    function _sellNvda(uint256 amount) internal returns (uint256 usdgOut) {
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory minOut = new uint256[](1);
        amounts[0] = amount;
        uint256 before = IERC20S(USDG).balanceOf(attacker);
        vm.prank(attacker);
        router.sell(nvdaOnly, amounts, minOut);
        usdgOut = IERC20S(USDG).balanceOf(attacker) - before;
    }

    function _buyNvda(uint256 usdgIn) internal returns (uint256 nvdaOut) {
        uint256[] memory minOut = new uint256[](1);
        uint256 before = IERC20S(NVDA).balanceOf(attacker);
        vm.prank(attacker);
        router.buy(nvdaOnly, usdgIn, minOut);
        nvdaOut = IERC20S(NVDA).balanceOf(attacker) - before;
    }

    /// USDG per whole NVDA, in cents, straight from the pool.
    function _poolPriceCents() internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        deal(NVDA, attacker, 1e16); // a hundredth, small enough not to move it
        uint256 out = _sellNvda(1e16);
        vm.revertToState(snap);
        return out * 100 * 100 / 1e6; // 1e6 USDG units, times 100 for a whole NVDA, in cents
    }

    /* ----------------------------------------------------------- the victim */

    /// A wallet 70/30 against a 50/50 target, sized by its NVDA holding.
    function _position(uint256 nvdaAmount, uint16 slippageBps) internal {
        deal(NVDA, holder, nvdaAmount);
        deal(AMC, holder, (nvdaAmount * NVDA_PRICE * 3) / 7 / 3);
        vm.prank(holder);
        rb.subscribe(basketId, 500, slippageBps, 1 hours, 0);
    }

    /* ---------------------------------------------------------- the measure */

    /// One full sandwich. Returns the attacker's signed profit in NVDA wei.
    /// Reverts if the victim's transaction does, which is the whole constraint.
    function attempt(uint256 frontRun) external returns (int256 profitWei) {
        require(msg.sender == address(this), "internal");
        deal(NVDA, attacker, frontRun);
        uint256 usdg = _sellNvda(frontRun);

        vm.prank(keeper);
        rb.rebalance(holder); // reverts on its oracle floor if the push was too far

        uint256 back = _buyNvda(usdg);
        profitWei = int256(back) - int256(frontRun);
    }

    /// Cents, signed, from NVDA wei.
    function _cents(int256 wei_) internal pure returns (int256) {
        return (wei_ * int256(NVDA_PRICE) * 100) / 1e18;
    }

    function _sign(int256 v) internal pure returns (string memory) {
        return v < 0 ? string.concat("-", vm.toString(uint256(-v))) : vm.toString(uint256(v));
    }

    /**
     * Sweep the front run size on a ladder and keep the best outcome.
     *
     * A ladder rather than a binary search, because the earlier version searched
     * for the size at which the victim reverts, found nothing inside twenty
     * times the position, and reported that boundary as if it were an optimum.
     * The constraint that actually binds is the attacker's own cost, not the
     * victim's floor, and a sweep shows that where a search hid it.
     */
    function _best(uint256 nvdaAmount, uint16 slippageBps)
        internal
        returns (int256 bestCents, uint256 bestSize, uint256 reverted)
    {
        uint256[8] memory ladder = [
            nvdaAmount / 2, nvdaAmount, nvdaAmount * 3, nvdaAmount * 10,
            nvdaAmount * 30, nvdaAmount * 100, nvdaAmount * 300, nvdaAmount * 1000
        ];
        bestCents = type(int256).min;
        for (uint256 i; i < ladder.length; ++i) {
            if (ladder[i] == 0) continue;
            uint256 snap = vm.snapshotState();
            _position(nvdaAmount, slippageBps);
            try this.attempt(ladder[i]) returns (int256 profitWei) {
                int256 c = _cents(profitWei);
                if (c > bestCents) {
                    bestCents = c;
                    bestSize = ladder[i];
                }
            } catch {
                reverted++;
            }
            vm.revertToState(snap);
        }
    }

    /* ------------------------------------------------------------ the table */

    /**
     * What one rebalance is worth to an attacker, across realistic positions and
     * every slippage setting a holder can choose.
     *
     * Read the printed table. The assertion below only pins the conclusion the
     * numbers supported when this was written, so a change that quietly makes
     * rebalances worth attacking fails the suite rather than passing it.
     */
    function test_what_a_sandwich_is_worth() public {
        uint16[4] memory slippages = [uint16(100), 300, 500, 1000];
        uint256[3] memory sizes = [uint256(4e18), 40e18, 400e18]; // $920, $9.2k, $92k

        console.log("");
        console.log("  NVDA/USDG pool price, cents:");
        console.logUint(_poolPriceCents());
        console.log("");
        console.log("  position   slippage   best front run   attacker profit, cents   reverted");
        console.log("  ---------------------------------------------------------------------------");

        int256 mostTaken = type(int256).min;
        for (uint256 s; s < sizes.length; ++s) {
            for (uint256 t; t < slippages.length; ++t) {
                (int256 cents, uint256 size, uint256 reverted) = _best(sizes[s], slippages[t]);
                if (cents > mostTaken) mostTaken = cents;
                console.log(
                    string.concat(
                        "  $", vm.toString((sizes[s] * NVDA_PRICE) / 1e18),
                        "      ", vm.toString(uint256(slippages[t])), " bps",
                        "     ", vm.toString(size / 1e18), " NVDA",
                        "        ", _sign(cents),
                        "                ", vm.toString(reverted), "/8"
                    )
                );
            }
        }

        console.log("");
        console.log("  best an attacker did, in cents, over every size and setting:");
        console.log(_sign(mostTaken));

        // Negative means every sandwich in the sweep lost the attacker money.
        assertLt(mostTaken, 0, "a rebalance became profitable to sandwich");
    }

    /**
     * The same question for every other ticker, because NVDA is the deep one.
     *
     * A conclusion drawn from the deepest pool on the chain would be worth
     * nothing: the whole argument is that depth swamps the prize, so it has to
     * be checked where there is least of it. This sells a fixed $5,000 notional
     * into each pool and reports the price impact, which ranks them.
     */
    function test_depth_of_every_pool() public {
        address[8] memory tokens = [
            NVDA,
            0x322F0929c4625eD5bAd873c95208D54E1c003b2d, // TSLA
            AMC,
            0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f, // SLV
            0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, // SPY
            0xec262a75e413fAfD0dF80480274532C79D42da09, // MSTR
            0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8, // NFLX
            0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa // SPCX
        ];
        uint24[8] memory fees = [uint24(500), 3000, 3000, 3000, 500, 10000, 3000, 500];
        string[8] memory names = ["NVDA", "TSLA", "AMC ", "SLV ", "SPY ", "MSTR", "NFLX", "SPCX"];

        console.log("");
        console.log("  impact of selling $5,000 into each pool, in basis points");
        console.log("  -------------------------------------------------------");

        for (uint256 i; i < tokens.length; ++i) {
            uint256 snap = vm.snapshotState();
            BasketRouter.Leg[] memory one = new BasketRouter.Leg[](1);
            one[0] = BasketRouter.Leg({token: tokens[i], fee: fees[i], weightBps: 10_000});
            uint256 id = router.createIndex(USDG, one, 0, "probe", "PROBE", "");

            // Buy $5,000 of it, then sell the same tokens straight back. The
            // round trip loss is the pool fee plus twice the impact, which is
            // the number that matters to anyone thinking about moving a price.
            deal(USDG, attacker, 5_000e6);
            uint256[] memory minOut = new uint256[](1);
            vm.prank(attacker);
            router.buy(id, 5_000e6, minOut);

            uint256 got = IERC20S(tokens[i]).balanceOf(attacker);
            vm.startPrank(attacker);
            IERC20S(tokens[i]).approve(address(router), type(uint256).max);
            vm.stopPrank();

            uint256[] memory amounts = new uint256[](1);
            amounts[0] = got;
            vm.prank(attacker);
            router.sell(id, amounts, minOut);

            uint256 back = IERC20S(USDG).balanceOf(attacker);
            uint256 lostBps = back >= 5_000e6 ? 0 : ((5_000e6 - back) * 10_000) / 5_000e6;
            console.log(string.concat("  ", names[i], "   ", vm.toString(lostBps), " bps round trip"));
            vm.revertToState(snap);
        }
    }

    /**
     * Why it does not pay: the pool is far too deep relative to the prize.
     *
     * Measures how much NVDA has to be sold to move the pool one percent, what
     * that costs the attacker in pool fees alone for the round trip, and what
     * the largest possible prize is on the other side.
     */
    function test_moving_this_pool_costs_more_than_the_prize() public {
        uint256 start = _poolPriceCents();

        uint256 lo = 0;
        uint256 hi = 200_000e18;
        for (uint256 i; i < 18; ++i) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            deal(NVDA, attacker, mid);
            _sellNvda(mid);
            uint256 after_ = _poolPriceCents();
            vm.revertToState(snap);
            if (after_ * 100 <= start * 99) hi = mid;
            else lo = mid;
        }
        uint256 toMoveOnePercent = hi;
        uint256 notionalUsd = (toMoveOnePercent * NVDA_PRICE) / 1e18;
        // 0.05% on the way out and again on the way back.
        uint256 roundTripFeeUsd = (notionalUsd * 2 * FEE_NVDA) / 1_000_000;

        // The victim: a $9,200 position 70/30 against 50/50 sells about $1,300.
        uint256 victimSwapUsd = 1_300;
        // The most a 1% push can take from them, before their floor stops it.
        uint256 prizeUsd = victimSwapUsd / 100;

        console.log("");
        console.log("  NVDA to push the pool 1%:");
        console.logUint(toMoveOnePercent / 1e18);
        console.log("  that is a notional, in dollars, of:");
        console.logUint(notionalUsd);
        console.log("  pool fees alone on the round trip, in dollars:");
        console.logUint(roundTripFeeUsd);
        console.log("  the most a 1% push takes from a $9,200 rebalance, in dollars:");
        console.logUint(prizeUsd);

        assertGt(roundTripFeeUsd, prizeUsd * 20, "the pool got thin enough to make this worth doing");
    }
}
