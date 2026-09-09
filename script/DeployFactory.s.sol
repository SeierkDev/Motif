// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {BasketRouter} from "../src/BasketRouter.sol";
import {BasketFactory} from "../src/BasketFactory.sol";
import {TokenSwap} from "../src/TokenSwap.sol";

/**
 * Deploy the basket token factory against a router that already exists.
 *
 * @dev **Separate from `Deploy.s.sol`, and deliberately so.** That script
 *      deploys a router, a rebalancer and an orders book together, and it is
 *      how a fresh chain or a fresh anvil gets a whole system. A factory is not
 *      part of that: it points at one router, that router is already deployed
 *      and immutable on mainnet, and whether the tokenised half should attach
 *      to the live router or to a new one is a decision for whoever is
 *      deploying rather than a constant to hard code here.
 *
 *      So the router is read from the environment and nothing is assumed:
 *
 *          MOTIF_ROUTER=0x7fAD2ADb589a07867477D40c142181151549AAcd \
 *          PRIVATE_KEY=0x... \
 *            forge script script/DeployFactory.s.sol:DeployFactory \
 *              --rpc-url $RPC --broadcast
 *
 *      **What this does not do:** it deploys no curve, publishes no index and
 *      buys nothing. The factory holds nothing, owns nothing and has no
 *      privileged caller, so deploying it grants nobody anything. Every basket
 *      after this is somebody calling `launch` and paying for it themselves.
 *
 *      **`TokenSwap` goes out with it, because half a launchpad is worse than
 *      none.** A graduated basket trades in its own Uniswap pool, and a pool
 *      cannot be traded by a wallet: it calls back into its caller for the
 *      input and an externally owned account has no code to answer with. Deploy
 *      the factory without this and every basket that graduates has a price on
 *      its page and no way to trade at it, which reads as a token you are not
 *      allowed to sell. It holds nothing and has no privileged caller either.
 */
contract DeployFactory is Script {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address router = vm.envAddress("MOTIF_ROUTER");
        address quote = vm.envOr("MOTIF_QUOTE", USDG);

        // Refuse an address with no code rather than deploying a factory that
        // points at nothing. Reading the deployment back is the rule this repo
        // already applies to every address it records, and a factory attached
        // to an empty address fails only at somebody's first launch.
        require(router.code.length > 0, "MOTIF_ROUTER has no code on this chain");

        // The router has to accept the quote asset, or every launch reverts
        // `QuoteNotAllowed` at `createIndex` inside the curve's constructor.
        require(BasketRouter(router).quoteAllowed(quote), "router does not allow that quote asset");

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);

        BasketFactory factory = new BasketFactory(BasketRouter(router), quote);
        // The same Uniswap factory the router swaps through, read off the
        // router rather than written down again, so the two cannot disagree.
        TokenSwap swap = new TokenSwap(BasketRouter(router).factory());

        vm.stopBroadcast();

        console.log("BasketFactory", address(factory));
        console.log("TokenSwap    ", address(swap));
        console.log("router       ", router);
        console.log("quote asset  ", quote);
        console.log("");
        console.log("Set these and redeploy the two services:");
        console.log("  api  MOTIF_FACTORY        =", address(factory));
        console.log("  web  NEXT_PUBLIC_FACTORY  =", address(factory));
        console.log("  web  NEXT_PUBLIC_SWAP     =", address(swap));
    }
}
