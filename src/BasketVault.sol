// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeTransfer} from "./BasketRouter.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/**
 * @title BasketVault
 * @notice A token whose holders own the basket behind it, and can always take
 *         their share of it back.
 *
 * @dev **Why this exists at all**, given that the rest of this repo is built so
 *      that no contract ever holds anything. `docs/04-tokenised-baskets.md` has
 *      the argument in full; the short version is that the pass through
 *      launchpad gives a buyer no reason to be there. They spend a hundred
 *      dollars, receive a hundred dollars of stock less fees, and are strictly
 *      worse off than buying the legs themselves. Convenience is not a motive.
 *
 *      This is custody, and it is taken on deliberately rather than by
 *      accident. What pays for it is the guarantee below.
 *
 *      **The guarantee, stated exactly: nobody can take the backing.** Not the
 *      creator, not a guardian, not whoever deployed this. It is enforced by
 *      the shape of the contract rather than by a promise:
 *
 *      - `redeem` is unconditional and permissionless. Any holder, any amount,
 *        any time. There is no pause on it, no allowlist, no admin gate, and no
 *        fee taken on the way out.
 *      - **There is no other function that moves an asset out of here.** Not a
 *        sweep, not a rescue, not an owner withdrawal. Look for one; the
 *        absence is the design.
 *      - There is no owner, no admin, no upgrade path, and nothing to
 *        initialise later.
 *      - `minter` can mint exactly once and then can do nothing at all, ever.
 *
 *      **What this does not claim.** The stocks can fall. A leg can turn
 *      illiquid. The token can trade at a premium that evaporates. Those are
 *      market risks and the copy must never blur them into the custody
 *      guarantee, which is narrow on purpose: the backing is unreachable, and
 *      that is a different sentence from "you cannot lose money".
 *
 *      **The floor.** Because redemption is always open, a holder who can buy
 *      the token for less than the underlying is worth can buy it, burn it,
 *      take the legs, and keep the difference. That arbitrage is what stops the
 *      price sitting below the backing, and it is the only reason this design
 *      beats a launchpad whose floor is zero. It is a property to be measured
 *      rather than asserted: see `test/Floor.t.sol`, which fails if it ever
 *      stops holding against the real pools.
 */
contract BasketVault is ERC20, ReentrancyGuardTransient {
    using SafeTransfer for address;

    /**
     * The tokens this basket holds. Immutable in effect: written once in the
     * constructor and never appended to, so the set a holder redeems against is
     * the set they bought into.
     */
    address[] private _legs;

    /**
     * The only address that may ever mint, and only once. In production this is
     * the curve that raised the money and bought the legs. After `graduate` it
     * has no powers of any kind, which is why there is no way to change it.
     */
    address public immutable minter;

    bool public graduated;

    /**
     * Whether the curve has already burned the leftover of its one mint.
     *
     * @dev One burn, once, and only the minter's own balance. See `burnUnused`.
     */
    bool public settled;

    event Graduated(address indexed to, uint256 supply);
    event Redeemed(address indexed holder, uint256 amount, uint256 supplyBefore);

    error NotMinter();
    error AlreadyGraduated();
    error NotGraduated();
    error NoLegs();
    error ZeroAmount();
    error DuplicateLeg(address token);
    error AlreadySettled();

    constructor(string memory name_, string memory symbol_, address[] memory legs_, address minter_)
        ERC20(name_, symbol_)
    {
        if (legs_.length == 0) revert NoLegs();
        // A leg listed twice would be paid twice out of one balance on every
        // redemption, so a holder redeeming a share `s` of the supply would
        // take `s * (2 - s)` of that token and the vault would go insolvent in
        // it long before the last holder redeemed. The router permits an index
        // with the same token at two weights, because to it they are just two
        // swaps; here they are not expressible, and the same basket is always
        // writable as one leg at the summed weight. n is small and this runs
        // once, so the quadratic scan is the cheapest honest answer.
        for (uint256 i; i < legs_.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (legs_[i] == legs_[j]) revert DuplicateLeg(legs_[i]);
            }
        }
        _legs = legs_;
        minter = minter_;
    }

    function legs() external view returns (address[] memory) {
        return _legs;
    }

    function legCount() external view returns (uint256) {
        return _legs.length;
    }

    /**
     * Mint the whole supply, once.
     *
     * @dev Called by the curve in the same transaction that bought the legs and
     *      sent them here, so there is never a moment where supply exists
     *      against an empty vault. Nothing checks that the legs arrived, on
     *      purpose: this contract cannot know what the raise was supposed to
     *      buy, and a check it can only fake is worse than an honest absence.
     *      That is the curve's job and the graduation test's job.
     */
    function graduate(address to, uint256 supply) external {
        if (msg.sender != minter) revert NotMinter();
        if (graduated) revert AlreadyGraduated();
        if (supply == 0) revert ZeroAmount();
        graduated = true;
        _mint(to, supply);
        emit Graduated(to, supply);
    }

    /**
     * Burn supply the curve minted for graduation and did not use.
     *
     * @dev Graduation mints in one shot, before it knows how much of the mint a
     *      corrective pool swap will consume, because the vault permits exactly
     *      one mint and the amount has to be decided before the swap runs. The
     *      unspent remainder would otherwise sit on the curve forever as supply
     *      with a claim on the backing that nobody can exercise, which is
     *      dilution of every real holder. This is how it goes away.
     *
     *      It is not a power. `_burn` takes from `msg.sender`, so the minter can
     *      only ever destroy its own balance, and destroying a balance gives up
     *      a claim on the vault rather than taking one: every remaining holder
     *      is worth strictly more afterwards. It is one shot as well, so the
     *      curve cannot come back later and burn tokens its buyers have not yet
     *      claimed.
     */
    function burnUnused(uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        if (!graduated) revert NotGraduated();
        if (settled) revert AlreadySettled();
        settled = true;
        if (amount != 0) _burn(msg.sender, amount);
    }

    /**
     * Burn `amount` and take that share of every leg.
     *
     * @dev The share is computed against the supply **before** the burn. Taking
     *      it after would divide by a supply the burn had already shrunk and
     *      pay out more than the holder owns, which drains the vault for
     *      everyone behind them. This is the whole arithmetic of the contract
     *      and it is one line, so it is worth reading twice.
     *
     *      Division floors, so dust stays behind rather than being owed to
     *      somebody. That direction is deliberate: rounding in favour of the
     *      remaining holders can never make the vault insolvent, and rounding
     *      the other way eventually does.
     *
     *      Reentrancy guarded because leg tokens are arbitrary ERC20s handed in
     *      by whoever created the basket. A leg with a transfer hook could
     *      otherwise reenter between two of these transfers, when supply has
     *      been burned but the remaining legs have not yet been paid out.
     */
    function redeem(uint256 amount) external nonReentrant {
        if (!graduated) revert NotGraduated();
        if (amount == 0) revert ZeroAmount();

        uint256 supplyBefore = totalSupply();
        _burn(msg.sender, amount);

        uint256 n = _legs.length;
        for (uint256 i; i < n; ++i) {
            address leg = _legs[i];
            uint256 held = IERC20(leg).balanceOf(address(this));
            uint256 out = (held * amount) / supplyBefore;
            if (out != 0) leg.safeTransfer(msg.sender, out);
        }

        emit Redeemed(msg.sender, amount, supplyBefore);
    }

    /**
     * What one unit of supply is backed by right now, per leg.
     *
     * @dev A view for the site and for tests, not something the contract acts
     *      on. It is deliberately not a price: converting these to one currency
     *      needs an oracle, and the reasons this codebase settles nothing
     *      against an oracle have not changed.
     */
    function backingOf(uint256 amount) external view returns (address[] memory tokens, uint256[] memory amounts) {
        uint256 supply = totalSupply();
        uint256 n = _legs.length;
        tokens = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            tokens[i] = _legs[i];
            amounts[i] = supply == 0 ? 0 : (IERC20(_legs[i]).balanceOf(address(this)) * amount) / supply;
        }
    }
}
