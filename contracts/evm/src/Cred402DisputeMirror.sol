// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";

/// @title Cred402DisputeMirror
/// @notice Mirrors Casper `DisputeCourt` status onto the EVM satellite. Disputes are
///         opened, escalated, and resolved on Casper (the canonical dispute layer);
///         this contract reflects the outcome locally so EVM contracts and front-ends
///         can react (e.g. freeze a receipt, mark an RWA disputed, or block a draw tied
///         to a contested receipt).
///
/// The dispute id and subject id are kept as their canonical strings from Casper; a
/// keccak digest of the dispute id is the on-chain map key.
contract Cred402DisputeMirror is Ownable {
    enum DisputeStatus {
        None, // 0 - never mirrored
        Open, // 1 - opened on Casper
        Appealed, // 2 - under appeal
        ResolvedUpheld, // 3 - claim upheld (subject penalized)
        ResolvedRejected // 4 - claim rejected (subject cleared)
    }

    enum SubjectKind {
        Receipt, // 0 - a URE receipt_id
        Evidence, // 1 - an EAE evidence item
        Agent, // 2 - an agent id
        Asset // 3 - a UAID asset
    }

    struct Dispute {
        string disputeId; // canonical Casper dispute id
        SubjectKind subjectKind; // what is being disputed
        string subjectId; // receipt_id / evidence id / agent_id / uaid
        string complainantAgentId; // who opened it
        DisputeStatus status;
        uint64 openedAt;
        uint64 updatedAt;
        bool exists;
    }

    /// @dev keccak256(disputeId) => dispute.
    mapping(bytes32 => Dispute) private _disputes;
    bytes32[] private _disputeKeys;

    event DisputeMirrored(
        bytes32 indexed disputeKey,
        string disputeId,
        SubjectKind subjectKind,
        string subjectId,
        string complainantAgentId,
        DisputeStatus status
    );
    event DisputeStatusChanged(bytes32 indexed disputeKey, DisputeStatus status);

    error EmptyDisputeId();
    error UnknownDispute(bytes32 disputeKey);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function disputeKey(string memory disputeId) public pure returns (bytes32) {
        return keccak256(bytes(disputeId));
    }

    /// @notice Mirror a newly opened (or re-synced) dispute from Casper.
    function mirrorDispute(
        string calldata disputeId,
        SubjectKind subjectKind,
        string calldata subjectId,
        string calldata complainantAgentId,
        DisputeStatus status
    ) external onlyOwner {
        if (bytes(disputeId).length == 0) revert EmptyDisputeId();
        bytes32 key = disputeKey(disputeId);

        bool existed = _disputes[key].exists;
        uint64 openedAt = existed ? _disputes[key].openedAt : uint64(block.timestamp);

        _disputes[key] = Dispute({
            disputeId: disputeId,
            subjectKind: subjectKind,
            subjectId: subjectId,
            complainantAgentId: complainantAgentId,
            status: status,
            openedAt: openedAt,
            updatedAt: uint64(block.timestamp),
            exists: true
        });
        if (!existed) {
            _disputeKeys.push(key);
        }
        emit DisputeMirrored(key, disputeId, subjectKind, subjectId, complainantAgentId, status);
    }

    /// @notice Update the mirrored status of an existing dispute (appeal/resolution).
    function setStatus(string calldata disputeId, DisputeStatus status) external onlyOwner {
        bytes32 key = disputeKey(disputeId);
        Dispute storage d = _disputes[key];
        if (!d.exists) revert UnknownDispute(key);
        d.status = status;
        d.updatedAt = uint64(block.timestamp);
        emit DisputeStatusChanged(key, status);
    }

    function getDispute(string calldata disputeId) external view returns (Dispute memory) {
        bytes32 key = disputeKey(disputeId);
        Dispute memory d = _disputes[key];
        if (!d.exists) revert UnknownDispute(key);
        return d;
    }

    /// @notice True while a dispute is open or appealed (i.e. not yet resolved).
    function isActive(string calldata disputeId) external view returns (bool) {
        Dispute storage d = _disputes[disputeKey(disputeId)];
        return d.exists && (d.status == DisputeStatus.Open || d.status == DisputeStatus.Appealed);
    }

    function disputeCount() external view returns (uint256) {
        return _disputeKeys.length;
    }

    function disputeKeyAt(uint256 index) external view returns (bytes32) {
        return _disputeKeys[index];
    }
}
