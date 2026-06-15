// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";
import {Cred402EmergencyPause} from "./Cred402EmergencyPause.sol";
import {Cred402CreditNoteVerifier} from "./Cred402CreditNoteVerifier.sol";
import {Cred402ExposureReporter} from "./Cred402ExposureReporter.sol";

/// @notice Minimal local ERC20 interface (no external import paths assumed).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title Cred402CreditVault
/// @notice ERC20 (USDC) credit vault for a Cred402 EVM satellite. Liquidity providers
///         deposit/withdraw USDC; agents draw credit **only** against a valid,
///         unexpired, target-matching, Casper-policy-signed Credit Authorization Note
///         (CAN), and **never** beyond `CAN.max_draw`. Each note is single-use. Draws
///         and repayments emit exposure reports relayed back to Casper, which adjusts
///         the `GlobalExposureManager` and prevents multi-chain over-borrow.
///
///         "EVM executes credit; Casper approves credit."
///
/// All amounts are USDC base units (6dp). `1 USD micro-unit == 1 USDC base unit`.
contract Cred402CreditVault is Ownable {
    IERC20 public immutable usdc;
    Cred402CreditNoteVerifier public immutable noteVerifier;
    Cred402ExposureReporter public immutable exposureReporter;
    Cred402EmergencyPause public immutable pauseGuard;

    /// @notice Total USDC principal supplied by liquidity providers (bookkeeping).
    uint256 public totalLiquidity;

    /// @notice Outstanding principal drawn and not yet repaid, across all agents.
    uint256 public totalOutstanding;

    /// @dev LP balance accounting (1:1 with deposited base units; no interest model).
    mapping(address => uint256) public liquidityOf;

    /// @dev Per-agent outstanding debt in USDC base units.
    mapping(string => uint256) private _debt;

    event LiquidityDeposited(address indexed provider, uint256 amount, uint256 newTotalLiquidity);
    event LiquidityWithdrawn(address indexed provider, uint256 amount, uint256 newTotalLiquidity);
    event CreditDrawn(
        string indexed agentId,
        address indexed borrower,
        uint256 amount,
        bytes32 indexed noteNonce,
        uint256 newAgentDebt
    );
    event CreditRepaid(string indexed agentId, address indexed payer, uint256 amount, uint256 newAgentDebt);

    error AmountZero();
    error InsufficientLiquidity(uint256 available, uint256 requested);
    error InsufficientProviderBalance(uint256 balance, uint256 requested);
    error ExceedsMaxDraw(uint256 amount, uint256 maxDraw);
    error MaxDrawNotInteger(string maxDraw);
    error RepayExceedsDebt(string agentId, uint256 debt, uint256 amount);
    error TransferFailed();
    error BorrowerZero();

    constructor(
        address initialOwner,
        IERC20 usdc_,
        Cred402CreditNoteVerifier noteVerifier_,
        Cred402ExposureReporter exposureReporter_,
        Cred402EmergencyPause pauseGuard_
    ) Ownable(initialOwner) {
        usdc = usdc_;
        noteVerifier = noteVerifier_;
        exposureReporter = exposureReporter_;
        pauseGuard = pauseGuard_;
    }

    // --- liquidity ---------------------------------------------------------

    /// @notice Supply USDC liquidity to the vault. Caller must have approved `amount`.
    function deposit(uint256 amount) external {
        if (amount == 0) revert AmountZero();
        _pullUSDC(msg.sender, amount);
        liquidityOf[msg.sender] += amount;
        totalLiquidity += amount;
        emit LiquidityDeposited(msg.sender, amount, totalLiquidity);
    }

    /// @notice Withdraw previously supplied liquidity, up to the provider's balance and
    ///         the vault's free (undrawn) USDC.
    function withdraw(uint256 amount) external {
        if (amount == 0) revert AmountZero();
        uint256 providerBalance = liquidityOf[msg.sender];
        if (amount > providerBalance) revert InsufficientProviderBalance(providerBalance, amount);

        uint256 free = availableLiquidity();
        if (amount > free) revert InsufficientLiquidity(free, amount);

        liquidityOf[msg.sender] = providerBalance - amount;
        totalLiquidity -= amount;
        _pushUSDC(msg.sender, amount);
        emit LiquidityWithdrawn(msg.sender, amount, totalLiquidity);
    }

    // --- credit ------------------------------------------------------------

    /// @notice Draw `amount` of credit against a Casper-policy-signed CAN.
    /// @dev Order of checks (all must pass, else revert):
    ///      1. not paused;
    ///      2. amount > 0 and borrower != 0;
    ///      3. CAN verified + nonce consumed by the verifier (type/version/targetChain/
    ///         targetPool==address(this)/expiry/replay/ed25519 policy signature);
    ///      4. amount <= note.max_draw;
    ///      5. enough free liquidity;
    ///      then funds are sent to `borrower`, debt is increased, and an exposure draw
    ///      report is emitted for relaying back to Casper.
    /// @param note The CAN struct (mirrors the canonical standard).
    /// @param canonicalSigningBytes Exact canonical JSON the policy key signed.
    /// @param commitment keccak structural commitment over the CAN (relayer-derived).
    /// @param signature 64-byte ed25519 Casper policy signature.
    /// @param borrower Recipient of the drawn USDC (the agent's bound EVM address).
    /// @param amount Draw amount in USDC base units; must be <= note.max_draw.
    function draw(
        Cred402CreditNoteVerifier.CreditAuthorizationNote calldata note,
        bytes calldata canonicalSigningBytes,
        bytes32 commitment,
        bytes calldata signature,
        address borrower,
        uint256 amount
    ) external returns (uint256 newAgentDebt) {
        pauseGuard.requireNotPaused();
        if (amount == 0) revert AmountZero();
        if (borrower == address(0)) revert BorrowerZero();

        // (3) Verify the Casper note and consume its nonce (single-use). Reverts on any
        //     structural/temporal/target/signature failure. The verifier checks
        //     `targetPool == msg.sender`, and msg.sender into the verifier is this vault,
        //     so the note must target THIS pool.
        noteVerifier.consumeNote(note, canonicalSigningBytes, commitment, signature);

        // (4) amount must not exceed the Casper-approved ceiling.
        uint256 maxDraw = _parseUint(note.maxDraw);
        if (amount > maxDraw) revert ExceedsMaxDraw(amount, maxDraw);

        // (5) free liquidity must cover the draw.
        uint256 free = availableLiquidity();
        if (amount > free) revert InsufficientLiquidity(free, amount);

        // Effects.
        newAgentDebt = _debt[note.agentId] + amount;
        _debt[note.agentId] = newAgentDebt;
        totalOutstanding += amount;

        // Interactions.
        _pushUSDC(borrower, amount);
        exposureReporter.reportDraw(note.agentId, address(this), amount, note.nonce);

        emit CreditDrawn(note.agentId, borrower, amount, note.nonce, newAgentDebt);
    }

    /// @notice Repay outstanding credit for an agent. Caller must have approved `amount`.
    /// @param noteNonce The nonce of the note this repayment settles (for Casper linkage;
    ///                  pass bytes32(0) for a generic repayment).
    function repay(string calldata agentId, uint256 amount, bytes32 noteNonce)
        external
        returns (uint256 newAgentDebt)
    {
        if (amount == 0) revert AmountZero();
        uint256 debt = _debt[agentId];
        if (amount > debt) revert RepayExceedsDebt(agentId, debt, amount);

        _pullUSDC(msg.sender, amount);

        newAgentDebt = debt - amount;
        _debt[agentId] = newAgentDebt;
        totalOutstanding -= amount;

        exposureReporter.reportRepay(agentId, address(this), amount, noteNonce);
        emit CreditRepaid(agentId, msg.sender, amount, newAgentDebt);
    }

    // --- views -------------------------------------------------------------

    /// @notice Free USDC available to draw or withdraw. Drawn principal has already left
    ///         the vault, so the held USDC balance is exactly the free pool.
    function availableLiquidity() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function debtOf(string calldata agentId) external view returns (uint256) {
        return _debt[agentId];
    }

    // --- internal ----------------------------------------------------------

    function _pullUSDC(address from, uint256 amount) internal {
        bool ok = usdc.transferFrom(from, address(this), amount);
        if (!ok) revert TransferFailed();
    }

    function _pushUSDC(address to, uint256 amount) internal {
        bool ok = usdc.transfer(to, amount);
        if (!ok) revert TransferFailed();
    }

    /// @notice Parse a decimal integer string (e.g. CAN.max_draw "500000000") to uint256.
    /// @dev Reverts if the string is empty or contains a non-digit. Mirrors the standard's
    ///      `/^\d+$/` validation on smallest-unit integer strings.
    function _parseUint(string memory s) internal pure returns (uint256 value) {
        bytes memory b = bytes(s);
        if (b.length == 0) revert MaxDrawNotInteger(s);
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c < 0x30 || c > 0x39) revert MaxDrawNotInteger(s);
            value = value * 10 + (c - 0x30);
        }
    }
}
