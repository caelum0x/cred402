// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Ownable
/// @notice Minimal single-owner access control. Kept local so this Foundry project
///         needs no external import paths (no OpenZeppelin assumed).
abstract contract Ownable {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner(address caller);
    error ZeroOwner();

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroOwner();
        _owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert NotOwner(msg.sender);
        _;
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroOwner();
        address previous = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }
}

/// @title Cred402EmergencyPause
/// @notice Ownable pause guard used by the credit vault (and other satellite
///         contracts that opt in). When paused, gated operations revert.
///
/// This is intentionally a standalone guard rather than a mixin so that a single
/// guard instance can pause an entire satellite suite at once if an operator detects
/// a Casper-side incident (e.g. a frozen agent or a disputed exposure report).
contract Cred402EmergencyPause is Ownable {
    bool private _paused;

    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error EnforcedPause();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice True while the suite is paused.
    function paused() external view returns (bool) {
        return _paused;
    }

    /// @notice Reverts when paused; called by dependent contracts before sensitive ops.
    function requireNotPaused() external view {
        if (_paused) revert EnforcedPause();
    }

    function pause() external onlyOwner {
        _paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        _paused = false;
        emit Unpaused(msg.sender);
    }
}
