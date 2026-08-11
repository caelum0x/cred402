/**
 * Flare integration — Cred402's interoperable-asset credit satellite and its
 * confidential scoring path. The chain adapter, FTSO price client, FDC attestation
 * client and FAsset (FXRP) model live in packages/chain-adapters/src/adapters/flare;
 * this module holds the Flare Confidential Compute scorer that keeps raw agent
 * cash-flow features private while publishing an attested credit score.
 */
export { FlareCreditSatellite } from "./satellite.js";
export type { FlareSatelliteConfig, FlareDrawSummary } from "./satellite.js";
export { PositionEngine, DEFAULT_THRESHOLDS } from "./positions.js";
export type { PositionHealth, PositionStatus, PositionThresholds } from "./positions.js";
export { CreditKeeper } from "./keeper.js";
export type { KeeperDecision, KeeperRunResult, KeeperActionKind, KeeperOptions } from "./keeper.js";
export { AutomationEngine } from "./automations.js";
export type { Automation, AutomationDef, AutomationTrigger, AutomationAction, AutomationRun } from "./automations.js";
export { CollateralVault, COLLATERAL_ASSETS } from "./collateral.js";
export type { CollateralAsset, CollateralLine, CollateralValuation } from "./collateral.js";
export { FAssetsMinter } from "./fassets_mint.js";
export type { MintReservation, MintResult, RedeemResult, MintStatus } from "./fassets_mint.js";
export { ConfidentialScorer, verifyConfidentialScore } from "./confidential_score.js";
export type {
  ConfidentialScoreAttestation,
  EnclaveAttestation,
  ConfidentialPlatform,
  ConfidentialScorerOptions,
} from "./confidential_score.js";
