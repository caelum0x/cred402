# Cred402 infrastructure

Production deployment artifacts for the API + console and the Go event indexer.

## Contents

```
Dockerfile             multi-stage image: builds the console, runs the API (tsx) as non-root, healthchecked
docker-compose.yml     local prod-like stack: api (durable journal) + indexer + postgres
helm/cred402/          Helm chart (deployment, service, ingress, hpa, pvc, secret-ref) — `helm lint` clean
terraform/             cloud-agnostic module: namespace + secret + helm_release onto any K8s cluster
```

## Run locally

```bash
export CRED402_ADMIN_API_KEY=$(openssl rand -hex 24)
docker compose -f infra/docker-compose.yml up --build
# API on :4021 (auth on), indexer writes /data/projections.json, postgres on :5432
```

## Deploy to Kubernetes

```bash
# 1. create the secret the chart references (or let Terraform do it)
kubectl create secret generic cred402-secrets \
  --from-literal=CRED402_ADMIN_API_KEY=... \
  --from-literal=CRED402_WEBHOOK_SECRET=...

# 2a. Helm directly
helm upgrade --install cred402 infra/helm/cred402 -n cred402 --create-namespace \
  --set image.tag=0.1.0 --set ingress.enabled=true --set ingress.host=api.example

# 2b. or via Terraform
cd infra/terraform
terraform init && terraform apply \
  -var admin_api_key=... -var webhook_secret=... -var environment=testnet
```

## Configuration

All runtime config is environment-driven and validated at boot
(`lib/gateway/config.ts`) — the API refuses to start on testnet/mainnet without
the required secrets. Liveness/readiness use `GET /v1/health`. State is persisted
to the `CRED402_DATA_DIR` volume as an append-only event journal the indexer
consumes.
