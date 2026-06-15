// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";

/// @title Cred402RWAMirror
/// @notice UAID-keyed mirror of Real-World-Asset wrappers tracked on Casper. The
///         canonical asset identity is the Universal Asset ID
///         `uaid:<asset_type>:<blake2b256(...)>` minted on Casper; this contract
///         mirrors the asset's status, valuation, and optional local ERC-wrapper
///         address so EVM credit vaults and RWA wrappers can reference a global asset.
///
/// UAID is stored as its raw string so off-chain systems can compare it byte-for-byte
/// against `crosschain/standards/identity.ts`; a keccak digest of the UAID string is
/// used as the on-chain map key.
contract Cred402RWAMirror is Ownable {
    enum AssetStatus {
        Unknown, // 0 - never mirrored
        Active, // 1 - valid, evidence in good standing
        Disputed, // 2 - under dispute on Casper
        Frozen // 3 - frozen/slashed on Casper
    }

    struct RWAAsset {
        string uaid; // "uaid:<asset_type>:<64-hex>"
        string assetType; // e.g. "invoice", "treasury_bill"
        string jurisdiction; // e.g. "US", "EU"
        bytes32 documentBundleHash; // blake2b/keccak of the document bundle
        address localWrapper; // optional ERC20/ERC721 wrapper on this chain (0 if none)
        uint256 valuation; // smallest-unit USD micro valuation (6dp, == USDC base units)
        AssetStatus status;
        uint64 mirroredAt;
        bool exists;
    }

    /// @dev keccak256(uaid string) => asset.
    mapping(bytes32 => RWAAsset) private _assets;
    bytes32[] private _assetKeys;

    event RWAMirrored(
        bytes32 indexed uaidKey,
        string uaid,
        string assetType,
        string jurisdiction,
        address localWrapper,
        uint256 valuation
    );
    event RWAStatusChanged(bytes32 indexed uaidKey, AssetStatus status);
    event RWAValuationChanged(bytes32 indexed uaidKey, uint256 valuation);

    error EmptyUaid();
    error UnknownAsset(bytes32 uaidKey);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function uaidKey(string memory uaid) public pure returns (bytes32) {
        return keccak256(bytes(uaid));
    }

    /// @notice Mirror (or re-mirror) an RWA from Casper. Re-mirroring updates mutable
    ///         fields (wrapper, valuation) while preserving the immutable identity.
    function mirrorAsset(
        string calldata uaid,
        string calldata assetType,
        string calldata jurisdiction,
        bytes32 documentBundleHash,
        address localWrapper,
        uint256 valuation
    ) external onlyOwner {
        if (bytes(uaid).length == 0) revert EmptyUaid();
        bytes32 key = uaidKey(uaid);

        bool existed = _assets[key].exists;
        AssetStatus status = existed ? _assets[key].status : AssetStatus.Active;

        _assets[key] = RWAAsset({
            uaid: uaid,
            assetType: assetType,
            jurisdiction: jurisdiction,
            documentBundleHash: documentBundleHash,
            localWrapper: localWrapper,
            valuation: valuation,
            status: status,
            mirroredAt: uint64(block.timestamp),
            exists: true
        });
        if (!existed) {
            _assetKeys.push(key);
        }
        emit RWAMirrored(key, uaid, assetType, jurisdiction, localWrapper, valuation);
    }

    function setStatus(string calldata uaid, AssetStatus status) external onlyOwner {
        bytes32 key = uaidKey(uaid);
        RWAAsset storage a = _assets[key];
        if (!a.exists) revert UnknownAsset(key);
        a.status = status;
        emit RWAStatusChanged(key, status);
    }

    function setValuation(string calldata uaid, uint256 valuation) external onlyOwner {
        bytes32 key = uaidKey(uaid);
        RWAAsset storage a = _assets[key];
        if (!a.exists) revert UnknownAsset(key);
        a.valuation = valuation;
        emit RWAValuationChanged(key, valuation);
    }

    function getAsset(string calldata uaid) external view returns (RWAAsset memory) {
        bytes32 key = uaidKey(uaid);
        RWAAsset memory a = _assets[key];
        if (!a.exists) revert UnknownAsset(key);
        return a;
    }

    function getAssetByKey(bytes32 key) external view returns (RWAAsset memory) {
        RWAAsset memory a = _assets[key];
        if (!a.exists) revert UnknownAsset(key);
        return a;
    }

    function isActive(string calldata uaid) external view returns (bool) {
        RWAAsset storage a = _assets[uaidKey(uaid)];
        return a.exists && a.status == AssetStatus.Active;
    }

    function assetCount() external view returns (uint256) {
        return _assetKeys.length;
    }

    function assetKeyAt(uint256 index) external view returns (bytes32) {
        return _assetKeys[index];
    }
}
