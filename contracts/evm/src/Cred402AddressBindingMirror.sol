// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";

/// @title Cred402AddressBindingMirror
/// @notice Stores Casper-verified Address Binding Envelopes (ABE) on the EVM side and
///         emits `BindingMirrored`. An ABE binds an external (EVM) address to a
///         Casper-rooted agent and is dual-signed off-chain: Casper ed25519 + external
///         secp256k1. Both signatures are verified by the relayer against the canonical
///         standard (`crosschain/standards/bindings.ts`) before mirroring here, so this
///         contract records the *verified* binding rather than re-verifying both curves
///         on-chain.
///
/// Mirroring lets EVM contracts answer: "is this EVM address an authorized address for
/// agent X?" — used when an agent's wallet draws credit or settles x402 locally.
contract Cred402AddressBindingMirror is Ownable {
    struct Binding {
        string agentId; // Cred402 agent id (CAID root)
        bytes32 casperAccount; // 32-byte ed25519 public key bytes
        string externalChain; // CAIP-2, e.g. "eip155:8453"
        address externalAddress; // bound EVM address
        bytes32 nonce; // ABE nonce
        uint64 expiresAt; // ABE expiry (unix seconds)
        uint64 mirroredAt;
        bool exists;
    }

    /// @dev Keyed by the bound EVM address (one active binding per address).
    mapping(address => Binding) private _bindingByAddress;
    /// @dev Reverse lookup: agentId => bound address.
    mapping(string => address) private _addressByAgent;

    event BindingMirrored(
        string indexed agentId,
        address indexed externalAddress,
        bytes32 casperAccount,
        string externalChain,
        bytes32 nonce,
        uint64 expiresAt
    );
    event BindingRevoked(string indexed agentId, address indexed externalAddress);

    error ZeroAddress();
    error EmptyAgentId();
    error UnknownBinding(address externalAddress);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Mirror a Casper-verified, dual-signed binding. Idempotent re-mirroring
    ///         (e.g. a renewed ABE with a later expiry) overwrites the prior record.
    function mirrorBinding(
        string calldata agentId,
        bytes32 casperAccount,
        string calldata externalChain,
        address externalAddress,
        bytes32 nonce,
        uint64 expiresAt
    ) external onlyOwner {
        if (externalAddress == address(0)) revert ZeroAddress();
        if (bytes(agentId).length == 0) revert EmptyAgentId();

        // If this address previously mapped to a different agent, drop the stale reverse link.
        Binding storage prev = _bindingByAddress[externalAddress];
        if (prev.exists && keccak256(bytes(prev.agentId)) != keccak256(bytes(agentId))) {
            delete _addressByAgent[prev.agentId];
        }

        _bindingByAddress[externalAddress] = Binding({
            agentId: agentId,
            casperAccount: casperAccount,
            externalChain: externalChain,
            externalAddress: externalAddress,
            nonce: nonce,
            expiresAt: expiresAt,
            mirroredAt: uint64(block.timestamp),
            exists: true
        });
        _addressByAgent[agentId] = externalAddress;

        emit BindingMirrored(agentId, externalAddress, casperAccount, externalChain, nonce, expiresAt);
    }

    /// @notice Revoke a mirrored binding (e.g. Casper-side unbind or rotation).
    function revokeBinding(address externalAddress) external onlyOwner {
        Binding storage b = _bindingByAddress[externalAddress];
        if (!b.exists) revert UnknownBinding(externalAddress);
        string memory agentId = b.agentId;
        delete _addressByAgent[agentId];
        delete _bindingByAddress[externalAddress];
        emit BindingRevoked(agentId, externalAddress);
    }

    function getBinding(address externalAddress) external view returns (Binding memory) {
        Binding memory b = _bindingByAddress[externalAddress];
        if (!b.exists) revert UnknownBinding(externalAddress);
        return b;
    }

    function boundAddressOf(string calldata agentId) external view returns (address) {
        return _addressByAgent[agentId];
    }

    /// @notice True if `externalAddress` is currently a valid (unexpired) binding for `agentId`.
    function isBound(string calldata agentId, address externalAddress) external view returns (bool) {
        Binding storage b = _bindingByAddress[externalAddress];
        return b.exists && block.timestamp <= b.expiresAt
            && keccak256(bytes(b.agentId)) == keccak256(bytes(agentId));
    }
}
