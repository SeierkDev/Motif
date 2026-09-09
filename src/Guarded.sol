// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title Guarded
 * @notice A kill switch and a size cap, and deliberately nothing else.
 *
 * @dev **What a guardian can do.** Stop the machinery, and bound how much can
 *      move through it in one call. That is the whole surface.
 *
 *      **What a guardian cannot do.** Move anyone's tokens, take a fee, change
 *      an index, change a price feed, or take a position. Every contract here
 *      is non custodial, so there is nothing held for a guardian to reach.
 *      Pausing costs a user nothing: their tokens never left their own wallet,
 *      and they can still revoke the allowance themselves at any time.
 *
 *      **Why it exists anyway.** These contracts are unaudited and they hold
 *      standing allowances. If a bug turns up, the fastest thing that helps
 *      everyone at once is to stop keepers executing against those allowances
 *      while people revoke at their own pace. Waiting for every user to notice
 *      is not a plan.
 *
 *      **How it goes away.** `renounceGuardian` sets the guardian to the zero
 *      address permanently, which removes the pause, the cap and the guardian
 *      itself. It is one way and it is meant to be used once the contracts have
 *      earned it. A kill switch nobody ever gives up is just an admin key.
 */
abstract contract Guarded {
    address public guardian;
    bool public paused;

    /**
     * The most value one call may move, in the input currency's own decimals.
     * Zero means no cap.
     *
     * This is the honest version of a "deposit cap" for a protocol that takes
     * no deposits. Nothing is pooled here, so there is no total to limit. What
     * can actually be lost to a bug is whatever one transaction can pull from
     * an allowance, so that is what gets bounded.
     */
    uint256 public maxNotional;

    event PausedSet(bool paused);
    event GuardianSet(address indexed guardian);
    event MaxNotionalSet(uint256 amount);

    error NotGuardian();
    error ContractPaused();
    error OverCap(uint256 amount, uint256 cap);
    error UseRenounce();

    constructor(address _guardian, uint256 _maxNotional) {
        guardian = _guardian;
        maxNotional = _maxNotional;
        emit GuardianSet(_guardian);
        emit MaxNotionalSet(_maxNotional);
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian || guardian == address(0)) revert NotGuardian();
        _;
    }

    modifier whenLive() {
        if (paused) revert ContractPaused();
        _;
    }

    function _underCap(uint256 amount) internal view {
        if (maxNotional != 0 && amount > maxNotional) revert OverCap(amount, maxNotional);
    }

    function pause() external onlyGuardian {
        paused = true;
        emit PausedSet(true);
    }

    function unpause() external onlyGuardian {
        paused = false;
        emit PausedSet(false);
    }

    function setMaxNotional(uint256 amount) external onlyGuardian {
        maxNotional = amount;
        emit MaxNotionalSet(amount);
    }

    /**
     * @dev Refuses the zero address. Handing the guardian to nobody while the
     *      contract is paused would brick it permanently with no way back, and
     *      the deliberate version of that is `renounceGuardian`, which unpauses
     *      on its way out.
     */
    function transferGuardian(address to) external onlyGuardian {
        if (to == address(0)) revert UseRenounce();
        guardian = to;
        emit GuardianSet(to);
    }

    /**
     * @notice Give up the guardian, the pause and the cap, permanently.
     * @dev One way on purpose. There is no path back, because a switch that can
     *      be handed back to somebody is not a renunciation.
     */
    function renounceGuardian() external onlyGuardian {
        guardian = address(0);
        paused = false;
        maxNotional = 0;
        emit GuardianSet(address(0));
        emit PausedSet(false);
        emit MaxNotionalSet(0);
    }
}
