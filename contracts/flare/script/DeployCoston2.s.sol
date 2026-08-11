// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {Cred402FlareCreditVault} from "../src/Cred402FlareCreditVault.sol";

/// @title DeployCoston2
/// @notice Deploys `Cred402FlareCreditVault` to Flare Testnet Coston2 (chain id 114).
///
/// FTSOv2 is NOT passed as an address: the vault resolves it at runtime from the
/// FlareContractRegistry, which lives at the SAME address on every Flare-family network
/// (`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`). The deployer passes the registry (the
/// default below) as the vault's `ftsoV2OrRegistry` argument.
///
/// Required environment variables:
///   - PRIVATE_KEY            : deployer key (funded with C2FLR for gas)
///   - FXRP_ADDRESS           : FXRP FAsset ERC20 (6 dp) the vault lends
///   - CASPER_POLICY_KEY_HASH : 32-byte Casper policy ed25519 public key (bytes32)
///
/// Optional (with documented defaults):
///   - CASPER_SIG_VERIFIER    : ICasperSigVerifier precompile/oracle address
///                              (default: canonical ed25519 precompile 0x...0402)
///   - FTSOV2_OR_REGISTRY     : FlareContractRegistry or a direct FtsoV2 address
///                              (default: FlareContractRegistry 0xaD67…6019)
///
/// Run:
///   forge script script/DeployCoston2.s.sol:DeployCoston2 --rpc-url coston2 --broadcast
contract DeployCoston2 is Script {
    /// @notice FlareContractRegistry — identical on Flare / Songbird / Coston2 / Coston.
    address internal constant FLARE_CONTRACT_REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    /// @notice Documented canonical ed25519 verification precompile address.
    address internal constant CANONICAL_ED25519_PRECOMPILE = 0x0000000000000000000000000000000000000402;

    /// @notice Coston2 EVM chain id.
    uint256 internal constant COSTON2_CHAIN_ID = 114;

    function run() external returns (Cred402FlareCreditVault vault) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address fxrp = vm.envAddress("FXRP_ADDRESS");
        bytes32 casperPolicyKeyHash = vm.envBytes32("CASPER_POLICY_KEY_HASH");
        address casperSigVerifier = vm.envOr("CASPER_SIG_VERIFIER", CANONICAL_ED25519_PRECOMPILE);
        address ftsoV2OrRegistry = vm.envOr("FTSOV2_OR_REGISTRY", FLARE_CONTRACT_REGISTRY);

        if (block.chainid != COSTON2_CHAIN_ID) {
            // Not fatal (the same script also deploys to Flare mainnet id 14), but surface
            // the mismatch so an operator notices an unexpected target network.
            console2.log("WARNING: not on Coston2 (114). Current chain id:", block.chainid);
        }

        vm.startBroadcast(deployerKey);
        vault = new Cred402FlareCreditVault(casperSigVerifier, fxrp, casperPolicyKeyHash, ftsoV2OrRegistry);
        vm.stopBroadcast();

        console2.log("Cred402FlareCreditVault deployed");
        console2.log("  deployer            :", deployer);
        console2.log("  chain id            :", block.chainid);
        console2.log("  vault               :", address(vault));
        console2.log("  FXRP token          :", fxrp);
        console2.log("  casperSigVerifier   :", casperSigVerifier);
        console2.log("  ftsoV2OrRegistry    :", ftsoV2OrRegistry);
        console2.log("  chainCaip2          :", vault.chainCaip2());
    }
}
