// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";
import {Cred402ReceiptOutbox} from "./Cred402ReceiptOutbox.sol";

/// @title Cred402ReceiptInbox
/// @notice Accepts local x402 settlement confirmations on the EVM satellite and
///         forwards them into the `Cred402ReceiptOutbox`, which emits the
///         `ReceiptCreated` event that relayers anchor on Casper.
///
/// "Accept local x402 settlement -> emit receipt events" (EVM responsibility #1 and #2
/// from p3). A settler (a facilitator contract, paymaster, or the operator) submits the
/// already-formed Universal Receipt Envelope coordinates after a successful x402
/// payment; the inbox dedupes the local settlement tx and hands off to the outbox.
contract Cred402ReceiptInbox is Ownable {
    Cred402ReceiptOutbox public immutable outbox;

    /// @notice Addresses allowed to submit settled receipts (facilitators / operator).
    mapping(address => bool) public settlers;

    /// @dev Dedupe by the local settlement tx hash so one settlement => one receipt.
    mapping(bytes32 => bool) public settledTx;

    event SettlerSet(address indexed settler, bool allowed);
    event SettlementAccepted(bytes32 indexed receiptId, bytes32 indexed settlementTxHash, address indexed settler);

    error NotSettler(address caller);
    error AlreadySettled(bytes32 settlementTxHash);

    constructor(address initialOwner, Cred402ReceiptOutbox outbox_) Ownable(initialOwner) {
        outbox = outbox_;
        settlers[initialOwner] = true;
        emit SettlerSet(initialOwner, true);
    }

    modifier onlySettler() {
        if (!settlers[msg.sender]) revert NotSettler(msg.sender);
        _;
    }

    function setSettler(address settler, bool allowed) external onlyOwner {
        settlers[settler] = allowed;
        emit SettlerSet(settler, allowed);
    }

    /// @notice Accept a settled local x402 payment and forward it to the outbox.
    /// @dev The inbox must be an authorized emitter on the outbox (wired at deploy time).
    function acceptSettlement(
        bytes32 receiptId,
        string calldata originChain,
        string calldata payerAgentId,
        string calldata sellerAgentId,
        string calldata asset,
        string calldata amount,
        bytes32 paymentProofHash,
        bytes32 settlementTxHash,
        uint64 createdAt
    ) external onlySettler {
        if (settledTx[settlementTxHash]) revert AlreadySettled(settlementTxHash);
        settledTx[settlementTxHash] = true;

        outbox.publishReceipt(
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

        emit SettlementAccepted(receiptId, settlementTxHash, msg.sender);
    }
}
