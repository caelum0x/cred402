# Algorand paid-score consumers

These external-consumer examples call Cred402's public paid score, expose the
initial x402 v2 `402 Payment Required` declaration, ask for an exact interactive
approval, sign the payment, retry the request, validate `PAYMENT-RESPONSE`, and
confirm the same finalized receipt through both its public proof URL and the
Algorand usage feed.

They default to:

```text
https://cred402-1.onrender.com/v1/x402/credit-score/EvidenceSellerAgent
```

Read the deployment's public configuration first. This is free and does not
touch a wallet:

```bash
curl -sS https://cred402-1.onrender.com/v1/x402/algorand/status
```

Copy the returned receiver and price into explicit client constraints:

```bash
export CRED402_ALGORAND_CLIENT_NETWORK=testnet
export CRED402_ALGORAND_EXPECTED_PAY_TO=TRUSTED_58_CHARACTER_RECEIVER
export CRED402_ALGORAND_EXPECTED_PRICE_MICRO_USDC=10000
export CRED402_ALGORAND_MAX_PRICE_MICRO_USDC=10000
```

The payer must be funded and opted into the network's USDC ASA. Set a
base64-encoded 64-byte private key only in the terminal where you run the
example; never commit it or pass a mnemonic.

## TypeScript

From the Cred402 repository, the required x402 dependencies are already listed
in the root `package.json`:

```bash
export CRED402_ALGORAND_CLIENT_PRIVATE_KEY=BASE64_ENCODED_64_BYTE_PRIVATE_KEY
npx tsx examples/algorand-paid-score/typescript.ts
```

For a separate project, install `@x402/core`, `@x402/avm`, and `@x402/fetch`,
then copy `typescript.ts` into it.

## Python 3.10+

Install the official Algorand-enabled x402 package and its HTTP client extra:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install "x402-avm[avm,httpx]==2.0.2"
export CRED402_ALGORAND_CLIENT_PRIVATE_KEY=BASE64_ENCODED_64_BYTE_PRIVATE_KEY
python examples/algorand-paid-score/python.py
```

Both programs stop before signing if the version, scheme, network, USDC ASA,
receiver, exact price, price ceiling, timeout, URL, or challenge tag differs
from the pinned policy. The key is read only after the displayed approval line
is typed exactly. A successful run ends with `receipt-verified` and the receipt
entry that also appears in the console's **Verified endpoint usage** section.

Mainnet is disabled unless the endpoint is HTTPS and
`CRED402_ALLOW_MAINNET=true` is set in addition to the Mainnet network choice.
