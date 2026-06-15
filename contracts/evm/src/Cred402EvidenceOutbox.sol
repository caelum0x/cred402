// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";

/// @title Cred402EvidenceOutbox
/// @notice Emits `EvidenceAttested` events for RWA evidence submitted on the EVM
///         satellite, which relayers anchor into the Casper `RWAEvidenceRegistry`.
///
/// Mirrors the Evidence Attestation Envelope (EAE) standard
/// (`crosschain/standards/evidence.ts`): each item carries a UAID, the submitting
/// agent, an evidence type and hashes, a linked receipt id, and a confidence in basis
/// points. The agent's Casper ed25519 signature over the EAE is verified off-chain by
/// the relayer; the outbox records the verified attestation and a keccak commitment.
contract Cred402EvidenceOutbox is Ownable {
    uint16 internal constant MAX_BPS = 10_000;

    struct EvidenceAttestation {
        string uaid; // "uaid:<asset_type>:<64-hex>"
        string agentId; // submitting Cred402 agent id
        string evidenceType; // e.g. "bank_statement", "audit_report"
        bytes32 evidenceHash; // hash of the evidence payload
        bytes32 sourceHash; // hash of the source/provider
        bytes32 linkedReceiptId; // URE receipt id this evidence corroborates (0 if none)
        uint16 confidenceBps; // 0..10000
        uint64 timestamp; // EAE timestamp
        uint64 recordedAt;
        bool exists;
    }

    /// @notice Authorized submitters (operator / agent gateway).
    mapping(address => bool) public submitters;

    /// @dev keccak256(uaid, agentId, evidenceHash) => attestation (dedupe identical evidence).
    mapping(bytes32 => EvidenceAttestation) private _attestations;
    bytes32[] private _attestationKeys;

    event SubmitterSet(address indexed submitter, bool allowed);
    event EvidenceAttested(
        bytes32 indexed attestationKey,
        string uaid,
        string agentId,
        string evidenceType,
        bytes32 evidenceHash,
        bytes32 linkedReceiptId,
        uint16 confidenceBps,
        uint64 timestamp
    );

    error NotSubmitter(address caller);
    error ConfidenceOutOfRange(uint16 confidenceBps);
    error EvidenceExists(bytes32 attestationKey);
    error EmptyUaid();

    constructor(address initialOwner) Ownable(initialOwner) {
        submitters[initialOwner] = true;
        emit SubmitterSet(initialOwner, true);
    }

    modifier onlySubmitter() {
        if (!submitters[msg.sender]) revert NotSubmitter(msg.sender);
        _;
    }

    function setSubmitter(address submitter, bool allowed) external onlyOwner {
        submitters[submitter] = allowed;
        emit SubmitterSet(submitter, allowed);
    }

    function attestationKey(string memory uaid, string memory agentId, bytes32 evidenceHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(uaid, agentId, evidenceHash));
    }

    /// @notice Record a Casper-signed RWA evidence attestation and emit it for relaying.
    function attestEvidence(
        string calldata uaid,
        string calldata agentId,
        string calldata evidenceType,
        bytes32 evidenceHash,
        bytes32 sourceHash,
        bytes32 linkedReceiptId,
        uint16 confidenceBps,
        uint64 timestamp
    ) external onlySubmitter {
        if (bytes(uaid).length == 0) revert EmptyUaid();
        if (confidenceBps > MAX_BPS) revert ConfidenceOutOfRange(confidenceBps);

        bytes32 key = attestationKey(uaid, agentId, evidenceHash);
        if (_attestations[key].exists) revert EvidenceExists(key);

        _attestations[key] = EvidenceAttestation({
            uaid: uaid,
            agentId: agentId,
            evidenceType: evidenceType,
            evidenceHash: evidenceHash,
            sourceHash: sourceHash,
            linkedReceiptId: linkedReceiptId,
            confidenceBps: confidenceBps,
            timestamp: timestamp,
            recordedAt: uint64(block.timestamp),
            exists: true
        });
        _attestationKeys.push(key);

        emit EvidenceAttested(
            key, uaid, agentId, evidenceType, evidenceHash, linkedReceiptId, confidenceBps, timestamp
        );
    }

    function getAttestation(bytes32 key) external view returns (EvidenceAttestation memory) {
        return _attestations[key];
    }

    function attestationCount() external view returns (uint256) {
        return _attestationKeys.length;
    }

    function attestationKeyAt(uint256 index) external view returns (bytes32) {
        return _attestationKeys[index];
    }
}
