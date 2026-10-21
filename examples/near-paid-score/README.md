# NEAR paid-score consumer

This external-consumer example calls Cred402's public paid score, inspects
the initial x402 v2 `402 Payment Required` declaration, asks for an exact
interactive approval, signs and submits a native NEAR `Transfer` on NEAR
Testnet, retries the request, validates `PAYMENT-RESPONSE`, and confirms the
same receipt through both its public proof URL and the NEAR usage feed.

It defaults to:

```text
https://cred402-1.onrender.com/v1/x402/near/credit-score/EvidenceSellerAgent
```

Read the deployment's public configuration first. This is free and does not
touch a wallet:

```bash
curl -sS https://cred402-1.onrender.com/v1/x402/near/status
```

Copy the returned receiver and price into explicit client constraints:

```bash
export CRED402_NEAR_CLIENT_NETWORK=testnet
export CRED402_NEAR_EXPECTED_PAY_TO=cred402.testnet   # use the real pay_to from /status
export CRED402_NEAR_EXPECTED_PRICE_YOCTO=10000000000000000000000
export CRED402_NEAR_MAX_PRICE_YOCTO=10000000000000000000000
```

## Get a funded NEAR Testnet account (free, ~1 minute)

NEAR Testnet is free. Create an account at
[near-faucet.io](https://near-faucet.io) or with `near-cli`
(`npx near-cli create-account yourname.testnet --useFaucet`). Export its
account id and ed25519 secret key (`ed25519:...`) — never a mainnet key, and
never commit either value:

```bash
export CRED402_NEAR_CLIENT_ACCOUNT_ID=yourname.testnet
export CRED402_NEAR_CLIENT_PRIVATE_KEY=ed25519:YOUR_BASE58_SECRET_KEY
```

## Run it

From the Cred402 repository, `near-api-js` and the `@x402/core` header
codecs are already listed in the root `package.json`:

```bash
npx tsx examples/near-paid-score/typescript.ts
```

For a separate project, install `near-api-js` and `@x402/core`, then copy
`typescript.ts` into it.

The program stops before signing if the version, scheme, network, asset,
receiver, exact price, price ceiling, timeout, or URL differs from the
pinned policy. The key is read only after the displayed approval line is
typed exactly. A successful run ends with `receipt-verified` and the receipt
entry that also appears in the console's usage section.

Mainnet is disabled unless the endpoint is HTTPS and
`CRED402_ALLOW_MAINNET=true` is set in addition to the Mainnet network
choice. Cred402 never settles NEAR Mainnet payments without the operator's
explicit `CRED402_NEAR_MAINNET_RELEASE_ACK` — see `docs/near_x402.md`.
