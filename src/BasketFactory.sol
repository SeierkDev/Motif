// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BasketRouter, SafeTransfer} from "./BasketRouter.sol";
import {BasketCurve} from "./BasketCurve.sol";

/**
 * @title BasketFactory
 * @notice Launch a basket token in one transaction, and be findable afterwards.
 *
 * @dev **Why this is so thin.** Everything that could be got wrong is already
 *      structural: `BasketCurve` publishes its own index, deploys its own vault
 *      from the same legs, and creates and prices its own pool, all in its
 *      constructor. There is no configuration left for a factory to hold and
 *      no pairing left for it to check. What remains is the two things a
 *      contract has to do that a deploy script cannot:
 *
 *      **One transaction.** A launch was previously a `forge script` run
 *      followed by pasting an address into an environment variable. That is not
 *      a product. `launch` is a button.
 *
 *      **An event to index.** Without one there is nothing to discover: the
 *      site cannot list a basket it was not told about, and the api has no log
 *      to scan. `Launched` is that log, and it carries everything the indexer
 *      needs so it never has to call back into the chain to render a row.
 *
 *      **No ownership, no fees, no pause, and no upgrade.** This contract holds
 *      nothing, can move nothing, and has no privileged caller. Anyone may
 *      launch, and a launch nobody likes is a row in a list rather than
 *      something to be removed, because there is no one here who could remove
 *      it. Curation belongs to whoever is reading the list.
 */
contract BasketFactory {
    using SafeTransfer for address;

    BasketRouter public immutable router;

    /// What baskets are priced and raised in. USDG for everything shipped so far.
    address public immutable quote;

    /**
     * Every curve ever launched here, in order.
     *
     * @dev Kept on chain as well as in the event, so the set is recoverable
     *      from a plain `eth_call` when an indexer is down or being rebuilt. It
     *      is append only and nothing can remove an entry.
     */
    address[] public curves;

    /// Which curve a launched index belongs to, for going the other way.
    mapping(uint256 => address) public curveOfIndex;

    /**
     * @dev The name and symbol ride in the event rather than being read back
     *      off the vault, so an indexer can render a row from the log alone.
     *      The same reasoning as `BasketRouter.IndexCreated`, which this
     *      deliberately mirrors.
     */
    event Launched(
        address indexed curve,
        address indexed creator,
        uint256 indexed indexId,
        address vault,
        address pool,
        uint256 threshold,
        uint16 creatorFeeBps,
        uint256 legs,
        string name,
        string symbol,
        string description,
        string image
    );

    /**
     * The longest picture link a launch may carry.
     *
     * @dev A url rather than the bytes. Nothing about a picture belongs in
     *      contract storage or in the redemption arithmetic, and a basket whose
     *      image link rots is still a basket that redeems, which is the only
     *      claim this system makes. Bounded so a launch cannot be made
     *      expensive for everybody reading the log, the same reason the name and
     *      description are bounded in the router.
     */
    uint256 public constant MAX_IMAGE_BYTES = 200;

    error BadImage();
    error ZeroAmount();

    constructor(BasketRouter router_, address quote_) {
        router = router_;
        quote = quote_;
    }

    function count() external view returns (uint256) {
        return curves.length;
    }

    /**
     * @notice Publish a basket, open its curve, and start raising. One call.
     *
     * @param legs The stock tokens and their weights, which must sum to 10,000
     *        basis points. Validated by the router, not here.
     * @param creatorFeeBps What the router pays `msg.sender` on the one buy
     *        this basket ever makes, capped by the router at 1%.
     * @param threshold The usdg raise at which the basket graduates, in usdg's
     *        own six decimals.
     *
     * @dev Permissionless, and the caller is the creator. Everything the curve
     *      needs is decided here and nothing can be changed afterwards, because
     *      the curve has no setters and this contract has no powers over it.
     */
    function launch(
        BasketRouter.Leg[] calldata legs,
        uint16 creatorFeeBps,
        uint256 threshold,
        string calldata name,
        string calldata symbol,
        string calldata description,
        string calldata image
    ) public returns (BasketCurve curve, uint256 indexId) {
        _checkImage(image);

        curve = new BasketCurve(
            BasketCurve.Launch({
                router: router,
                creator: msg.sender,
                quote: quote,
                legs: legs,
                creatorFeeBps: creatorFeeBps,
                threshold: threshold,
                name: name,
                symbol: symbol,
                description: description
            })
        );

        indexId = curve.indexId();
        curves.push(address(curve));
        curveOfIndex[indexId] = address(curve);

        emit Launched(
            address(curve),
            msg.sender,
            indexId,
            address(curve.vault()),
            curve.pool(),
            threshold,
            creatorFeeBps,
            legs.length,
            name,
            symbol,
            description,
            image
        );
    }

    /**
     * @notice Publish it and take the first position in it, in one call.
     *
     * @param amountIn usdg to spend on the curve immediately after launching,
     *        in usdg's own six decimals. Must be non zero; a launch with no
     *        buy is `launch`.
     * @param minOut The caller's own bound on what that buy returns, the same
     *        protection `BasketCurve.buy` gives anybody else.
     *
     * @dev A creator backing their own idea at launch, which is the mechanic
     *      `BasketRouter.createAndBuy` already gives a motif, and the reason a
     *      new listing is not an empty row with a progress bar at zero.
     *
     *      It has to be one transaction rather than a launch followed by a buy,
     *      because between those two the curve is open and its cheapest tokens
     *      are the first ones: whoever is watching the mempool takes the
     *      opening position the creator was paying for.
     *
     *      This holds nothing afterwards. The usdg passes straight through to
     *      the curve within the call, the position is credited to the caller by
     *      `buyFor`, and the approval is spent exactly by the buy that follows
     *      it. Nothing is left approved and no balance survives the call.
     */
    function launchAndBuy(
        BasketRouter.Leg[] calldata legs,
        uint16 creatorFeeBps,
        uint256 threshold,
        string calldata name,
        string calldata symbol,
        string calldata description,
        string calldata image,
        uint256 amountIn,
        uint256 minOut
    ) external returns (BasketCurve curve, uint256 indexId, uint256 out) {
        if (amountIn == 0) revert ZeroAmount();
        (curve, indexId) = launch(legs, creatorFeeBps, threshold, name, symbol, description, image);

        quote.safeTransferFrom(msg.sender, address(this), amountIn);
        // forceApprove rather than approve, for the same reason the curve uses
        // it on the router: usdg is a token whose approve may not return a bool.
        SafeERC20.forceApprove(IERC20(quote), address(curve), amountIn);
        out = curve.buyFor(msg.sender, amountIn, minOut);
    }

    /**
     * A picture link is optional, and when it is there it is a link.
     *
     * @dev Two prefixes and a length, which is all a contract can usefully say
     *      about a url. It cannot fetch it, cannot tell an image from anything
     *      else, and must not pretend otherwise: this rejects the shapes that
     *      are certainly not links, and everything past that is the reader's
     *      judgement. `javascript:` and `data:` are the ones worth naming,
     *      because a site that renders whatever the log says would otherwise be
     *      rendering whatever a stranger typed.
     */
    function _checkImage(string calldata image) private pure {
        bytes calldata b = bytes(image);
        if (b.length == 0) return;
        if (b.length > MAX_IMAGE_BYTES) revert BadImage();

        bytes8 https = bytes8("https://");
        bytes7 ipfs = bytes7("ipfs://");
        if (b.length >= 8 && bytes8(b[:8]) == https) return;
        if (b.length >= 7 && bytes7(b[:7]) == ipfs) return;
        revert BadImage();
    }

    /// The whole list, for a client that would rather not page through `curves`.
    function all() external view returns (address[] memory) {
        return curves;
    }
}
