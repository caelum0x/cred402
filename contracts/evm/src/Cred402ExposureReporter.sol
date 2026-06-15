// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";

/// @title Cred402ExposureReporter
/// @notice Emits `ExposureChanged` events that Cred402 relayers carry back to the
///         Casper `GlobalExposureManager`. Every credit draw or repayment on this EVM
///         satellite changes the agent's local debt; Casper aggregates those reports
///         across all chains to prevent the multi-chain over-borrow failure mode.
///
/// The reporter keeps the satellite's view of per-agent local debt so the event always
/// carries the authoritative local `newLocalDebt` alongside the signed delta. Only
/// authorized reporters (the credit vault) may push reports.
contract Cred402ExposureReporter is Ownable {
    enum ExposureAction {
        Draw, // 0 - agent drew credit (debt increased)
        Repay // 1 - agent repaid credit (debt decreased)
    }

    /// @notice Authorized reporters (the credit vault). Owner manages the set.
    mapping(address => bool) public reporters;

    /// @dev Per-agent local debt in USDC base units (6dp).
    mapping(string => uint256) private _localDebt;

    event ReporterSet(address indexed reporter, bool allowed);
    event ExposureChanged(
        string indexed agentId,
        string targetChain,
        address indexed pool,
        ExposureAction action,
        uint256 amount,
        uint256 newLocalDebt,
        bytes32 indexed noteNonce,
        uint64 reportedAt
    );

    error NotReporter(address caller);
    error DebtUnderflow(string agentId, uint256 debt, uint256 amount);

    /// @notice This satellite's CAIP-2 chain id, echoed into reports for Casper routing.
    string public chainCaip2;

    constructor(address initialOwner, string memory chainCaip2_) Ownable(initialOwner) {
        chainCaip2 = chainCaip2_;
    }

    modifier onlyReporter() {
        if (!reporters[msg.sender]) revert NotReporter(msg.sender);
        _;
    }

    function setReporter(address reporter, bool allowed) external onlyOwner {
        reporters[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    function setChainCaip2(string calldata chainCaip2_) external onlyOwner {
        chainCaip2 = chainCaip2_;
    }

    /// @notice Report a credit draw; increases local debt and emits `ExposureChanged`.
    function reportDraw(string calldata agentId, address pool, uint256 amount, bytes32 noteNonce)
        external
        onlyReporter
        returns (uint256 newLocalDebt)
    {
        newLocalDebt = _localDebt[agentId] + amount;
        _localDebt[agentId] = newLocalDebt;
        emit ExposureChanged(
            agentId, chainCaip2, pool, ExposureAction.Draw, amount, newLocalDebt, noteNonce, uint64(block.timestamp)
        );
    }

    /// @notice Report a repayment; decreases local debt and emits `ExposureChanged`.
    function reportRepay(string calldata agentId, address pool, uint256 amount, bytes32 noteNonce)
        external
        onlyReporter
        returns (uint256 newLocalDebt)
    {
        uint256 debt = _localDebt[agentId];
        if (amount > debt) revert DebtUnderflow(agentId, debt, amount);
        newLocalDebt = debt - amount;
        _localDebt[agentId] = newLocalDebt;
        emit ExposureChanged(
            agentId, chainCaip2, pool, ExposureAction.Repay, amount, newLocalDebt, noteNonce, uint64(block.timestamp)
        );
    }

    function localDebtOf(string calldata agentId) external view returns (uint256) {
        return _localDebt[agentId];
    }
}
