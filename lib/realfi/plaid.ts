import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import type { RealFiBridge } from "../services/realfi_bridge.js";

/**
 * Real Plaid integration (p10) — verifies a bank account in Plaid **sandbox** and
 * commits a privacy-preserving Bank Verification Envelope via the RealFi Bridge.
 * Account/cashflow data is hashed by the bridge; raw bank data never goes on-chain.
 *
 * Sandbox flow (no real bank, real Plaid API):
 *   sandboxPublicTokenCreate → itemPublicTokenExchange → authGet + accountsBalanceGet
 *
 * Configure with PLAID_CLIENT_ID / PLAID_SECRET (sandbox). Unset → not wired.
 */
export interface PlaidConfig {
  clientId: string;
  secret: string;
  env?: "sandbox" | "production";
}

export interface BankVerificationInput {
  operator_id: string;
  account_ownership_verified: boolean;
  cashflow_report: unknown;
  balance_snapshot: unknown;
  data_period_start: number;
  data_period_end: number;
}

export class PlaidConnector {
  private readonly api: PlaidApi;

  constructor(cfg: PlaidConfig) {
    const basePath = PlaidEnvironments[cfg.env ?? "sandbox"];
    this.api = new PlaidApi(
      new Configuration({
        basePath,
        baseOptions: { headers: { "PLAID-CLIENT-ID": cfg.clientId, "PLAID-SECRET": cfg.secret } },
      }),
    );
  }

  /**
   * Run the full sandbox verification flow for a test institution and return the
   * bank-verification inputs (already shaped for the bridge). Real Plaid API.
   */
  async verifySandboxAccount(operatorId: string, institutionId = "ins_109508"): Promise<BankVerificationInput> {
    const pub = await this.api.sandboxPublicTokenCreate({
      institution_id: institutionId,
      initial_products: [Products.Auth],
    });
    const exchange = await this.api.itemPublicTokenExchange({ public_token: pub.data.public_token });
    const accessToken = exchange.data.access_token;
    const auth = await this.api.authGet({ access_token: accessToken });
    const balance = await this.api.accountsBalanceGet({ access_token: accessToken });
    return bankVerificationFromPlaid(operatorId, auth.data, balance.data);
  }

  /** Verify a sandbox account and commit the on-chain envelope in one step. */
  async verifyAndCommit(bridge: RealFiBridge, operatorId: string, institutionId?: string) {
    const input = await this.verifySandboxAccount(operatorId, institutionId);
    return bridge.recordBankVerification(input);
  }
}

/**
 * Pure mapping: Plaid auth + balance responses → bridge bank-verification input.
 * Separated from the API client so it is unit-testable without sandbox creds.
 */
export function bankVerificationFromPlaid(
  operatorId: string,
  authData: { accounts?: Array<{ account_id: string }>; numbers?: { ach?: unknown[] } },
  balanceData: { accounts?: Array<{ balances?: { current?: number | null } }> },
  now: number = Math.floor(Date.now() / 1000),
): BankVerificationInput {
  const hasAccount = (authData.accounts?.length ?? 0) > 0;
  const hasAch = (authData.numbers?.ach?.length ?? 0) > 0;
  return {
    operator_id: operatorId,
    account_ownership_verified: hasAccount && hasAch,
    cashflow_report: { accounts: authData.accounts ?? [], ach_count: authData.numbers?.ach?.length ?? 0 },
    balance_snapshot: { balances: (balanceData.accounts ?? []).map((a) => a.balances?.current ?? null) },
    data_period_start: now - 30 * 24 * 60 * 60,
    data_period_end: now,
  };
}

export function plaidFromEnv(env: NodeJS.ProcessEnv = process.env): PlaidConnector | null {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) return null;
  return new PlaidConnector({
    clientId: env.PLAID_CLIENT_ID,
    secret: env.PLAID_SECRET,
    env: env.PLAID_ENV === "production" ? "production" : "sandbox",
  });
}

// CountryCode is part of Plaid's link flow; re-export so callers needn't import
// from the SDK directly when extending to Identity/Transactions products.
export { CountryCode };
