import { createHash } from "node:crypto";

/**
 * Sanctions screening (p2 §7.9, p6 §603).
 *
 * List-based screening of operators, agents and jurisdictions against denylists
 * (OFAC-style). Designed as a policy HOOK: the lists are injected, so production
 * can wire a real provider (e.g. a sanctions API) behind the same interface. We
 * match on a normalized form and on a salted hash, so a denylist of hashed
 * identifiers can be screened without holding raw PII.
 */

export interface SanctionsLists {
  /** Sanctioned jurisdiction codes (ISO 3166 alpha-2), e.g. comprehensively embargoed. */
  jurisdictions: Set<string>;
  /** Denylisted subject ids (operator/agent ids), normalized lowercase. */
  subjects: Set<string>;
  /** Denylisted subject id hashes (sha256 of a salted id), for PII-free lists. */
  subjectHashes: Set<string>;
}

export interface SanctionsHit {
  matched: boolean;
  reason?: string;
}

/** A conservative default embargo list (illustrative — production injects the real list). */
export const DEFAULT_SANCTIONED_JURISDICTIONS = new Set(["KP", "IR", "SY", "CU"]);

export class SanctionsScreener {
  private readonly lists: SanctionsLists;

  constructor(
    lists: Partial<SanctionsLists> = {},
    private readonly salt = "cred402:sanctions",
  ) {
    this.lists = {
      jurisdictions: lists.jurisdictions ?? new Set(DEFAULT_SANCTIONED_JURISDICTIONS),
      subjects: lists.subjects ?? new Set(),
      subjectHashes: lists.subjectHashes ?? new Set(),
    };
  }

  /** Add a subject to the denylist (e.g. after a confirmed dispute / law-enforcement notice). */
  denySubject(id: string): void {
    this.lists.subjects.add(id.trim().toLowerCase());
  }

  screenJurisdiction(code: string): SanctionsHit {
    if (this.lists.jurisdictions.has(code.toUpperCase())) {
      return { matched: true, reason: `jurisdiction ${code} is sanctioned` };
    }
    return { matched: false };
  }

  screenSubject(id: string): SanctionsHit {
    const norm = id.trim().toLowerCase();
    if (this.lists.subjects.has(norm)) return { matched: true, reason: `subject ${id} is denylisted` };
    const h = createHash("sha256").update(`${this.salt}:${norm}`).digest("hex");
    if (this.lists.subjectHashes.has(h)) return { matched: true, reason: `subject ${id} matches a denylisted hash` };
    return { matched: false };
  }
}
