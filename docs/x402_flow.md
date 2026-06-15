# x402 flow

Cred402 implements the HTTP-native x402 machine-to-machine payment flow end to end.
It is a **real** flow: actual `402` responses, actual ed25519 signatures, actual
verification. Only the underlying RWA data source is mocked.

## Sequence

```
BuyerAgent                         EvidenceSellerAgent (paid endpoint)
    │                                         │
    │  GET /verify/energy_output?rwa_id=...   │
    ├────────────────────────────────────────▶
    │                                         │  no X-Payment header
    │     402 Payment Required                │
    │     X-Payment-Amount: 0.002             │
    │     X-Payment-Network: casper           │
    │     { challenge: PaymentChallenge }     │
    ◀────────────────────────────────────────┤
    │                                         │
    │  sign domain-separated authorization    │
    │  (casper-eip-712 style) with ed25519    │
    │                                         │
    │  GET /verify/... + X-Payment: <b64>     │
    ├────────────────────────────────────────▶
    │                                         │  verify signature + challenge
    │                                         │  record Receipt on Casper
    │                                         │  submit Evidence hash
    │     200 OK { report, receipt_id }       │
    ◀────────────────────────────────────────┤
```

## The signed authorization (casper-eip-712 style)

```jsonc
{
  "domain":   { "name": "Cred402", "version": "1", "network": "casper-testnet" },
  "payment_id": "pay-…",
  "payer_agent": "RWARequestAgent",
  "seller_agent": "EvidenceSellerAgent",
  "service_type": "solar_output_verification",
  "amount_motes": "2000000",
  "resource": "/verify/energy_output?rwa_id=SOLAR-A17",
  "nonce": "nonce-…"
}
```

The buyer signs the canonical (sorted-key) JSON of this object with its ed25519
private key. The seller verifies the signature against the payer's `01`+hex public
key carried in the proof, and checks every field against the challenge it issued.
The `payment_proof_hash = blake2b256(proof)` is what gets committed on-chain in the
`X402ReceiptRegistry`, making the payment auditable without revealing the signature.

## Try it live

```bash
npm run start                                   # terminal 1
curl -i "http://localhost:4021/verify/energy_output?rwa_id=SOLAR-A17"   # see the 402
npx tsx scripts/x402_client.ts energy_output    # full 402 -> sign -> 200
```

## Receipt commitment

```
receipt_id, payer_agent, seller_agent, service_type, amount, timestamp,
rwa_reference_hash, result_hash, payment_proof_hash, dispute_window,
status: pending | settled | disputed | finalized
```

A receipt moves `pending → settled` (buyer confirms delivery) → `finalized` (after
the dispute window, evidence verified). A failed cross-check moves it to `disputed`.
