// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IFtsoV2
/// @notice Minimal interface to Flare's enshrined FTSOv2 price oracle.
///
/// FTSO (Flare Time Series Oracle) is Flare's decentralized, block-latency price
/// oracle, secured by ~100 independent data providers. Cred402's Flare satellite uses
/// it as the canonical collateral-pricing oracle: when an agent draws credit
/// denominated in the FAsset FXRP, the vault values the draw in USD from the live
/// FTSO XRP/USD feed — no third-party price API, no mock on-chain.
///
/// FTSOv2 is an enshrined system contract. Its address is NOT hardcoded here; it is
/// resolved at runtime from the well-known FlareContractRegistry (see
/// `IFlareContractRegistry`). This is the pattern Flare's own guides use, and it keeps
/// the vault correct across Flare / Songbird / Coston2 / Coston and across upgrades.
///
/// A feed id is a 21-byte value: a category byte (`0x01` = crypto) followed by the
/// ASCII of the feed name, right-padded to 21 bytes. e.g. "XRP/USD" encodes to
/// `0x015852502f55534400000000000000000000000000`.
///
/// Docs: https://dev.flare.network/ftso/overview
interface IFtsoV2 {
    /// @notice Read the current value of a single feed by its 21-byte id.
    /// @param _feedId The 21-byte feed id (category byte + ASCII feed name, right-padded).
    /// @return _value The feed value as an unsigned integer, scaled by `_decimals`.
    /// @return _decimals The number of decimal places `_value` is scaled by (may be
    ///                   negative for very large values).
    /// @return _timestamp The unix timestamp (seconds) of the underlying voting round.
    function getFeedById(bytes21 _feedId)
        external
        view
        returns (uint256 _value, int8 _decimals, uint64 _timestamp);

    /// @notice Read the current values of several feeds at once.
    /// @param _feedIds The 21-byte feed ids to read.
    /// @return _values Per-feed values, each scaled by the matching entry in `_decimals`.
    /// @return _decimals Per-feed decimal scales.
    /// @return _timestamp The unix timestamp (seconds) shared by the returned values.
    function getFeedsById(bytes21[] calldata _feedIds)
        external
        view
        returns (uint256[] memory _values, int8[] memory _decimals, uint64 _timestamp);
}
