# Algorand x402 credit-score endpoint

Cred402's Algorand integration sells one useful, composable resource:

```text
GET /v1/x402/credit-score/:agentId
```

The endpoint returns the policy score, probability of default, risk band,
eligibility, reason codes, verified x402 revenue, and the model/policy provenance
used for the decision. It uses the same oracle and risk engine as the rest of
Cred402; the Algorand route is a payment and distribution layer, not a forked
scoring model.

## Configuration

```bash
# Required receiver account (never a mnemonic or private key)
export CRED402_ALGORAND_PAY_TO=YOUR_58_CHARACTER_ALGORAND_ADDRESS

# Start here
export CRED402_ALGORAND_NETWORK=testnet

# 0.01 USDC (USDC has six decimals)
export CRED402_ALGORAND_PRICE_MICRO_USDC=10000

export CRED402_ALGORAND_FACILITATOR_URL=https://facilitator.goplausible.xyz
# Optional only for local Testnet development; required as a stable HTTPS origin
# whenever NODE_ENV=production and on Mainnet.
export CRED402_PUBLIC_URL=https://api.example.com
npm run start
```

Without `CRED402_ALGORAND_PAY_TO`, the route returns `503` and does not issue a
payment challenge. Invalid addresses, networks, prices, and timeouts also fail
closed. Production requires pinned HTTPS origins for both the public API and the
facilitator, so reverse-proxy host headers cannot rewrite the advertised paid
resource. The facilitator timeout is capped at 60 seconds.

## Inspect the unpaid challenge

The seeded demo seller is `EvidenceSellerAgent`:

```bash
curl -i http://localhost:4021/v1/x402/credit-score/EvidenceSellerAgent
```

For a strict, payment-free check, pin the expected receiver and run:

```bash
export CRED402_ALGORAND_EXPECTED_PAY_TO="$CRED402_ALGORAND_PAY_TO"
npm run x402:algorand:check -- \
  http://localhost:4021/v1/x402/credit-score/EvidenceSellerAgent
```

The preflight rejects anything other than one x402 v2 `exact` offer for the
selected Algorand network and its official USDC ASA. It also enforces the exact
receiver and price, a hard price ceiling, matching resource URL, valid Bazaar
metadata, and the challenge tag. It never signs or submits a transaction.

## Check Testnet account readiness

Use only the payer's public address. This read-only command checks both sides at
the latest Algorand round: minimum ALGO balance, USDC ASA opt-in, freeze status,
and payer USDC balance. It does not read a private key or create a transaction.

```bash
export CRED402_ALGORAND_CLIENT_ADDRESS=YOUR_PAYER_PUBLIC_ADDRESS
npm run x402:algorand:ready -- \
  http://localhost:4021/v1/x402/credit-score/EvidenceSellerAgent
```

A fee buffer warning is advisory because the facilitator may sponsor payment
fees. Minimum-balance, asset opt-in, freeze, and payer USDC checks are mandatory.
Mainnet readiness also rejects payer/receiver self-payment; activation must come
from a genuine external user.

## Public deployment release gate

The free `GET /v1/x402/algorand/status` endpoint exposes only public deployment
metadata. It does not initialize the facilitator and never returns credentials.
After deploying staging, run the combined read-only gate:

```bash
npm run x402:algorand:release-check -- \
  https://staging.example.com/v1/x402/credit-score/EvidenceSellerAgent
```

This verifies that public status matches the live payment declaration, then runs
the Bazaar and payer/receiver account checks at the current Algorand round. A
passing result is the prerequisite for entering the separately confirmed payment
flow. Every pass writes a secret-free, machine-readable evidence record under
`artifacts/algorand-x402/` with an integrity digest. Set `CRED402_RELEASE_REF` to
the deployed commit SHA when the hosting platform does not expose one, or use
`--out=PATH` to choose a non-existing artifact path.

The response is `402 Payment Required`. Its `PAYMENT-REQUIRED` header is the
base64-encoded x402 v2 declaration and includes:

- Algorand Testnet CAIP-2 network and USDC ASA `10458941`
- `exact` payment scheme and the configured receiver
- Bazaar input/output schema
- `x402-global-challenge` resource tag

After a compatible client sends `PAYMENT-SIGNATURE`, Cred402 verifies through
the facilitator, computes the report, settles the payment, and returns the
transaction receipt in `PAYMENT-RESPONSE`.

## Explicitly approved Testnet payment

The payment client has no non-interactive confirmation bypass. It fetches and
validates the unpaid challenge first, prints the complete payment details, and
requires the exact displayed confirmation phrase before it reads the private key.
The same receiver/network/asset/price policy is applied again to the challenge
handled by the signing client.

```bash
export CRED402_ALGORAND_CLIENT_NETWORK=testnet
export CRED402_ALGORAND_EXPECTED_PAY_TO=YOUR_TRUSTED_RECEIVER
export CRED402_ALGORAND_EXPECTED_PRICE_MICRO_USDC=10000
export CRED402_ALGORAND_MAX_PRICE_MICRO_USDC=10000
export CRED402_ALGORAND_CLIENT_PRIVATE_KEY=BASE64_ENCODED_64_BYTE_PRIVATE_KEY

npm run x402:algorand:pay -- --pay \
  https://staging.example.com/v1/x402/credit-score/EvidenceSellerAgent
```

Both payer and receiver must be funded with Testnet ALGO and opted into Testnet
USDC ASA `10458941`; the payer also needs sufficient Testnet USDC. Do not paste a
mnemonic into these variables. Mainnet additionally requires `--mainnet`, an
HTTPS endpoint, the Mainnet USDC ASA, and an exact confirmation containing the
full receiver address.

## Mainnet release checklist

1. Complete the Testnet payment flow against the public HTTPS deployment.
2. Confirm the receiving account is opted into Mainnet USDC ASA `31566704`.
3. Set `CRED402_ALGORAND_NETWORK=mainnet` and `CRED402_PUBLIC_URL` to the public
   HTTPS origin; do not change the endpoint path or schema.
4. Make one real external Mainnet payment and confirm USDC arrives at the receiver.
5. Confirm the resource is visible through the facilitator's Bazaar discovery.
6. Record the public endpoint, transaction ID, repository, and demo for submission.

Do not create synthetic/self-payment volume. One genuine end-to-end payment is
more useful than fabricated traffic and is enough to prove settlement.
