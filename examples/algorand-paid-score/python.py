"""Pay for a Cred402 score with Algorand x402 v2, then verify its receipt."""

from __future__ import annotations

import base64
import json
import os
import sys
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from algosdk import encoding
from x402 import x402Client
from x402.http import (
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    decode_payment_required_header,
    decode_payment_response_header,
    encode_payment_signature_header,
)
from x402.mechanisms.avm.exact import register_exact_avm_client

TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="
MAINNET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="
USDC = {"testnet": 10_458_941, "mainnet": 31_566_704}


def require(value: Any, message: str) -> None:
    if not value:
        raise RuntimeError(message)


class PrivateKeySigner:
    """Official ClientAvmSigner shape for a base64-encoded 64-byte Algorand key."""

    def __init__(self, private_key_b64: str) -> None:
        secret = base64.b64decode(private_key_b64)
        if len(secret) != 64:
            raise ValueError(f"Expected a 64-byte Algorand private key; received {len(secret)} bytes")
        self._address = encoding.encode_address(secret[32:])
        self._signing_key = base64.b64encode(secret).decode()

    @property
    def address(self) -> str:
        return self._address

    def sign_transactions(
        self, unsigned_txns: list[bytes], indexes_to_sign: list[int]
    ) -> list[bytes | None]:
        signed: list[bytes | None] = []
        for index, raw_txn in enumerate(unsigned_txns):
            if index not in indexes_to_sign:
                signed.append(None)
                continue
            txn = encoding.msgpack_decode(base64.b64encode(raw_txn).decode())
            signed_txn = txn.sign(self._signing_key)
            signed.append(base64.b64decode(encoding.msgpack_encode(signed_txn)))
        return signed


def decoded_header_json(encoded: str) -> dict[str, Any]:
    padding = "=" * (-len(encoded) % 4)
    return json.loads(base64.urlsafe_b64decode(encoded + padding))


def model_dict(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True)
    if isinstance(value, dict):
        return value
    raise TypeError(f"Expected an x402 model or dict; received {type(value).__name__}")


async def main() -> None:
    network_name = "mainnet" if os.getenv("CRED402_ALGORAND_CLIENT_NETWORK") == "mainnet" else "testnet"
    expected_network = MAINNET if network_name == "mainnet" else TESTNET
    expected_asset = USDC[network_name]
    endpoint = os.getenv(
        "CRED402_ALGORAND_CLIENT_URL",
        "https://cred402-1.onrender.com/v1/x402/credit-score/EvidenceSellerAgent",
    )
    expected_pay_to = os.getenv("CRED402_ALGORAND_EXPECTED_PAY_TO", "").strip()
    expected_amount = os.getenv("CRED402_ALGORAND_EXPECTED_PRICE_MICRO_USDC", "10000")
    max_amount = os.getenv("CRED402_ALGORAND_MAX_PRICE_MICRO_USDC", expected_amount)
    parsed_endpoint = urlparse(endpoint)

    require(expected_pay_to, "Set CRED402_ALGORAND_EXPECTED_PAY_TO to the trusted receiver")
    require(parsed_endpoint.scheme in {"http", "https"} and parsed_endpoint.netloc, "Endpoint must be absolute HTTP(S)")
    require(network_name != "mainnet" or parsed_endpoint.scheme == "https", "Mainnet requires HTTPS")
    require(
        network_name != "mainnet" or os.getenv("CRED402_ALLOW_MAINNET") == "true",
        "Mainnet requires CRED402_ALLOW_MAINNET=true",
    )

    async with httpx.AsyncClient(follow_redirects=False, timeout=60) as http:
        # 1. The first request is deliberately unpaid. The private key is not read.
        unpaid = await http.get(endpoint, headers={"Accept": "application/json"})
        require(unpaid.status_code == 402, f"Expected HTTP 402; received {unpaid.status_code}")
        encoded_challenge = unpaid.headers.get(PAYMENT_REQUIRED_HEADER)
        require(encoded_challenge, "402 response is missing PAYMENT-REQUIRED")
        raw_challenge = decoded_header_json(encoded_challenge)
        accepts = raw_challenge.get("accepts", [])
        require(raw_challenge.get("x402Version") == 2, "Expected x402 v2")
        require(len(accepts) == 1, f"Expected one payment option; received {len(accepts)}")
        selected = accepts[0]
        require(selected.get("scheme") == "exact", f"Unexpected scheme: {selected.get('scheme')}")
        require(selected.get("network") == expected_network, f"Unexpected network: {selected.get('network')}")
        require(selected.get("asset") == expected_asset, f"Unexpected USDC ASA: {selected.get('asset')}")
        require(selected.get("payTo") == expected_pay_to, f"Unexpected receiver: {selected.get('payTo')}")
        amount = str(selected.get("amount", ""))
        require(amount.isdigit() and int(amount) > 0, "Payment amount must be a positive integer")
        require(amount == expected_amount, f"Unexpected amount: {amount} micro-USDC")
        require(int(amount) <= int(max_amount), f"Amount exceeds ceiling: {amount}")
        timeout = selected.get("maxTimeoutSeconds")
        require(isinstance(timeout, int) and 0 < timeout <= 300, f"Unsafe timeout: {timeout}")
        resource = raw_challenge.get("resource", {})
        require(resource.get("url") == endpoint, "Challenge resource URL changed")
        require("x402-global-challenge" in resource.get("tags", []), "Challenge tag is missing")
        print("payment-required", json.dumps(raw_challenge, indent=2))

        phrase = f"PAY {amount} MICRO-USDC ON ALGORAND {network_name.upper()} TO {expected_pay_to}"
        require(sys.stdin.isatty() and sys.stdout.isatty(), "Payment approval requires an interactive terminal")
        entered = input(f"Type this exact line to approve:\n{phrase}\n> ")
        require(entered == phrase, "Approval did not match; payment cancelled")

        # 2. Read the key only after approval, sign the inspected challenge, and retry.
        private_key = os.getenv("CRED402_ALGORAND_CLIENT_PRIVATE_KEY", "").strip()
        require(private_key, "Set CRED402_ALGORAND_CLIENT_PRIVATE_KEY after approving the payment")
        signer = PrivateKeySigner(private_key)
        client = x402Client()
        register_exact_avm_client(client, signer)
        challenge = decode_payment_required_header(encoded_challenge)
        payload = await client.create_payment_payload(challenge)
        signature = encode_payment_signature_header(payload)
        paid = await http.get(
            endpoint,
            headers={"Accept": "application/json", PAYMENT_SIGNATURE_HEADER: signature},
        )
        require(paid.is_success, f"Paid retry returned HTTP {paid.status_code}: {paid.text[:500]}")
        report = paid.json()

        # 3. Validate the official settlement header and Cred402 paid response.
        encoded_settlement = paid.headers.get(PAYMENT_RESPONSE_HEADER)
        require(encoded_settlement, "Paid response is missing PAYMENT-RESPONSE")
        settlement = model_dict(decode_payment_response_header(encoded_settlement))
        require(settlement.get("success") is True, f"Settlement failed: {settlement}")
        payment = report.get("payment", {})
        require(payment.get("transaction") == settlement.get("transaction"), "Report and settlement transactions differ")
        require(payment.get("network") == settlement.get("network"), "Report and settlement networks differ")
        require(payment.get("external_receipt_id"), "Paid report is missing external_receipt_id")
        require(payment.get("external_receipt_url"), "Paid report is missing external_receipt_url")
        require(payment.get("casper_anchor_status") == "finalized", "Cred402 receipt is not finalized")

        # 4. Validate the content-addressed proof and find the same receipt in usage.
        proof_response = await http.get(payment["external_receipt_url"])
        require(proof_response.is_success, f"Receipt proof returned HTTP {proof_response.status_code}")
        proof = proof_response.json()
        require(proof.get("receipt_id") == payment["external_receipt_id"], "Receipt proof id differs from report")
        require(proof.get("integrity", {}).get("ok") is True, "Receipt proof integrity check failed")
        require(proof.get("anchor", {}).get("status") == "finalized", "Receipt proof is not finalized")
        require(proof.get("settlement", {}).get("transaction") == settlement.get("transaction"), "Receipt transaction differs")

        usage_url = urljoin(endpoint, "/v1/x402/algorand/usage")
        usage_response = await http.get(usage_url)
        require(usage_response.is_success, f"Usage endpoint returned HTTP {usage_response.status_code}")
        usage = usage_response.json()
        usage_receipt = next(
            (item for item in usage.get("latest_receipts", []) if item.get("receipt_id") == proof["receipt_id"]),
            None,
        )
        require(usage_receipt, f"Receipt {proof['receipt_id']} was not found in {usage_url}")

    print("payment-proof", json.dumps(settlement, indent=2))
    print("paid-score", json.dumps(report, indent=2))
    print("receipt-verified", json.dumps({"proof": proof, "usage_receipt": usage_receipt}, indent=2))


if __name__ == "__main__":
    import asyncio

    try:
        asyncio.run(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
