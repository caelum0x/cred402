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
export CRED402_ALGORAND_INDEXER_URL=https://testnet-idx.algonode.cloud
export CRED402_ALGORAND_MIN_FINALITY_ROUNDS=4
export CRED402_DATA_DIR=/var/lib/cred402
# Optional only for local Testnet development; required as a stable HTTPS origin
# whenever NODE_ENV=production and on Mainnet.
export CRED402_PUBLIC_URL=https://api.example.com
npm run start
```

Without `CRED402_ALGORAND_PAY_TO`, the route returns `503` and does not issue a
payment challenge. Invalid addresses, networks, prices, and timeouts also fail
closed. Production requires pinned HTTPS origins for both the public API and the
facilitator, so reverse-proxy host headers cannot rewrite the advertised paid
resource. The facilitator timeout is capped at 60 seconds. Production and
Mainnet also require durable storage, so a restart cannot erase the replay
barrier or the public receipt projection.

## Inspect the unpaid challenge

Use an agent ID returned by the production API or another ID you intend to
query:

```bash
export CRED402_AGENT_ID=YOUR_AGENT_ID
curl -i "http://localhost:4021/v1/x402/credit-score/$CRED402_AGENT_ID"
```

For a strict, payment-free check, pin the expected receiver and run:

```bash
export CRED402_ALGORAND_EXPECTED_PAY_TO="$CRED402_ALGORAND_PAY_TO"
npm run x402:algorand:check -- \
  "http://localhost:4021/v1/x402/credit-score/$CRED402_AGENT_ID"
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
  "http://localhost:4021/v1/x402/credit-score/$CRED402_AGENT_ID"
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
  "https://staging.example.com/v1/x402/credit-score/$CRED402_AGENT_ID"
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
the facilitator, atomically claims a durable digest of that proof, computes the
report, and settles exactly once. The raw payment signature is never persisted.
An exact retry replays the stored resource response; reuse against another URL
is rejected. If the facilitator times out, the response includes an opaque
payment-attempt URL and explicitly tells the payer not to pay again.

Facilitator success creates a provisional Casper receipt. Cred402 independently
reads `GET /v2/transactions/{txid}` from the pinned Algorand Indexer and checks
the transaction id, sender, receiver, ASA, amount, confirmed round, and minimum
confirmation depth. Only then is the receipt finalized and allowed into revenue
or reputation signals. Mismatches and repeatedly missing transactions move to
refund review instead of being counted.

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
  "https://staging.example.com/v1/x402/credit-score/$CRED402_AGENT_ID"
```

Both payer and receiver must be funded with Testnet ALGO and opted into Testnet
USDC ASA `10458941`; the payer also needs sufficient Testnet USDC. Do not paste a
mnemonic into these variables. Mainnet additionally requires `--mainnet`, an
HTTPS endpoint, the Mainnet USDC ASA, and an exact confirmation containing the
full receiver address.

## External TypeScript and Python consumers

[`examples/algorand-paid-score/`](../examples/algorand-paid-score/) contains
standalone buyer examples for both languages. They default to the public
Cred402 API and make every protocol boundary visible:

1. issue an unsigned request and print the decoded `PAYMENT-REQUIRED` response;
2. validate x402 version, exact scheme, network, USDC ASA, receiver, price,
   ceiling, timeout, resource URL, and challenge tag;
3. require an exact interactive approval before reading a private key;
4. sign and retry with the official Algorand x402 client;
5. decode `PAYMENT-RESPONSE` and match its transaction to the paid report;
6. follow the opaque payment-attempt URL until independent finality is confirmed;
7. validate the content-addressed, finalized receipt proof; and
8. find the same receipt id in `GET /v1/x402/algorand/usage`.

## Browser operator path

The console's dedicated **Algorand x402** tab does not depend on `/api/state`.
An operator can type any agent ID; IDs returned by `/api/state` remain optional
input suggestions. The screen reads deployment metadata from
`GET /v1/x402/algorand/status` and finalized usage from
`GET /v1/x402/algorand/usage`. Each resource has its own loading, error, empty,
success, and retry path. Finalized usage also has a manual receipt refresh.
The production surface is the **Algorand x402** tab in the
[Cred402 console](https://cred402.vercel.app); the public
[status](https://cred402-1.onrender.com/v1/x402/algorand/status) and
[usage](https://cred402-1.onrender.com/v1/x402/algorand/usage) resources remain
directly inspectable.

The unpaid request exposes the response body and decodes the actual
`PAYMENT-REQUIRED` header in the browser. The terminal handoff remains blocked
until the header passes all of these checks against public status:

- x402 v2 and exactly one `exact` option;
- Algorand network and official USDC ASA;
- receiver and exact micro-USDC amount;
- paid resource URL; and
- `x402-global-challenge` resource tag.

This inspection is display-only. The browser never reads a private key, signs a
payload, or pays. Use the TypeScript or Python terminal client for approval,
signing, payment retry, settlement, proof validation, and finalized usage
confirmation. Zero usage means the usage API measured no finalized receipts;
an unavailable usage endpoint is reported as an error instead.

## Mainnet release checklist

1. Complete the Testnet payment flow against the public HTTPS deployment.
2. Confirm the receiving account is opted into Mainnet USDC ASA `31566704`.
3. Mount a persistent volume and set `CRED402_DATA_DIR` to that mount.
4. Pin an HTTPS Mainnet Indexer with `CRED402_ALGORAND_INDEXER_URL` and choose the
   minimum finality rounds explicitly.
5. Set `CRED402_ENV=mainnet`, `CRED402_ALGORAND_NETWORK=mainnet`, and
   `CRED402_PUBLIC_URL` to the public HTTPS origin.
6. Set `CRED402_ALGORAND_MAINNET_RELEASE_ACK` exactly to
   `I_ACKNOWLEDGE_REAL_USDC_MAINNET_PAYMENTS` as the final deployment gate.
7. Make one real external Mainnet payment and confirm USDC arrives at the receiver.
8. Confirm the attempt reaches `confirmed`, the receipt reaches `finalized`, and
   the resource is visible through the facilitator's Bazaar discovery.
9. Record the public endpoint, transaction ID, repository, and finalized proof.

The operator endpoint `GET /v1/x402/algorand/payments/:attemptId` exposes only
coarse lifecycle, transaction, confirmation count, refund state, and public proof
URL. It never returns the paid report, payer identity, raw signature, or proof
digest.

Refund review never submits an on-chain transaction. Operators first inspect the
durable queue with `npm run x402:algorand:refunds`, execute and verify the refund
through the approved treasury workflow, then record its Algorand transaction:

```bash
npm run x402:algorand:refunds -- \
  --complete=pay_OPAQUE_ATTEMPT_ID \
  --refund-transaction=ALGORAND_REFUND_TX_ID \
  --confirm="REFUND_RECORDED pay_OPAQUE_ATTEMPT_ID ALGORAND_REFUND_TX_ID"
```

The exact confirmation prevents an accidental bookkeeping close. Recording a
refund does not sign, broadcast, or repeat a payment.

Do not create synthetic/self-payment volume. One genuine end-to-end payment is
more useful than fabricated traffic and is enough to prove settlement.
