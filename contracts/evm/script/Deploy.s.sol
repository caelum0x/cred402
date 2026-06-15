// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {Cred402EmergencyPause} from "../src/Cred402EmergencyPause.sol";
import {Cred402SatelliteRegistry} from "../src/Cred402SatelliteRegistry.sol";
import {Cred402AddressBindingMirror} from "../src/Cred402AddressBindingMirror.sol";
import {Cred402ReceiptOutbox} from "../src/Cred402ReceiptOutbox.sol";
import {Cred402ReceiptInbox} from "../src/Cred402ReceiptInbox.sol";
import {Cred402RWAMirror} from "../src/Cred402RWAMirror.sol";
import {Cred402EvidenceOutbox} from "../src/Cred402EvidenceOutbox.sol";
import {Cred402CreditNoteVerifier} from "../src/Cred402CreditNoteVerifier.sol";
import {Cred402ExposureReporter} from "../src/Cred402ExposureReporter.sol";
import {Cred402CreditVault, IERC20} from "../src/Cred402CreditVault.sol";
import {Cred402DisputeMirror} from "../src/Cred402DisputeMirror.sol";
import {Cred402RealFiMirror} from "../src/Cred402RealFiMirror.sol";
import {ICasperSigVerifier} from "../src/interfaces/ICasperSigVerifier.sol";

/// @title Deploy
/// @notice Deploys and wires the full Cred402 EVM satellite suite.
///
/// Required environment variables:
///   - PRIVATE_KEY            : deployer key (the deployer becomes the suite owner)
///   - USDC_ADDRESS           : ERC20 USDC (6dp) used by the credit vault
///   - CASPER_SIG_VERIFIER    : ICasperSigVerifier precompile/oracle address
///   - CASPER_POLICY_PUBKEY   : 32-byte Casper policy ed25519 public key (bytes32)
///   - CHAIN_CAIP2            : this satellite's CAIP-2 id, e.g. "eip155:8453"
///
/// Run:
///   forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast
contract Deploy is Script {
    struct Deployment {
        Cred402EmergencyPause pauseGuard;
        Cred402SatelliteRegistry registry;
        Cred402AddressBindingMirror bindingMirror;
        Cred402ReceiptOutbox receiptOutbox;
        Cred402ReceiptInbox receiptInbox;
        Cred402RWAMirror rwaMirror;
        Cred402EvidenceOutbox evidenceOutbox;
        Cred402CreditNoteVerifier noteVerifier;
        Cred402ExposureReporter exposureReporter;
        Cred402CreditVault creditVault;
        Cred402DisputeMirror disputeMirror;
        Cred402RealFiMirror realfiMirror;
    }

    function run() external returns (Deployment memory d) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(deployerKey);

        address usdc = vm.envAddress("USDC_ADDRESS");
        address casperSigVerifier = vm.envAddress("CASPER_SIG_VERIFIER");
        bytes32 policyPubKey = vm.envBytes32("CASPER_POLICY_PUBKEY");
        string memory chainCaip2 = vm.envString("CHAIN_CAIP2");

        vm.startBroadcast(deployerKey);

        d.pauseGuard = new Cred402EmergencyPause(owner);
        d.registry = new Cred402SatelliteRegistry(owner);
        d.bindingMirror = new Cred402AddressBindingMirror(owner);
        d.receiptOutbox = new Cred402ReceiptOutbox(owner);
        d.receiptInbox = new Cred402ReceiptInbox(owner, d.receiptOutbox);
        d.rwaMirror = new Cred402RWAMirror(owner);
        d.evidenceOutbox = new Cred402EvidenceOutbox(owner);
        d.noteVerifier =
            new Cred402CreditNoteVerifier(owner, ICasperSigVerifier(casperSigVerifier), policyPubKey, chainCaip2);
        d.exposureReporter = new Cred402ExposureReporter(owner, chainCaip2);
        d.creditVault = new Cred402CreditVault(
            owner, IERC20(usdc), d.noteVerifier, d.exposureReporter, d.pauseGuard
        );
        d.disputeMirror = new Cred402DisputeMirror(owner);
        d.realfiMirror = new Cred402RealFiMirror(owner);

        // Wiring: the inbox must be an authorized emitter on the outbox.
        d.receiptOutbox.setEmitter(address(d.receiptInbox), true);
        // The credit vault is the authorized exposure reporter.
        d.exposureReporter.setReporter(address(d.creditVault), true);

        vm.stopBroadcast();

        console2.log("Cred402 EVM satellite deployed (owner):", owner);
        console2.log("  EmergencyPause     :", address(d.pauseGuard));
        console2.log("  SatelliteRegistry  :", address(d.registry));
        console2.log("  AddressBindingMirror:", address(d.bindingMirror));
        console2.log("  ReceiptOutbox      :", address(d.receiptOutbox));
        console2.log("  ReceiptInbox       :", address(d.receiptInbox));
        console2.log("  RWAMirror          :", address(d.rwaMirror));
        console2.log("  EvidenceOutbox     :", address(d.evidenceOutbox));
        console2.log("  CreditNoteVerifier :", address(d.noteVerifier));
        console2.log("  ExposureReporter   :", address(d.exposureReporter));
        console2.log("  CreditVault        :", address(d.creditVault));
        console2.log("  DisputeMirror      :", address(d.disputeMirror));
        console2.log("  RealFiMirror       :", address(d.realfiMirror));
    }
}
