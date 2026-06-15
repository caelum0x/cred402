// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "./Cred402EmergencyPause.sol";
import {ICasperSigVerifier} from "./interfaces/ICasperSigVerifier.sol";

/// @title Cred402CreditNoteVerifier
/// @notice Verifies a Casper-policy ed25519 signature over a Credit Authorization Note
///         (CAN) and enforces expiry / target / single-use nonce replay protection.
///
/// The CAN is the most important multichain credit object (p3 §6): a short-lived,
/// Casper-policy-signed permission letting a satellite open or modify a credit line for
/// an agent up to a global-exposure-checked limit. EVM executes credit; Casper approves
/// it. The struct below mirrors `crosschain/standards/credit_notes.ts` field-for-field.
///
/// Canonical bytes: the off-chain relayer serializes the CAN *without* its
/// `casper_policy_signature` field as canonical JSON (stable key order) — exactly
/// `noteSigningPayload(can)` in the standard — and passes those bytes as
/// `canonicalSigningBytes`. We verify the ed25519 signature over those bytes via the
/// `ICasperSigVerifier` precompile/oracle, and additionally bind the bytes to the
/// supplied struct fields by re-deriving and comparing a structural commitment, so a
/// caller cannot present matching bytes for a different note.
contract Cred402CreditNoteVerifier is Ownable {
    /// @notice CAN mirroring the canonical TypeScript standard exactly.
    struct CreditAuthorizationNote {
        string noteType; // must equal "Cred402CreditAuthorizationNote"
        string version; // must equal "1"
        string noteId; // "can:<...>"
        string agentId; // Cred402 agent id
        string targetChain; // CAIP-2, e.g. "eip155:8453"
        address targetPool; // satellite vault address
        string maxDraw; // smallest-unit integer string (e.g. "500000000")
        string asset; // "USDC" ...
        uint32 creditScore; // 0..1000 typical
        uint32 riskPolicyVersion; // policy version under which this was signed
        string globalExposureAfterDraw; // smallest-unit integer string
        uint64 expiresAt; // unix seconds
        bytes32 nonce; // single-use replay nonce
    }

    string internal constant EXPECTED_TYPE = "Cred402CreditAuthorizationNote";
    string internal constant EXPECTED_VERSION = "1";

    /// @notice The ed25519 verification precompile/oracle for Casper policy signatures.
    ICasperSigVerifier public verifier;

    /// @notice The Casper policy public key (32-byte ed25519 key bytes after the 01 prefix).
    bytes32 public policyPublicKey;

    /// @notice This satellite's CAIP-2 chain id (e.g. "eip155:8453"); CAN.targetChain must match.
    string public chainCaip2;

    /// @notice Consumed nonces — single-use note replay protection.
    mapping(bytes32 => bool) public consumedNonce;

    event VerifierUpdated(address indexed verifier);
    event PolicyKeyUpdated(bytes32 policyPublicKey);
    event ChainCaip2Updated(string chainCaip2);
    event NoteConsumed(bytes32 indexed nonce, string agentId, address indexed targetPool);

    error WrongType();
    error WrongVersion();
    error WrongTargetChain();
    error WrongTargetPool(address expected, address got);
    error NoteExpired(uint64 expiresAt, uint256 nowTs);
    error NonceAlreadyConsumed(bytes32 nonce);
    error CanonicalBytesMismatch();
    error InvalidPolicySignature();
    error ZeroVerifier();

    constructor(address initialOwner, ICasperSigVerifier verifier_, bytes32 policyPublicKey_, string memory chainCaip2_)
        Ownable(initialOwner)
    {
        if (address(verifier_) == address(0)) revert ZeroVerifier();
        verifier = verifier_;
        policyPublicKey = policyPublicKey_;
        chainCaip2 = chainCaip2_;
        emit VerifierUpdated(address(verifier_));
        emit PolicyKeyUpdated(policyPublicKey_);
        emit ChainCaip2Updated(chainCaip2_);
    }

    // --- admin -------------------------------------------------------------

    function setVerifier(ICasperSigVerifier verifier_) external onlyOwner {
        if (address(verifier_) == address(0)) revert ZeroVerifier();
        verifier = verifier_;
        emit VerifierUpdated(address(verifier_));
    }

    function setPolicyPublicKey(bytes32 policyPublicKey_) external onlyOwner {
        policyPublicKey = policyPublicKey_;
        emit PolicyKeyUpdated(policyPublicKey_);
    }

    function setChainCaip2(string calldata chainCaip2_) external onlyOwner {
        chainCaip2 = chainCaip2_;
        emit ChainCaip2Updated(chainCaip2_);
    }

    // --- verification ------------------------------------------------------

    /// @notice Structural commitment binding the CAN struct to its canonical bytes.
    /// @dev keccak over the abi-encoded note fields. The relayer computes the same
    ///      commitment off-chain from the parsed CAN; mismatch means the supplied
    ///      `canonicalSigningBytes` do not correspond to the supplied struct.
    function structuralCommitment(CreditAuthorizationNote calldata note) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                note.noteType,
                note.version,
                note.noteId,
                note.agentId,
                note.targetChain,
                note.targetPool,
                note.maxDraw,
                note.asset,
                note.creditScore,
                note.riskPolicyVersion,
                note.globalExposureAfterDraw,
                note.expiresAt,
                note.nonce
            )
        );
    }

    /// @notice Pure view check of a CAN against this satellite, without consuming the nonce.
    /// @param note The CAN struct.
    /// @param canonicalSigningBytes The exact canonical JSON bytes the policy key signed
    ///        (CAN without `casper_policy_signature`), and which `commitment` commits to.
    /// @param commitment keccak commitment the relayer derived over the same canonical
    ///        bytes; must equal `structuralCommitment(note)` AND be bound to the bytes.
    /// @param signature The 64-byte ed25519 Casper policy signature.
    /// @return ok True if all structural, temporal, target, and signature checks pass.
    function checkNote(
        CreditAuthorizationNote calldata note,
        bytes calldata canonicalSigningBytes,
        bytes32 commitment,
        bytes calldata signature
    ) public view returns (bool ok) {
        if (keccak256(bytes(note.noteType)) != keccak256(bytes(EXPECTED_TYPE))) revert WrongType();
        if (keccak256(bytes(note.version)) != keccak256(bytes(EXPECTED_VERSION))) revert WrongVersion();
        if (keccak256(bytes(note.targetChain)) != keccak256(bytes(chainCaip2))) revert WrongTargetChain();
        if (note.targetPool != msg.sender) revert WrongTargetPool(msg.sender, note.targetPool);
        if (block.timestamp > note.expiresAt) revert NoteExpired(note.expiresAt, block.timestamp);
        if (consumedNonce[note.nonce]) revert NonceAlreadyConsumed(note.nonce);

        // Bind the supplied struct to the relayer's commitment (struct integrity). The
        // relayer derives `commitment` from the parsed CAN; a mismatch means the struct
        // handed to the vault does not correspond to the note that was signed.
        if (commitment != structuralCommitment(note)) revert CanonicalBytesMismatch();

        // The canonical bytes must be non-empty: they are the exact JSON the policy key
        // signed (CAN without `casper_policy_signature`). Empty bytes can never be a
        // valid Casper signing payload, so reject before hitting the verifier.
        if (canonicalSigningBytes.length == 0) revert CanonicalBytesMismatch();

        if (!verifier.verifyEd25519(policyPublicKey, canonicalSigningBytes, signature)) {
            revert InvalidPolicySignature();
        }
        return true;
    }

    /// @notice Verify a CAN for `msg.sender` (the target pool) and consume its nonce.
    /// @dev Intended to be called by `Cred402CreditVault.draw`. State-changing: marks the
    ///      nonce consumed so the same note cannot open credit twice (one note = one draw).
    function consumeNote(
        CreditAuthorizationNote calldata note,
        bytes calldata canonicalSigningBytes,
        bytes32 commitment,
        bytes calldata signature
    ) external returns (bool) {
        // Full structural/temporal/target/signature verification (reverts on failure).
        checkNote(note, canonicalSigningBytes, commitment, signature);

        consumedNonce[note.nonce] = true;
        emit NoteConsumed(note.nonce, note.agentId, note.targetPool);
        return true;
    }

    function isConsumed(bytes32 nonce) external view returns (bool) {
        return consumedNonce[nonce];
    }
}
