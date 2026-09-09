// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {BasketRouter, IUniswapV3Factory} from "../src/BasketRouter.sol";
import {Rebalancer} from "../src/Rebalancer.sol";
import {Orders} from "../src/Orders.sol";
import {IAggregatorV3} from "../src/OracleLib.sol";

/**
 * Deploy both contracts and publish one starting index.
 *
 * Written to run against a local anvil fork of Robinhood Chain mainnet, which
 * gives the real Uniswap V3 pools and the real stock tokens without needing a
 * funded wallet. The same script works against testnet or mainnet by changing
 * only the rpc url.
 */
contract Deploy is Script {
    IUniswapV3Factory constant FACTORY = IUniswapV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant AMC = 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B;
    address constant SLV = 0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;

    /// The one feed confirmed on chain. The rest get registered as they are found.
    /// The review window cap. 25,000 USDG per call bounds what a bug can pull
    /// from any single allowance while these contracts are unaudited.
    uint256 constant MAX_NOTIONAL = 25_000e6;

    address constant NVDA_USD_FEED = 0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2;

    function quotes() internal pure returns (address[] memory q) {
        q = new address[](1);
        q[0] = USDG;
    }

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);

        /**
         * Who gets paid is separate from who signs.
         *
         * Receiving a fee needs an address. Only signing needs a key. This
         * script used to pass `deployer` into every role, which quietly meant
         * the wallet collecting protocol revenue forever had to have its
         * private key sitting wherever the deploy ran from. On a hosted runner
         * that is a secret in a repository, which is a bad home for the key to
         * an address you intend to keep.
         *
         * It matters more than an ordinary default because two of these are
         * permanent: `protocolFeeTo` on the router and `owner` on the
         * rebalancer are both immutable. Getting them wrong means redeploying
         * and abandoning the first set. The guardian can be transferred or
         * renounced later.
         *
         * Unset, everything still collapses to the deployer, which is what a
         * local anvil run wants and what seed-fork.sh has always done.
         */
        address feeTo = vm.envOr("MOTIF_FEE_TO", deployer);
        address guardian = vm.envOr("MOTIF_GUARDIAN", feeTo);
        address rebalancerOwner = vm.envOr("MOTIF_OWNER", feeTo);

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);

        BasketRouter router = new BasketRouter(FACTORY, feeTo, guardian, MAX_NOTIONAL, quotes());
        Rebalancer rebalancer =
            new Rebalancer(router, FACTORY, USDG, rebalancerOwner, guardian, MAX_NOTIONAL);
        // registerFeed is onlyOwner, and the owner is no longer necessarily the
        // account signing this. Calling it from anyone else reverts, which
        // would take the whole deploy down after two contracts had already
        // landed, so it is attempted only when they are the same account and
        // reported loudly when they are not. It is an add only registry and
        // nothing in the buy or sell path reads it, so registering later from
        // the owner costs nothing but a transaction.
        bool feedRegistered = rebalancerOwner == deployer;
        if (feedRegistered) rebalancer.registerFeed(NVDA, IAggregatorV3(NVDA_USD_FEED));

        // Stops and limits. Deployed here because Phase 5 built them and the
        // deploy script never learned about them, so nothing could reach them.
        Orders orders = new Orders(FACTORY, USDG, guardian, MAX_NOTIONAL);

        // Nothing is seeded on purpose. This is a launchpad, so the first
        // basket on the leaderboard should belong to a person, not to us.

        vm.stopBroadcast();

        console.log("BasketRouter", address(router));
        console.log("Rebalancer  ", address(rebalancer));
        console.log("Orders      ", address(orders));
        console.log("quote asset ", USDG);
        // Printed so the permanent choices are visible in the log next to the
        // addresses they were baked into, rather than inferred from the wallet
        // that happened to sign.
        console.log("signed by   ", deployer);
        console.log("fees to     ", feeTo);
        console.log("guardian    ", guardian);
        console.log("rebalancer owner", rebalancerOwner);
        if (feedRegistered) console.log("NVDA feed   registered");
        else console.log("NVDA feed   NOT registered, call registerFeed from the owner");
    }
}
