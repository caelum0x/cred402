/**
 * Global x402 Challenge attribution tag.
 *
 * The GoPlausible facilitator writes challenge attribution at settlement time from the
 * accepted payment option's `extra.tag`. It does not persist the x402 `resource.tags`
 * array into its Bazaar record, and it never reclassifies payments that settled before
 * the tag was present. A resource missing this tag still settles and still appears in
 * the Bazaar, but its volume is filed under `direct`/`dev` and never reaches the
 * challenge leaderboard.
 *
 * Kept in its own module so the resource server (which advertises it) and the payment
 * client (which verifies it) cannot drift apart.
 */
export const X402_CHALLENGE_TAG = "x402-global-challenge";
