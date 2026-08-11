// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IFlareContractRegistry
/// @notice Minimal interface to the FlareContractRegistry — Flare's on-chain directory
///         of enshrined system contracts.
///
/// The registry lives at the SAME address on every Flare-family network:
/// `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` (Flare, Songbird, Coston2, Coston).
/// Every enshrined contract (FtsoV2, FdcHub, FdcVerification, the FXRP AssetManager…)
/// is resolved through it by name, so addresses are never hardcoded and stay correct
/// across upgrades — the pattern Flare's own Solidity reference uses.
///
/// Docs: https://dev.flare.network/network/solidity-reference
interface IFlareContractRegistry {
    /// @notice Resolve an enshrined contract's current address by its registered name.
    /// @param _name The registered contract name, e.g. "FtsoV2".
    /// @return The current address of that contract, or the zero address if unknown.
    function getContractAddressByName(string calldata _name) external view returns (address);
}
