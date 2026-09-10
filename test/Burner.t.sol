// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IUniswapV3Factory} from "../src/BasketRouter.sol";
import {MotifBurner, IPonsCurve} from "../src/MotifBurner.sol";

interface IERC20B {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/// The rest of the real curve, for pushing it around the way a trader would.
interface IPonsCurveTrade {
    function buy(uint256 quoteIn, uint256 minOut, address recipient) external payable returns (uint256);
    function sell(uint256 amountIn, uint256 minOut, address recipient) external returns (uint256);
    function graduated() external view returns (bool);
    function readyToGraduate() external view returns (bool);
    function quoteReserve() external view returns (uint256);
}

/**
 * @title The burner, against the real MOTIF curve on a mainnet fork
 *
 * Everything here is the chain as it stands: the real USDG, the real USDG/WETH
 * pool, the real Pons curve and the real token. Only the fee wallet is made up,
 * because the property being tested is what this contract does with whatever
 * a fee wallet holds and allows, not what one particular wallet happens to have.
 *
 * The claims worth measuring rather than reading off the code:
 *
 *   - supply actually falls, by exactly what was bought and burned
 *   - nothing is left behind in the contract, in any of the four assets
 *   - ten dollars is the floor and fifty the ceiling, and the fee wallet's own
 *     allowance is a ceiling too
 *   - a sandwich around the largest burn loses the attacker money
 *   - when the curve can no longer sell, a burn either completes or moves
 *     nothing, and never half of one
 */
contract BurnerForkTest is Test {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant MOTIF = 0x89565a7BBfddab021844e2f66a79852e46C802df;
    address constant CURVE = 0x1D2c7c085E831D827f4e8169D95BcE0296684897;
    /// The 0.01% tier, which holds most of the USDG/WETH liquidity on this factory.
    uint24 constant POOL_FEE = 100;

    MotifBurner burner;

    address feeWallet = makeAddr("feeWallet");
    address stranger = makeAddr("stranger");
    address attacker = makeAddr("attacker");

    function _forkUrl() internal view returns (string memory) {
        return vm.envOr("MOTIF_RPC", string("https://rpc.mainnet.chain.robinhood.com"));
    }

    function setUp() public {
        vm.createSelectFork(_forkUrl());
        burner = new MotifBurner(USDG, WETH, FACTORY, POOL_FEE, IPonsCurve(CURVE), feeWallet);
    }

    /// Once MOTIF graduates for real, this contract's route is gone and these
    /// tests describe a burner that has retired. Skipped rather than failed.
    modifier onTheCurve() {
        vm.skip(IPonsCurveTrade(CURVE).graduated());
        _;
    }

    function _fees(uint256 amount) internal {
        deal(USDG, feeWallet, amount);
    }

    function _approve(uint256 amount) internal {
        vm.prank(feeWallet);
        IERC20B(USDG).approve(address(burner), amount);
    }

    function _holdsNothing() internal view {
        assertEq(IERC20B(USDG).balanceOf(address(burner)), 0, "USDG left in the burner");
        assertEq(IERC20B(WETH).balanceOf(address(burner)), 0, "WETH left in the burner");
        assertEq(IERC20B(MOTIF).balanceOf(address(burner)), 0, "MOTIF left in the burner");
        assertEq(address(burner).balance, 0, "ETH left in the burner");
    }

    function test_the_fees_are_burned_and_supply_falls_by_exactly_that() public onTheCurve {
        _fees(25e6);
        _approve(type(uint256).max);
        uint256 supplyBefore = IERC20B(MOTIF).totalSupply();

        vm.prank(stranger);
        uint256 gasBefore = gasleft();
        uint256 bought = burner.burn(0);
        console.log("gas for one burn:", gasBefore - gasleft());

        assertGt(bought, 0, "bought nothing");
        assertEq(IERC20B(MOTIF).totalSupply(), supplyBefore - bought, "supply did not fall by what was bought");
        assertEq(IERC20B(USDG).balanceOf(feeWallet), 0, "fees left in the fee wallet");
        _holdsNothing();
        assertEq(burner.burns(), 1);
        assertEq(burner.usdgSpent(), 25e6);
        assertEq(burner.motifBurned(), bought);

        console.log("$25 of fees burned MOTIF:", bought / 1e18);
    }

    function test_under_ten_dollars_nothing_moves() public onTheCurve {
        _fees(10e6 - 1);
        _approve(type(uint256).max);

        (bool ok, uint256 amount, string memory why) = burner.ready();
        assertFalse(ok);
        assertEq(amount, 10e6 - 1);
        assertEq(why, "under the ten dollar minimum");

        vm.expectRevert(abi.encodeWithSelector(MotifBurner.BelowThreshold.selector, 10e6 - 1, 10e6));
        burner.burn(0);
    }

    function test_one_burn_spends_fifty_dollars_at_most() public onTheCurve {
        _fees(500e6);
        _approve(type(uint256).max);

        burner.burn(0);
        assertEq(IERC20B(USDG).balanceOf(feeWallet), 450e6, "the first burn spent more than fifty");

        burner.burn(0);
        assertEq(IERC20B(USDG).balanceOf(feeWallet), 400e6, "the second burn spent more than fifty");
        assertEq(burner.usdgSpent(), 100e6);
        _holdsNothing();
    }

    function test_without_the_approval_nothing_moves() public onTheCurve {
        _fees(100e6);

        (bool ok,, string memory why) = burner.ready();
        assertFalse(ok);
        assertEq(why, "the fee wallet has not approved this contract");

        vm.expectRevert(abi.encodeWithSelector(MotifBurner.BelowThreshold.selector, 0, 10e6));
        burner.burn(0);
        assertEq(IERC20B(USDG).balanceOf(feeWallet), 100e6);
    }

    function test_the_allowance_is_a_ceiling_too() public onTheCurve {
        _fees(100e6);
        _approve(20e6);

        burner.burn(0);
        assertEq(IERC20B(USDG).balanceOf(feeWallet), 80e6, "spent past what the fee wallet allowed");
        assertEq(IERC20B(USDG).allowance(feeWallet, address(burner)), 0);
    }

    function test_the_callers_floor_is_enforced() public onTheCurve {
        _fees(20e6);
        _approve(type(uint256).max);

        vm.expectRevert();
        burner.burn(type(uint256).max);
        assertEq(IERC20B(USDG).balanceOf(feeWallet), 20e6, "a refused burn still moved the fees");
    }

    function test_only_the_pool_can_call_back() public onTheCurve {
        vm.expectRevert(MotifBurner.UnknownCaller.selector);
        burner.uniswapV3SwapCallback(1, 0, "");

        // Even the real pool, outside a swap this contract started.
        vm.prank(burner.pool());
        vm.expectRevert(MotifBurner.UnknownCaller.selector);
        burner.uniswapV3SwapCallback(1, 0, "");
    }

    function test_it_takes_eth_only_from_weth() public onTheCurve {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(burner).call{value: 1}("");
        assertFalse(ok, "accepted ETH from somebody other than WETH");
    }

    /// Bought on the real curve and sent over, rather than conjured with `deal`.
    function test_motif_sent_here_is_burned_with_the_rest() public onTheCurve {
        vm.deal(stranger, 0.001 ether);
        vm.startPrank(stranger);
        uint256 gift = IPonsCurveTrade(CURVE).buy{value: 0.001 ether}(0.001 ether, 0, stranger);
        IERC20B(MOTIF).transfer(address(burner), gift);
        vm.stopPrank();

        _fees(15e6);
        _approve(type(uint256).max);
        uint256 supplyBefore = IERC20B(MOTIF).totalSupply();

        uint256 bought = burner.burn(0);

        assertEq(burner.motifBurned(), bought + gift, "the gift was not burned with the purchase");
        assertEq(IERC20B(MOTIF).totalSupply(), supplyBefore - bought - gift);
        _holdsNothing();
    }

    function test_usdg_sent_here_is_spent_too() public onTheCurve {
        deal(USDG, stranger, 15e6);
        vm.prank(stranger);
        IERC20B(USDG).transfer(address(burner), 15e6);

        // No fee wallet approval at all: the donation alone clears the minimum.
        uint256 bought = burner.burn(0);
        assertGt(bought, 0);
        assertEq(burner.usdgSpent(), 15e6);
        _holdsNothing();
    }

    /**
     * Buy first, let the largest possible burn push the price up, sell into it.
     *
     * The curve charges its fee on both of the attacker's trades and the burn is
     * at most fifty dollars, so the attacker pays a percentage of their own size
     * for a prize bounded by the burn's. Swept across sizes rather than argued,
     * and a size the curve itself refuses is counted as refused rather than as
     * a pass.
     */
    function test_a_sandwich_around_the_largest_burn_loses_money() public onTheCurve {
        uint256[5] memory sizes = [uint256(0.003 ether), 0.01 ether, 0.03 ether, 0.06 ether, 0.1 ether];
        bool anyLanded;
        int256 best;

        for (uint256 i; i < sizes.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 size = sizes[i];

            _fees(200e6);
            _approve(type(uint256).max);
            vm.deal(attacker, size);

            vm.prank(attacker);
            try IPonsCurveTrade(CURVE).buy{value: size}(size, 0, attacker) returns (uint256 got) {
                // The victim: the largest burn there is, with no floor at all.
                burner.burn(0);

                vm.startPrank(attacker);
                IERC20B(MOTIF).approve(CURVE, got);
                uint256 back = IPonsCurveTrade(CURVE).sell(got, 0, attacker);
                vm.stopPrank();

                int256 pnl = int256(back) - int256(size);
                console.log("attacker size (wei)", size);
                console.logInt(pnl);
                if (!anyLanded || pnl > best) best = pnl;
                anyLanded = true;
                assertLt(pnl, 0, "a sandwich around a burn made money");
            } catch {
                console.log("the curve refused an attacker buy of (wei)", size);
            }

            vm.revertToState(snap);
        }

        assertTrue(anyLanded, "no sandwich landed at any size, so this measured nothing");
        console.log("best attacker outcome (wei):");
        console.logInt(best);
    }

    /**
     * Push the real curve to its graduation line with real buys, then burn.
     *
     * Whether buys stop at the line or only once somebody graduates it is Pons's
     * business, and `graduate` is not open to a stranger. So this asserts the
     * one thing that matters whichever way the curve behaves: the burn either
     * completes, supply down and nothing left behind, or it reverts and the
     * fees are exactly where they were.
     */
    function test_at_the_graduation_line_a_burn_is_all_or_nothing() public onTheCurve {
        _fees(30e6);
        _approve(type(uint256).max);

        address whale = makeAddr("whale");
        vm.deal(whale, 20 ether);
        uint256 landed;
        for (uint256 i; i < 400; ++i) {
            IPonsCurveTrade c = IPonsCurveTrade(CURVE);
            if (c.readyToGraduate() || c.graduated()) break;
            // About one percent of the reserve a step, inside the curve's own
            // limit on how far one trade may move it.
            uint256 step = c.quoteReserve() / 100;
            vm.prank(whale);
            try c.buy{value: step}(step, 0, whale) {
                ++landed;
            } catch {
                break;
            }
        }
        console.log("whale buys that landed before the curve stopped selling:", landed);
        console.log("ready to graduate:", IPonsCurveTrade(CURVE).readyToGraduate());

        uint256 supplyBefore = IERC20B(MOTIF).totalSupply();
        try burner.burn(0) returns (uint256 bought) {
            console.log("the curve still sold at the line; burned", bought / 1e18);
            assertEq(IERC20B(MOTIF).totalSupply(), supplyBefore - bought);
            assertEq(IERC20B(USDG).balanceOf(feeWallet), 0);
            _holdsNothing();
        } catch {
            console.log("the curve refused at the line; nothing moved");
            assertEq(IERC20B(USDG).balanceOf(feeWallet), 30e6, "a failed burn moved the fees");
            assertEq(IERC20B(MOTIF).totalSupply(), supplyBefore);
            _holdsNothing();
        }
    }
}
