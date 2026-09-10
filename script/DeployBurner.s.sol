// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {BasketRouter, IUniswapV3Factory} from "../src/BasketRouter.sol";
import {MotifBurner, IPonsCurve} from "../src/MotifBurner.sol";

/**
 * Deploy the burner that turns the protocol fee into burned MOTIF.
 *
 * @dev **The fee wallet is read off the router, never typed in.** The burner
 *      pulls from whatever address it is given, so the one number that must not
 *      be wrong is the one this script refuses to take as an input. It asks the
 *      live router for `protocolFeeTo`, and the Uniswap factory the same way, so
 *      neither can disagree with what the router actually pays:
 *
 *          MOTIF_ROUTER=0x7fAD2ADb589a07867477D40c142181151549AAcd \
 *          PRIVATE_KEY=0x... \
 *            forge script script/DeployBurner.s.sol:DeployBurner \
 *              --rpc-url $RPC --broadcast
 *
 *      **Deploying it grants nothing.** No owner, no settings. Until the fee
 *      wallet approves it, it can do nothing at all, and that approval is a
 *      separate transaction the fee wallet signs itself.
 */
contract DeployBurner is Script {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant MOTIF = 0x89565a7BBfddab021844e2f66a79852e46C802df;
    address constant CURVE = 0x1D2c7c085E831D827f4e8169D95BcE0296684897;
    /// The 0.01% tier, which holds most of the USDG/WETH liquidity on the factory.
    uint24 constant POOL_FEE = 100;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address router = vm.envAddress("MOTIF_ROUTER");

        require(router.code.length > 0, "MOTIF_ROUTER has no code on this chain");
        require(IPonsCurve(CURVE).token() == MOTIF, "that curve does not sell MOTIF");
        // After graduation the curve no longer sells, so this contract's route
        // would be closed from its first block. That needs a different burner.
        require(!IPonsCurve(CURVE).graduated(), "MOTIF has graduated off its curve; this route is closed");

        address source = BasketRouter(router).protocolFeeTo();
        IUniswapV3Factory factory = BasketRouter(router).factory();

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        MotifBurner burner = new MotifBurner(USDG, WETH, factory, POOL_FEE, IPonsCurve(CURVE), source);
        vm.stopBroadcast();

        console.log("MotifBurner  ", address(burner));
        console.log("pulls from   ", source);
        console.log("swaps through", burner.pool());
        console.log("burns        ", burner.motif());
        console.log("");
        console.log("1. Set this on the api and restart it:");
        console.log("     MOTIF_BURNER =", address(burner));
        console.log("2. Then, from the fee wallet and nowhere else, approve it:");
        console.log("     USDG.approve(burner, type(uint256).max)");
    }
}
