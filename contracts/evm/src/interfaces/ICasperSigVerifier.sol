// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ICasperSigVerifier
/// @notice Precompile-style interface for verifying Casper ed25519 signatures on EVM.
///
/// EVM chains do not expose a standard native ed25519 precompile, so Cred402 routes
/// Casper ed25519 verification through this interface. A deployment may point it at:
///
///   - a real ed25519 verification precompile, when the host chain provides one
///     (documented canonical address `0x0000000000000000000000000000000000000402`), or
///   - a trusted oracle / adapter contract that wraps such verification.
///
/// Implementations MUST be pure verification: given a 32-byte ed25519 public key, an
/// arbitrary message, and a 64-byte ed25519 signature, return whether the signature is
/// valid for that key over that message. They MUST NOT mutate state and MUST NOT revert
/// on an invalid signature — they return `false` instead so callers can branch.
interface ICasperSigVerifier {
    /// @notice Documented canonical address for an ed25519 verification precompile on
    ///         chains that expose one. Adapters that wrap an oracle may live elsewhere.
    /// @return The canonical precompile address `0x...0402`.
    function CANONICAL_PRECOMPILE() external pure returns (address);

    /// @notice Verify a Casper ed25519 signature.
    /// @param publicKey The 32-byte ed25519 public key (Casper account public key bytes,
    ///                  i.e. the key after the `01` ed25519 algorithm prefix).
    /// @param message   The exact canonical bytes that were signed (CAN canonical JSON
    ///                  without the `casper_policy_signature` field).
    /// @param signature The 64-byte ed25519 signature.
    /// @return ok True if and only if the signature is valid for the key over the message.
    function verifyEd25519(bytes32 publicKey, bytes calldata message, bytes calldata signature)
        external
        view
        returns (bool ok);
}
