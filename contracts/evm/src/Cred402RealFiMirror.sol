// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";

/// @title Cred402RealFiMirror
/// @notice EVM satellite mirror for the Cred402 RealFi Bridge (p6). Lets fiat
///         receipts (Stripe) and operator verifications (Stripe Identity) settle
///         on an EVM chain while their canonical commitments anchor back to the
///         Casper `FiatReceiptRegistry` / `OperatorVerificationRegistry`.
///
/// Privacy rule (p6): NO PII on-chain. Only hashes, provider name, status,
/// agent/operator id, currency, service type and timestamps. The canonical
/// envelope ids are blake2b256(canonical_json(envelope)) computed off-chain
/// (blake2b is not an EVM precompile); this mirror treats them as opaque 32-byte
/// commitments and emits events the Casper-root relayer observes and anchors.
contract Cred402RealFiMirror is Ownable {
    struct FiatReceiptCommitment {
        bytes32 receiptId; // blake2b256(canonical_json(FRE)) from the relayer
        string provider; // "stripe" | "adyen" | ...
        string sellerAgentId; // CAID
        string operatorId;
        string currency; // ISO 4217
        string serviceType;
        bytes32 providerReceiptHash; // FRE.provider_receipt_hash (hashed off-chain)
        uint8 status; // 0 pending, 1 settled, 2 refunded, 3 disputed, 4 finalized
        uint64 recordedAt;
        bool exists;
    }

    struct OperatorCommitment {
        string operatorId;
        string provider; // "stripe_identity" | ...
        uint8 verificationLevel; // 0 unverified .. 3 regulated
        string jurisdiction; // ISO 3166 alpha-2
        uint8 status; // 0 pending, 1 verified, 2 rejected, 3 revoked
        bytes32 attestationHash;
        uint64 expiresAt;
        bool exists;
    }

    mapping(bytes32 => FiatReceiptCommitment) private _receipts;
    bytes32[] private _receiptIds;
    mapping(string => OperatorCommitment) private _operators;

    /// @notice Authorized emitters (the relayer / operator) may publish commitments.
    mapping(address => bool) public emitters;

    event EmitterSet(address indexed emitter, bool allowed);
    event FiatReceiptMirrored(
        bytes32 indexed receiptId,
        string provider,
        string sellerAgentId,
        string operatorId,
        string currency,
        string serviceType,
        bytes32 providerReceiptHash,
        uint8 status
    );
    event OperatorVerificationMirrored(
        string indexed operatorId,
        string provider,
        uint8 verificationLevel,
        string jurisdiction,
        uint8 status,
        bytes32 attestationHash,
        uint64 expiresAt
    );

    error NotEmitter(address caller);
    error ReceiptExists(bytes32 receiptId);
    error ZeroReceiptId();

    constructor(address initialOwner) Ownable(initialOwner) {
        emitters[initialOwner] = true;
        emit EmitterSet(initialOwner, true);
    }

    modifier onlyEmitter() {
        if (!emitters[msg.sender]) revert NotEmitter(msg.sender);
        _;
    }

    function setEmitter(address emitter, bool allowed) external onlyOwner {
        emitters[emitter] = allowed;
        emit EmitterSet(emitter, allowed);
    }

    /// @notice Mirror a Stripe fiat receipt commitment and emit for the relayer.
    function publishFiatReceipt(
        bytes32 receiptId,
        string calldata provider,
        string calldata sellerAgentId,
        string calldata operatorId,
        string calldata currency,
        string calldata serviceType,
        bytes32 providerReceiptHash,
        uint8 status
    ) external onlyEmitter {
        if (receiptId == bytes32(0)) revert ZeroReceiptId();
        if (_receipts[receiptId].exists) revert ReceiptExists(receiptId);

        _receipts[receiptId] = FiatReceiptCommitment({
            receiptId: receiptId,
            provider: provider,
            sellerAgentId: sellerAgentId,
            operatorId: operatorId,
            currency: currency,
            serviceType: serviceType,
            providerReceiptHash: providerReceiptHash,
            status: status,
            recordedAt: uint64(block.timestamp),
            exists: true
        });
        _receiptIds.push(receiptId);

        emit FiatReceiptMirrored(
            receiptId, provider, sellerAgentId, operatorId, currency, serviceType, providerReceiptHash, status
        );
    }

    /// @notice Mirror an operator verification commitment (idempotent overwrite by id).
    function publishOperatorVerification(
        string calldata operatorId,
        string calldata provider,
        uint8 verificationLevel,
        string calldata jurisdiction,
        uint8 status,
        bytes32 attestationHash,
        uint64 expiresAt
    ) external onlyEmitter {
        _operators[operatorId] = OperatorCommitment({
            operatorId: operatorId,
            provider: provider,
            verificationLevel: verificationLevel,
            jurisdiction: jurisdiction,
            status: status,
            attestationHash: attestationHash,
            expiresAt: expiresAt,
            exists: true
        });
        emit OperatorVerificationMirrored(
            operatorId, provider, verificationLevel, jurisdiction, status, attestationHash, expiresAt
        );
    }

    function getFiatReceipt(bytes32 receiptId) external view returns (FiatReceiptCommitment memory) {
        return _receipts[receiptId];
    }

    function hasFiatReceipt(bytes32 receiptId) external view returns (bool) {
        return _receipts[receiptId].exists;
    }

    function fiatReceiptCount() external view returns (uint256) {
        return _receiptIds.length;
    }

    function getOperatorVerification(string calldata operatorId) external view returns (OperatorCommitment memory) {
        return _operators[operatorId];
    }

    /// @notice Is the operator currently verified (status == 1 and not expired)?
    function isOperatorVerified(string calldata operatorId) external view returns (bool) {
        OperatorCommitment storage o = _operators[operatorId];
        return o.exists && o.status == 1 && o.expiresAt > block.timestamp;
    }
}
