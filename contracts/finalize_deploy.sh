#!/usr/bin/env bash
cd "$(dirname "$0")"
# 1) wait for batch 2
until ! pgrep -f "deploy_all_testnet.sh" >/dev/null 2>&1; do sleep 15; done
sleep 3
# 2) deploy the remaining 5 (skips any already in deploys.addresses.txt is not handled; these are new)
bash deploy_all_testnet.sh \
  slashing_vault:SlashingVault:450 \
  governance:Governance:450 \
  fiat_receipt_registry:FiatReceiptRegistry:350 \
  operator_verification_registry:OperatorVerificationRegistry:350 \
  realfi_attestation_registry:RealFiAttestationRegistry:350
# 3) generate deploys.testnet.json from the address list
python3 - <<'PY'
import json, time
contracts=[]
for line in open("../deploys.addresses.txt"):
    p=line.split()
    if len(p)>=3: contracts.append({"crate":p[0],"name":p[1],"contract_hash":p[2],"status":"installed"})
out={"chain":"casper-test","mode":"live","node":"https://node.testnet.casper.network/rpc",
     "deployer":"01327e5eb67b5d4271072d879bb012fac4fde2ee8592fbc7167d333ab7f4961ae9",
     "explorer":"https://testnet.cspr.live","deployed_at":time.strftime("%Y-%m-%dT%H:%M:%SZ"),
     "contracts":contracts}
json.dump(out, open("../deploys.testnet.json","w"), indent=2)
print("wrote deploys.testnet.json with", len(contracts), "contracts")
PY
echo "DONE"
