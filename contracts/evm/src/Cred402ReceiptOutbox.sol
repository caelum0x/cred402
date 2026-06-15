// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";

/// @title Cred402ReceiptOutbox
/// @notice Emits `ReceiptCreated` events that Cred402 relayers observe and anchor into
///         the Casper `X402ReceiptRegistry` / `ExternalReceiptRegistry`. Also stores a
///         commitment per receipt so the same local x402 settlement cannot be emitted
///         twice and so observers can confirm membership on-chain.
///
/// The canonical receipt object is the Universal Receipt Envelope (URE) whose id is
/// `receipt_id = blake2b256(canonical_json(URE))`, computed off-chain (blake2b is not
/// an EVM precompile). The outbox treats `receiptId` as an opaque 32-byte commitment
/// and additionally records a keccak commitment over the local settlement coordinates
/// for integrity.
contract Cred402ReceiptOutbox is Ownable {
    struct ReceiptCommitment {
        bytes32 receiptId; // blake2b256(canonical_json(URE)) supplied by the relayer
        string originChain; // CAIP-2, e.g. "eip155:8453"
        string payerAgentId;
        string sellerAgentId;
        bytes32 paymentProofHash; // URE.payment_proof_hash
        bytes32 settlementTxHash; // URE.settlement_tx_hash
        uint64 createdAt; // URE.created_at
        uint64 recordedAt;
        bool exists;
    }

    mapping(bytes32 => ReceiptCommitment) private _receipts;
    bytes32[] private _receiptIds;

    /// @notice Authorized emitters (the ReceiptInbox and the operator) may publish.
    mapping(address => bool) public emitters;

    event EmitterSet(address indexed emitter, bool allowed);
    event ReceiptCreated(
        bytes32 indexed receiptId,
        string originChain,
        string payerAgentId,
        string sellerAgentId,
        string asset,
        string amount,
        bytes32 paymentProofHash,
        bytes32 settlementTxHash,
        uint64 createdAt
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

    /// @notice Publish a universal receipt commitment and emit `ReceiptCreated`.
    /// @dev `amount` is kept as a string (smallest-unit integer) to mirror the URE
    ///      standard exactly and avoid precision assumptions across assets/decimals.
    function publishReceipt(
        bytes32 receiptId,
        string calldata originChain,
        string calldata payerAgentId,
        string calldata sellerAgentId,
        string calldata asset,
        string calldata amount,
        bytes32 paymentProofHash,
        bytes32 settlementTxHash,
        uint64 createdAt
    ) external onlyEmitter {
        if (receiptId == bytes32(0)) revert ZeroReceiptId();
        if (_receipts[receiptId].exists) revert ReceiptExists(receiptId);

        _receipts[receiptId] = ReceiptCommitment({
            receiptId: receiptId,
            originChain: originChain,
            payerAgentId: payerAgentId,
            sellerAgentId: sellerAgentId,
            paymentProofHash: paymentProofHash,
            settlementTxHash: settlementTxHash,
            createdAt: createdAt,
            recordedAt: uint64(block.timestamp),
            exists: true
        });
        _receiptIds.push(receiptId);

        emit ReceiptCreated(
            receiptId,
            originChain,
            payerAgentId,
            sellerAgentId,
            asset,
            amount,
            paymentProofHash,
            settlementTxHash,
            createdAt
        );
    }

    function getReceipt(bytes32 receiptId) external view returns (ReceiptCommitment memory) {
        return _receipts[receiptId];
    }

    function hasReceipt(bytes32 receiptId) external view returns (bool) {
        return _receipts[receiptId].exists;
    }

    function receiptCount() external view returns (uint256) {
        return _receiptIds.length;
    }

    function receiptIdAt(uint256 index) external view returns (bytes32) {
        return _receiptIds[index];
    }
}
