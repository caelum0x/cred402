// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ICasperSigVerifier} from "./interfaces/ICasperSigVerifier.sol";
import {IFtsoV2} from "./interfaces/IFtsoV2.sol";
import {IFlareContractRegistry} from "./interfaces/IFlareContractRegistry.sol";

/// @notice Minimal local ERC20 interface (no external import paths assumed).
/// @dev The Cred402 EVM satellite deliberately vendors NO OpenZeppelin; it declares a
///      minimal `IERC20` inline (see `contracts/evm/src/Cred402CreditVault.sol`). The
///      Flare satellite matches that convention so both Foundry projects stay
///      dependency-free and reproducible. FXRP is a standard ERC20 FAsset (6 dp).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title Cred402FlareCreditVault
/// @notice A Flare-side credit vault that lends the interoperable FAsset **FXRP** against
///         a valid, Casper-policy-signed Credit Authorization Note (CAN). It is the
///         Solidity counterpart of `packages/chain-adapters/src/adapters/flare/
///         FlareSatelliteVault.ts` and enforces the SAME rules, on-chain:
///
///           - lend ONLY against a CAN whose ed25519 signature verifies under the
///             Casper policy key (via the `ICasperSigVerifier` precompile/oracle);
///           - the CAN must target THIS pool and this chain, be unexpired, and its
///             single-use nonce must not have been consumed before;
///           - the draw asset must be FXRP and `amount <= CAN.max_draw`;
///           - the vault must hold enough free FXRP liquidity.
///
///         Every draw is **priced in USD** from the live FTSO XRP/USD feed, so the
///         shared global-exposure cap is enforced in one denominator across every
///         Cred402 satellite (Casper, EVM, Flare…). FTSOv2 is resolved at runtime from
///         the FlareContractRegistry — never hardcoded.
///
///         "Casper approves credit; Flare executes it in XRP liquidity; FTSO prices it."
///
///         KeeperHub is the off-chain execution / reliability layer: it observes issued
///         CANs, submits `executeDraw` on Flare with the exact canonical signing bytes +
///         Casper signature, retries on transient RPC failure, and relays the resulting
///         `CreditDrawn` / `CreditRepaid` events back to the Casper root so the global
///         exposure manager can reconcile the agent's multi-chain debt. This contract
///         trusts NO caller: KeeperHub can only ever move funds that a valid CAN
///         authorizes, and only once per nonce.
///
///         Liquidity is provisioned by transferring FXRP directly into this vault
///         (e.g. from the Coston2 faucet or an LP). Drawn principal leaves the vault, so
///         the held FXRP balance is exactly the free pool (`availableLiquidity`).
///
/// All FXRP amounts are smallest units (6 dp, matching XRP). USD values are 6-dp
/// integers (USDC-style micro-units), so a value can be compared 1:1 with USDC exposure.
contract Cred402FlareCreditVault {
    // --- immutable configuration -------------------------------------------

    /// @notice The ed25519 verification precompile/oracle for Casper policy signatures.
    ICasperSigVerifier public immutable casperSigVerifier;

    /// @notice The FAsset FXRP token this vault lends (standard ERC20, 6 dp).
    IERC20 public immutable fxrp;

    /// @notice The 32-byte Casper policy ed25519 public key. A CAN is only honored if its
    ///         signature verifies under this key. (For ed25519 the public key IS 32 bytes;
    ///         the constructor arg is named `casperPolicyKeyHash` to match the deploy env.)
    bytes32 public immutable casperPolicyKeyHash;

    /// @notice Either the FlareContractRegistry (recommended, so FtsoV2 is resolved by
    ///         name at call time) OR a direct FtsoV2 address (useful for local testing).
    ///         `_resolveFtsoV2()` transparently accepts both.
    address public immutable ftsoV2OrRegistry;

    /// @notice This vault's CAIP-2 chain id, derived once from `block.chainid`
    ///         (e.g. "eip155:114" on Coston2). A CAN's `targetChain` must equal it.
    string public chainCaip2;

    // --- constants ---------------------------------------------------------

    /// @notice FTSO feed id for XRP/USD: category byte `0x01` (crypto) + ASCII "XRP/USD"
    ///         (`58 52 50 2f 55 53 44`), right-padded to 21 bytes. This is the exact
    ///         `feedIdFor("XRP/USD")` produced by the TypeScript FTSO client.
    bytes21 public constant XRP_USD_FEED_ID = bytes21(0x015852502f55534400000000000000000000000000);

    string internal constant EXPECTED_TYPE = "Cred402CreditAuthorizationNote";
    string internal constant EXPECTED_VERSION = "1";
    string internal constant EXPECTED_ASSET = "FXRP";

    // --- state -------------------------------------------------------------

    /// @notice Per-agent outstanding FXRP debt (keyed by the agent's Flare address).
    mapping(address => uint256) private _debt;

    /// @notice Single-use replay protection: a CAN's 32-byte `nonce` (its on-chain note
    ///         id) is marked consumed the first time it opens a draw.
    mapping(bytes32 => bool) private _consumedNote;

    /// @notice Total FXRP principal drawn and not yet repaid, across all agents.
    uint256 public totalOutstanding;

    // --- types -------------------------------------------------------------

    /// @notice CAN mirroring the canonical TypeScript standard
    ///         (`crosschain/standards/credit_notes.ts`) field-for-field, identical to the
    ///         EVM satellite's `Cred402CreditNoteVerifier.CreditAuthorizationNote`.
    struct CreditAuthorizationNote {
        string noteType; // must equal "Cred402CreditAuthorizationNote"
        string version; // must equal "1"
        string noteId; // "can:<...>"
        string agentId; // Cred402 agent id
        string targetChain; // CAIP-2, must equal this vault's chain (e.g. "eip155:114")
        address targetPool; // satellite vault address; must equal address(this)
        string maxDraw; // smallest-unit integer string (e.g. "500000000")
        string asset; // must equal "FXRP" for this vault
        uint32 creditScore; // 0..1000 typical
        uint32 riskPolicyVersion; // policy version under which this was signed
        string globalExposureAfterDraw; // smallest-unit integer string
        uint64 expiresAt; // unix seconds
        bytes32 nonce; // single-use replay nonce == on-chain note id
    }

    // --- events ------------------------------------------------------------

    event CreditDrawn(
        address indexed agent,
        uint256 amount,
        uint256 usdValue,
        bytes32 indexed noteId,
        uint256 newAgentDebt
    );
    event CreditRepaid(address indexed agent, uint256 amount, uint256 newAgentDebt);
    event NoteConsumed(bytes32 indexed noteId, string agentId, address indexed targetPool);

    // --- errors ------------------------------------------------------------

    error ZeroVerifier();
    error ZeroToken();
    error AmountZero();
    error AgentZero();
    error WrongType();
    error WrongVersion();
    error WrongAsset();
    error WrongTargetChain();
    error WrongTargetPool(address expected, address got);
    error NoteExpired(uint64 expiresAt, uint256 nowTs);
    error NoteAlreadyConsumed(bytes32 noteId);
    error CanonicalBytesMismatch();
    error InvalidPolicySignature();
    error ExceedsMaxDraw(uint256 amount, uint256 maxDraw);
    error MaxDrawNotInteger(string maxDraw);
    error InsufficientLiquidity(uint256 available, uint256 requested);
    error RepayExceedsDebt(address agent, uint256 debt, uint256 amount);
    error TransferFailed();
    error FtsoUnavailable();

    /// @param casperSigVerifier_ The ed25519 verification precompile/oracle address.
    /// @param fxrpToken_ The FXRP FAsset ERC20 this vault lends.
    /// @param casperPolicyKeyHash_ The 32-byte Casper policy ed25519 public key.
    /// @param ftsoV2OrRegistry_ The FlareContractRegistry (recommended) or a direct
    ///        FtsoV2 address. Registry resolution keeps FtsoV2 correct across upgrades.
    constructor(
        address casperSigVerifier_,
        address fxrpToken_,
        bytes32 casperPolicyKeyHash_,
        address ftsoV2OrRegistry_
    ) {
        if (casperSigVerifier_ == address(0)) revert ZeroVerifier();
        if (fxrpToken_ == address(0)) revert ZeroToken();
        if (ftsoV2OrRegistry_ == address(0)) revert FtsoUnavailable();

        casperSigVerifier = ICasperSigVerifier(casperSigVerifier_);
        fxrp = IERC20(fxrpToken_);
        casperPolicyKeyHash = casperPolicyKeyHash_;
        ftsoV2OrRegistry = ftsoV2OrRegistry_;

        // Derive this vault's CAIP-2 id from the chain it is deployed on, so a CAN's
        // `targetChain` binds to the exact network (e.g. "eip155:114" on Coston2).
        chainCaip2 = string(abi.encodePacked("eip155:", _toString(block.chainid)));
    }

    // --- credit ------------------------------------------------------------

    /// @notice Draw FXRP against a Casper-policy-signed CAN, priced in USD via FTSO.
    /// @dev Mirrors `FlareSatelliteVault.draw`. Order of checks (all must pass, else revert):
    ///      1. `amount > 0` and `agent != 0`;
    ///      2. the CAN verifies (type/version/asset/targetChain/targetPool==this/expiry/
    ///         replay/commitment binding/ed25519 policy signature) and its nonce is
    ///         consumed exactly once (one note = one draw);
    ///      3. `amount <= CAN.max_draw`;
    ///      4. the vault holds enough free FXRP liquidity;
    ///      then FXRP is sent to `agent`, per-agent debt is increased, the draw is priced
    ///      in USD from the live FTSO XRP/USD feed, and `CreditDrawn` is emitted for
    ///      KeeperHub to relay back to the Casper global exposure manager.
    /// @param note The CAN struct (mirrors the canonical standard field-for-field).
    /// @param canonicalSigningBytes Exact canonical JSON the policy key signed (the CAN
    ///        without its `casper_policy_signature` field).
    /// @param commitment keccak structural commitment over the CAN (relayer-derived);
    ///        must equal `structuralCommitment(note)`, binding the struct to the bytes.
    /// @param signature 64-byte ed25519 Casper policy signature over `canonicalSigningBytes`.
    /// @param agent Recipient of the drawn FXRP and the key under which debt is recorded.
    /// @param amount Draw amount in FXRP base units (6 dp); must be `<= CAN.max_draw`.
    /// @return usdValue The USD value (6 dp) of the draw at the FTSO rate used.
    /// @return newAgentDebt The agent's outstanding FXRP debt after this draw.
    function executeDraw(
        CreditAuthorizationNote calldata note,
        bytes calldata canonicalSigningBytes,
        bytes32 commitment,
        bytes calldata signature,
        address agent,
        uint256 amount
    ) external returns (uint256 usdValue, uint256 newAgentDebt) {
        if (amount == 0) revert AmountZero();
        if (agent == address(0)) revert AgentZero();

        // (2) Verify the CAN against this pool/chain and mark its nonce consumed.
        _consumeNote(note, canonicalSigningBytes, commitment, signature);

        // (3) amount must not exceed the Casper-approved ceiling.
        uint256 maxDraw = _parseUint(note.maxDraw);
        if (amount > maxDraw) revert ExceedsMaxDraw(amount, maxDraw);

        // (4) free FXRP liquidity must cover the draw.
        uint256 free = availableLiquidity();
        if (amount > free) revert InsufficientLiquidity(free, amount);

        // Price the draw in USD (6 dp) from the live FTSO XRP/USD feed.
        usdValue = _quoteUsd6dp(amount);

        // Effects.
        newAgentDebt = _debt[agent] + amount;
        _debt[agent] = newAgentDebt;
        totalOutstanding += amount;

        // Interactions.
        _pushFxrp(agent, amount);

        emit CreditDrawn(agent, amount, usdValue, note.nonce, newAgentDebt);
    }

    /// @notice Repay outstanding FXRP credit for an agent. Caller must have approved
    ///         `amount` of FXRP to this vault.
    /// @dev Mirrors `FlareSatelliteVault.repay`, but reverts (rather than silently
    ///      clamping) if `amount` exceeds the agent's debt, so KeeperHub sees an explicit
    ///      failure it can relay. Pass the exact outstanding figure to fully settle.
    /// @param agent The agent whose debt is being repaid.
    /// @param amount FXRP base units to repay; must be `<= debtOf(agent)`.
    /// @return newAgentDebt The agent's outstanding FXRP debt after repayment.
    function executeRepay(address agent, uint256 amount) external returns (uint256 newAgentDebt) {
        if (amount == 0) revert AmountZero();
        if (agent == address(0)) revert AgentZero();

        uint256 debt = _debt[agent];
        if (amount > debt) revert RepayExceedsDebt(agent, debt, amount);

        // Interactions: pull FXRP back into the pool.
        _pullFxrp(msg.sender, amount);

        // Effects.
        newAgentDebt = debt - amount;
        _debt[agent] = newAgentDebt;
        totalOutstanding -= amount;

        emit CreditRepaid(agent, amount, newAgentDebt);
    }

    // --- verification ------------------------------------------------------

    /// @notice Structural commitment binding the CAN struct to its canonical bytes.
    /// @dev keccak over the abi-encoded note fields. The off-chain relayer computes the
    ///      same commitment from the parsed CAN; a mismatch means the supplied
    ///      `canonicalSigningBytes` do not correspond to the supplied struct. Identical to
    ///      the EVM `Cred402CreditNoteVerifier.structuralCommitment`.
    /// @param note The CAN struct.
    /// @return The 32-byte structural commitment.
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

    /// @notice Pure view check of a CAN against this vault, without consuming the nonce.
    /// @dev Mirrors `verifyCreditAuthorizationNote` in the TS standard plus the extra
    ///      struct↔bytes binding the EVM verifier enforces. Reverts with a specific error
    ///      on the first failed check; returns `true` only if every check passes.
    /// @param note The CAN struct.
    /// @param canonicalSigningBytes The exact canonical JSON bytes the policy key signed.
    /// @param commitment keccak commitment the relayer derived over the same CAN.
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
        if (keccak256(bytes(note.asset)) != keccak256(bytes(EXPECTED_ASSET))) revert WrongAsset();
        if (keccak256(bytes(note.targetChain)) != keccak256(bytes(chainCaip2))) revert WrongTargetChain();
        if (note.targetPool != address(this)) revert WrongTargetPool(address(this), note.targetPool);
        if (block.timestamp > note.expiresAt) revert NoteExpired(note.expiresAt, block.timestamp);
        if (_consumedNote[note.nonce]) revert NoteAlreadyConsumed(note.nonce);

        // Bind the supplied struct to the relayer's commitment (struct integrity).
        if (commitment != structuralCommitment(note)) revert CanonicalBytesMismatch();

        // The canonical bytes must be non-empty: they are the exact JSON the policy key
        // signed. Empty bytes can never be a valid Casper signing payload.
        if (canonicalSigningBytes.length == 0) revert CanonicalBytesMismatch();

        if (!casperSigVerifier.verifyEd25519(casperPolicyKeyHash, canonicalSigningBytes, signature)) {
            revert InvalidPolicySignature();
        }
        return true;
    }

    // --- views -------------------------------------------------------------

    /// @notice Free FXRP available to draw. Drawn principal has already left the vault,
    ///         so the held FXRP balance is exactly the free pool.
    /// @return The vault's current FXRP balance in base units (6 dp).
    function availableLiquidity() public view returns (uint256) {
        return fxrp.balanceOf(address(this));
    }

    /// @notice Outstanding FXRP debt for an agent, in base units (6 dp).
    /// @param agent The agent's Flare address.
    /// @return The agent's outstanding FXRP debt.
    function debtOf(address agent) external view returns (uint256) {
        return _debt[agent];
    }

    /// @notice Whether a CAN nonce (on-chain note id) has already opened a draw.
    /// @param noteId The 32-byte CAN nonce.
    /// @return True if the note has been consumed and can never draw again.
    function consumedNote(bytes32 noteId) external view returns (bool) {
        return _consumedNote[noteId];
    }

    /// @notice The USD value (6 dp) an `amount` of FXRP would be priced at right now,
    ///         using the live FTSO XRP/USD feed. Useful for pre-flight checks by KeeperHub.
    /// @param amount FXRP base units (6 dp).
    /// @return usdValue The USD value in 6-dp integer micro-units.
    function quoteUsd(uint256 amount) external view returns (uint256 usdValue) {
        return _quoteUsd6dp(amount);
    }

    /// @notice The raw live FTSO XRP/USD feed reading (value, decimals, timestamp).
    /// @dev Resolves FtsoV2 from the configured registry (or direct address) and reads
    ///      `getFeedById(XRP_USD_FEED_ID)`. Exposed for observability / off-chain audit.
    /// @return value The feed value, scaled by `decimals`.
    /// @return decimals The number of decimals `value` is scaled by (may be negative).
    /// @return timestamp The unix timestamp of the underlying voting round.
    function latestXrpUsd() external view returns (uint256 value, int8 decimals, uint64 timestamp) {
        return _resolveFtsoV2().getFeedById(XRP_USD_FEED_ID);
    }

    // --- internal ----------------------------------------------------------

    /// @notice Verify a CAN for this pool and consume its nonce (single-use).
    /// @dev State-changing: after full verification, marks the nonce consumed so the same
    ///      note cannot open credit twice. Emits `NoteConsumed`.
    function _consumeNote(
        CreditAuthorizationNote calldata note,
        bytes calldata canonicalSigningBytes,
        bytes32 commitment,
        bytes calldata signature
    ) internal {
        checkNote(note, canonicalSigningBytes, commitment, signature);
        _consumedNote[note.nonce] = true;
        emit NoteConsumed(note.nonce, note.agentId, note.targetPool);
    }

    /// @notice Price `amount` FXRP (6 dp) in USD (6 dp) from the live FTSO XRP/USD feed.
    /// @dev Mirrors `fxrpValueUsd` in `fassets.ts`: FXRP is 6 dp, so
    ///      `usd_6dp = round(amount / 1e6 * xrpUsd * 1e6) = amount * value / 10^decimals`.
    ///      FTSO decimals are non-negative for XRP/USD, but negative decimals are handled
    ///      for full generality. Reverts if FtsoV2 returns a zero price (no fabricated
    ///      value on-chain — the sim fallback lives only in the off-chain client).
    function _quoteUsd6dp(uint256 amount) internal view returns (uint256 usdValue) {
        (uint256 value, int8 decimals,) = _resolveFtsoV2().getFeedById(XRP_USD_FEED_ID);
        if (value == 0) revert FtsoUnavailable();
        if (decimals >= 0) {
            usdValue = (amount * value) / (10 ** uint256(uint8(decimals)));
        } else {
            usdValue = amount * value * (10 ** uint256(uint8(-decimals)));
        }
    }

    /// @notice Resolve the FtsoV2 contract from the configured registry, or fall back to
    ///         treating the configured address as a direct FtsoV2 (for local testing).
    /// @dev `getContractAddressByName("FtsoV2")` succeeds only against a real registry; a
    ///      direct FtsoV2 (no such method / no code) makes the call revert, which is
    ///      caught and the configured address is used as-is.
    function _resolveFtsoV2() internal view returns (IFtsoV2) {
        try IFlareContractRegistry(ftsoV2OrRegistry).getContractAddressByName("FtsoV2") returns (address a) {
            if (a != address(0)) return IFtsoV2(a);
        } catch {
            // Not a registry — fall through and use the address directly.
        }
        return IFtsoV2(ftsoV2OrRegistry);
    }

    /// @notice Pull FXRP from `from` into the vault; reverts on transfer failure.
    function _pullFxrp(address from, uint256 amount) internal {
        bool okTransfer = fxrp.transferFrom(from, address(this), amount);
        if (!okTransfer) revert TransferFailed();
    }

    /// @notice Push FXRP from the vault to `to`; reverts on transfer failure.
    function _pushFxrp(address to, uint256 amount) internal {
        bool okTransfer = fxrp.transfer(to, amount);
        if (!okTransfer) revert TransferFailed();
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

    /// @notice Convert an unsigned integer to its decimal string form.
    /// @dev Used once at construction to build the CAIP-2 chain id from `block.chainid`.
    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 temp = v;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (v != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(v % 10)));
            v /= 10;
        }
        return string(buffer);
    }
}
