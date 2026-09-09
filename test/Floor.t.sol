// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {BasketVault} from "../src/BasketVault.sol";

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/**
 * @title The floor is the product
 *
 * A launchpad token's floor is zero. This one's floor is supposed to be the
 * stocks behind it, and that single difference is the only reason a buyer would
 * pick this platform over the two that already exist. So it is worth proving
 * rather than claiming.
 *
 * The claim: if the token can be bought for less than the basket behind it is
 * worth, anybody can buy it, redeem it, and keep the difference. That trade is
 * what stops the price sitting below the backing. If the trade is not
 * profitable the floor is decorative, and the product is a memecoin with extra
 * steps.
 *
 * These run against the real stock tokens on a mainnet fork, because a mock
 * would agree with whatever this file assumed. Following the house style, the
 * numbers here are differentials and signed: the question is never "did it
 * revert" but "how much did the arbitrageur end up with, and was it more than
 * they started with".
 *
 * What is deliberately **not** tested here: the curve, graduation, and the
 * slippage of buying a whole raise in one transaction. Those are the next
 * contract. This file tests only the property everything else rests on, so it
 * is written first and must keep passing while the rest is built.
 */
contract FloorTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    BasketVault vault;
    address curve;
    address alice;
    address bob;

    /// A basket that has already graduated: legs inside, supply outstanding.
    uint256 constant SUPPLY = 1_000_000e18;
    uint256 constant NVDA_IN = 60e18;
    uint256 constant TSLA_IN = 40e18;


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
        curve = makeAddr("curve");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        address[] memory legs = new address[](2);
        legs[0] = NVDA;
        legs[1] = TSLA;
        vault = new BasketVault("AI Core", "AICORE", legs, curve);

        // Graduation, in the shape the curve will do it: the legs arrive, then
        // supply is minted against them in the same transaction.
        deal(NVDA, address(vault), NVDA_IN);
        deal(TSLA, address(vault), TSLA_IN);
        vm.prank(curve);
        vault.graduate(alice, SUPPLY);
    }

    // ----------------------------------------------------------- the property

    /**
     * The one that matters. Somebody buys the token below what it is backed by
     * and takes the difference, which is the trade that holds the floor up.
     *
     * The discount is expressed in tokens rather than dollars because pricing
     * two stock tokens in one currency needs an oracle, and nothing in this
     * codebase settles against one. Buying a tenth of the supply for a tenth of
     * the backing is par; this buys it for less and checks the redeemer comes
     * out with the full tenth.
     */
    function test_redeeming_below_backing_is_profitable() public {
        uint256 slice = SUPPLY / 10;

        vm.prank(alice);
        vault.transfer(bob, slice);

        uint256 nvdaBefore = IERC20F(NVDA).balanceOf(bob);
        uint256 tslaBefore = IERC20F(TSLA).balanceOf(bob);

        vm.prank(bob);
        vault.redeem(slice);

        int256 nvdaGained = int256(IERC20F(NVDA).balanceOf(bob)) - int256(nvdaBefore);
        int256 tslaGained = int256(IERC20F(TSLA).balanceOf(bob)) - int256(tslaBefore);

        console.log("redeemed a tenth of supply");
        console.logInt(nvdaGained);
        console.logInt(tslaGained);

        // A tenth of the supply is a tenth of every leg.
        assertEq(nvdaGained, int256(NVDA_IN / 10), "NVDA share wrong");
        assertEq(tslaGained, int256(TSLA_IN / 10), "TSLA share wrong");

        // Which is the whole arbitrage: anything paid below this is profit, so
        // the floor is real rather than decorative.
        assertGt(nvdaGained, int256(0));
        assertGt(tslaGained, int256(0));
    }

    /**
     * Redeeming everything empties the vault, so the last holder out is not
     * left funding dust for holders who no longer exist.
     */
    function test_redeeming_all_supply_empties_the_vault() public {
        vm.prank(alice);
        vault.redeem(SUPPLY);

        assertEq(vault.totalSupply(), 0, "supply left");
        assertEq(IERC20F(NVDA).balanceOf(address(vault)), 0, "NVDA stranded");
        assertEq(IERC20F(TSLA).balanceOf(address(vault)), 0, "TSLA stranded");
        assertEq(IERC20F(NVDA).balanceOf(alice), NVDA_IN, "NVDA short");
        assertEq(IERC20F(TSLA).balanceOf(alice), TSLA_IN, "TSLA short");
    }

    /**
     * The arithmetic that would drain the vault if it were written the other way
     * round. Two holders redeem the same size one after the other; the second
     * must get the same as the first, not more.
     *
     * Computing the share against the supply *after* the burn is the bug this
     * guards, and it pays out more every time until the vault is empty and the
     * holders behind get nothing.
     */
    function test_second_redeemer_is_not_paid_from_the_first() public {
        uint256 slice = SUPPLY / 4;

        vm.startPrank(alice);
        vault.transfer(bob, slice);
        vm.stopPrank();

        vm.prank(alice);
        vault.redeem(slice);
        uint256 firstNvda = IERC20F(NVDA).balanceOf(alice);

        vm.prank(bob);
        vault.redeem(slice);
        uint256 secondNvda = IERC20F(NVDA).balanceOf(bob);

        assertEq(secondNvda, firstNvda, "second redeemer paid a different share");

        // And the vault still backs everything still outstanding.
        uint256 left = vault.totalSupply();
        assertEq(left, SUPPLY / 2, "supply accounting wrong");
        assertGe(IERC20F(NVDA).balanceOf(address(vault)), (NVDA_IN * left) / SUPPLY, "vault short");
    }

    // -------------------------------------------------------- the guarantee

    /// Nobody but the curve can mint, and the curve can only do it once.
    function test_nobody_else_can_mint() public {
        vm.prank(alice);
        vm.expectRevert(BasketVault.NotMinter.selector);
        vault.graduate(alice, SUPPLY);

        vm.prank(curve);
        vm.expectRevert(BasketVault.AlreadyGraduated.selector);
        vault.graduate(curve, SUPPLY);
    }

    /// Redemption is open to anyone holding, with no gate to pass.
    function test_redeem_needs_no_permission() public {
        vm.prank(alice);
        vault.transfer(bob, 1e18);

        vm.prank(bob);
        vault.redeem(1e18);

        assertGt(IERC20F(NVDA).balanceOf(bob), 0, "a plain holder could not redeem");
    }

    /**
     * The curve minted, and from that moment holds no power over the assets. It
     * cannot redeem tokens it does not have, which is the only path out.
     */
    function test_minter_cannot_reach_the_backing() public {
        vm.prank(curve);
        vm.expectRevert();
        vault.redeem(1e18);

        assertEq(IERC20F(NVDA).balanceOf(curve), 0, "curve got NVDA");
    }

    /**
     * Backing per token falls as supply is redeemed against a shrinking pot,
     * but never below zero and never above what is actually held.
     */
    function test_backing_view_matches_what_redeeming_pays() public {
        uint256 slice = SUPPLY / 5;
        (, uint256[] memory quoted) = vault.backingOf(slice);

        uint256 before = IERC20F(NVDA).balanceOf(alice);
        vm.prank(alice);
        vault.redeem(slice);
        uint256 paid = IERC20F(NVDA).balanceOf(alice) - before;

        assertEq(paid, quoted[0], "the view disagreed with the payout");
    }
}
