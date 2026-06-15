// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";

/// @title Cred402SatelliteRegistry
/// @notice Mirrors Casper-rooted agents onto the EVM satellite. The canonical agent
///         identity is the CAID `cred402:casper:<agent_id>` minted on Casper; this
///         registry records which agents are recognized locally and their status.
///
/// The registrar (owner, typically the Cred402 relayer/operator) writes mirrored
/// state after observing Casper `AgentRegistry` events. EVM contracts (e.g. the
/// credit vault) can consult `isActive` before executing.
contract Cred402SatelliteRegistry is Ownable {
    /// @notice Mirrored satellite agent record.
    struct SatelliteAgent {
        string caid; // "cred402:casper:<agent_id>"
        bytes32 casperAccount; // 32-byte ed25519 public key bytes (after the 01 prefix)
        uint64 mirroredAt; // block timestamp when last mirrored from Casper
        bool active; // false when frozen/slashed on Casper
        bool exists;
    }

    /// @dev Keyed by the Cred402 agent id (the `<agent_id>` portion of the CAID).
    mapping(string => SatelliteAgent) private _agents;
    uint256 private _agentCount;

    event AgentMirrored(string indexed agentId, string caid, bytes32 casperAccount, uint64 mirroredAt);
    event AgentStatusChanged(string indexed agentId, bool active);

    error AgentExists(string agentId);
    error UnknownAgent(string agentId);
    error EmptyAgentId();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Register (mirror) a Casper agent locally. CAID is rooted on Casper.
    function mirrorAgent(string calldata agentId, string calldata caid, bytes32 casperAccount) external onlyOwner {
        if (bytes(agentId).length == 0) revert EmptyAgentId();
        if (_agents[agentId].exists) revert AgentExists(agentId);

        uint64 ts = uint64(block.timestamp);
        _agents[agentId] = SatelliteAgent({
            caid: caid,
            casperAccount: casperAccount,
            mirroredAt: ts,
            active: true,
            exists: true
        });
        unchecked {
            _agentCount += 1;
        }
        emit AgentMirrored(agentId, caid, casperAccount, ts);
    }

    /// @notice Flip an agent active/frozen, reflecting Casper exposure freeze or slash.
    function setAgentActive(string calldata agentId, bool active) external onlyOwner {
        SatelliteAgent storage a = _agents[agentId];
        if (!a.exists) revert UnknownAgent(agentId);
        a.active = active;
        emit AgentStatusChanged(agentId, active);
    }

    function getAgent(string calldata agentId) external view returns (SatelliteAgent memory) {
        SatelliteAgent memory a = _agents[agentId];
        if (!a.exists) revert UnknownAgent(agentId);
        return a;
    }

    function isRegistered(string calldata agentId) external view returns (bool) {
        return _agents[agentId].exists;
    }

    function isActive(string calldata agentId) external view returns (bool) {
        SatelliteAgent storage a = _agents[agentId];
        return a.exists && a.active;
    }

    function casperAccountOf(string calldata agentId) external view returns (bytes32) {
        SatelliteAgent storage a = _agents[agentId];
        if (!a.exists) revert UnknownAgent(agentId);
        return a.casperAccount;
    }

    function agentCount() external view returns (uint256) {
        return _agentCount;
    }
}
