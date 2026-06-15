/**
 * Jurisdiction policy (p2 §7.9).
 *
 * Decides whether an operator's jurisdiction is permitted to receive credit and,
 * per RWA category, whether the asset class is allowed there. Policy is data —
 * an allowlist/blocklist plus per-category rules — so governance can update it
 * without code changes. This is a TECHNICAL adapter, not legal advice: real
 * operating jurisdictions must be set by counsel (p6 §603).
 */

export interface JurisdictionRule {
  /** If non-empty, ONLY these jurisdictions may borrow (allowlist). */
  lendingAllowlist: Set<string>;
  /** Jurisdictions explicitly blocked from borrowing. */
  lendingBlocklist: Set<string>;
  /** Per-RWA-category blocklist of jurisdictions (e.g. carbon credits banned in X). */
  categoryBlocklist: Record<string, Set<string>>;
}

export interface JurisdictionDecision {
  allowed: boolean;
  reason?: string;
}

export const DEFAULT_JURISDICTION_RULE: JurisdictionRule = {
  // Empty allowlist = allow-all-except-blocked (sensible default for testnet).
  lendingAllowlist: new Set(),
  lendingBlocklist: new Set(),
  categoryBlocklist: {},
};

export class JurisdictionPolicy {
  constructor(private readonly rule: JurisdictionRule = DEFAULT_JURISDICTION_RULE) {}

  /** May an operator in `code` borrow at all? */
  canLend(code: string): JurisdictionDecision {
    const c = code.toUpperCase();
    if (this.rule.lendingBlocklist.has(c)) return { allowed: false, reason: `lending blocked in ${c}` };
    if (this.rule.lendingAllowlist.size > 0 && !this.rule.lendingAllowlist.has(c)) {
      return { allowed: false, reason: `lending not licensed in ${c}` };
    }
    return { allowed: true };
  }

  /** Is `category` permitted for an operator in `code`? */
  canServiceCategory(code: string, category: string): JurisdictionDecision {
    const blocked = this.rule.categoryBlocklist[category];
    if (blocked?.has(code.toUpperCase())) {
      return { allowed: false, reason: `${category} not permitted in ${code}` };
    }
    return { allowed: true };
  }
}
