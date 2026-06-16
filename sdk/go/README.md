# cred402 Go SDK + CLI

A production Go SDK and command-line client for the **Cred402** protocol —
credit lines for autonomous RWA agents on Casper, where x402 machine-to-machine
revenue becomes on-chain reputation and DeFi credit.

- Module: `github.com/cred402/go-sdk`
- Standard library only (`net/http`, `encoding/json`, `math/big`, `text/tabwriter`) — **no external dependencies**
- Go 1.24+

It wraps both API surfaces:

- The versioned **`/v1`** gateway — envelope responses
  (`{"success":bool,"data":...,"request_id":string}`), scoped API-key auth
  (`Authorization: Bearer <key>` or `X-Api-Key`), and `Idempotency-Key` on
  mutations.
- The raw **`/api`** console routes — no envelope (e.g. `/api/demo/run`).

The SDK's `do()` helper transparently detects and unwraps the envelope, decodes
raw responses directly, and returns a typed `*cred402.APIError` (with
`StatusCode`, `Code`, `Message`, `RequestID`) on any failure.

## Install

```bash
cd sdk/go
go build ./...
go install ./cmd/cred402   # installs the `cred402` binary into $GOBIN
```

## CLI

```
cred402 [global flags] <command> [args...]

Global flags:
  -api <url>   API base URL (default http://localhost:4021)
  -key <key>   API key (Bearer); falls back to $CRED402_API_KEY
  -json        emit raw JSON instead of formatted tables

Commands:
  agents list                          list registered agents
  agents get <id>                      show one agent
  agents register <id> <service_type>  register a new agent
  credit pool                          show credit pool state
  credit explain <id>                  explain an agent's credit decision
  credit draw <id> <cspr>              draw against a credit line
  credit repay <id> <cspr>             repay a credit line
  market                               list marketplace listings
  economics                            show protocol economics
  realfi verify-operator <op> <jur>    verify a RealFi operator
  compliance <id>                      run a compliance screen
  demo run                             run the end-to-end demo flow
  health                               gateway health check
```

`service_type` must be one of: `solar_output_verification`, `weather_risk`,
`receivable_quality`, `risk_scoring`, `treasury_routing`, `monitoring`.

The CLI exits `0` on success, `3` on a validation error, `4` on a not-found
error, and `1` otherwise.

### Examples

```bash
# Start the API first (from the repo root): npm start

cred402 agents list
cred402 agents get EvidenceSellerAgent
cred402 credit explain EvidenceSellerAgent
cred402 credit pool
cred402 credit draw EvidenceSellerAgent 2
cred402 credit repay EvidenceSellerAgent 1
cred402 market
cred402 economics
cred402 compliance EvidenceSellerAgent
cred402 realfi verify-operator acme.operator US
cred402 demo run

# Raw JSON for any command:
cred402 -json agents get EvidenceSellerAgent

# Against a remote host with an API key:
cred402 -api https://api.cred402.example -key sk_live_xxx agents list
```

Example output:

```
$ cred402 agents list
AGENT                SERVICE                    REPUTATION  CREDIT  JOBS  STAKE (CSPR)  ACTIVE
RWARequestAgent      risk_scoring               70          0       0     0             true
EvidenceSellerAgent  solar_output_verification  92          93      415   50            true
```

## SDK usage

```go
package main

import (
	"context"
	"fmt"
	"log"

	"github.com/cred402/go-sdk/cred402"
)

func main() {
	c := cred402.New("http://localhost:4021", cred402.WithAPIKey("sk_live_xxx"))
	ctx := context.Background()

	agents, err := c.ListAgents(ctx)
	if err != nil {
		log.Fatal(err)
	}
	for _, a := range agents {
		fmt.Printf("%s: credit_score=%.0f stake=%.0f CSPR\n",
			a.AgentID, a.CreditScore, a.Stake.CSPR())
	}

	// Explain a credit decision.
	exp, err := c.ExplainCredit(ctx, "EvidenceSellerAgent")
	if err != nil {
		var apiErr *cred402.APIError
		if e, ok := err.(*cred402.APIError); ok && e.IsNotFound() {
			log.Fatal("agent not found")
		}
		_ = apiErr
		log.Fatal(err)
	}
	fmt.Printf("eligible=%v line=%.2f CSPR\n",
		exp.Eligible, exp.Decision.CreditLine.CSPR())

	// Mutations take an idempotency key (pass "" to skip).
	line, err := c.DrawCredit(ctx, "EvidenceSellerAgent", 2.0, "draw-001")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("drawn=%.2f CSPR health=%d bps\n",
		line.Drawn.CSPR(), line.HealthFactorBps)
}
```

### Methods

| Method | Endpoint |
| --- | --- |
| `Health` | `GET /v1/health` |
| `ListAgents` | `GET /v1/agents` |
| `GetAgent` | `GET /v1/agents/:id` |
| `GetPassport` | `GET /v1/agents/:id/passport` |
| `GetCreditLine` | `GET /v1/agents/:id/credit-line` |
| `ExplainCredit` | `GET /v1/agents/:id/credit-explain` |
| `RegisterAgent` | `POST /v1/agents` |
| `CreditPool` | `GET /v1/credit/pool` |
| `OpenCreditLine` | `POST /v1/credit/lines` |
| `DrawCredit` | `POST /v1/credit/lines/:id/draw` |
| `RepayCredit` | `POST /v1/credit/lines/:id/repay` |
| `Marketplace` | `GET /v1/marketplace` |
| `Economics` | `GET /v1/economics` |
| `ScreenCompliance` | `GET /v1/compliance/agents/:id` |
| `RealfiState` | `GET /v1/realfi` |
| `VerifyOperator` | `POST /v1/realfi/operators` |
| `RecordFiatReceipt` | `POST /v1/realfi/fiat-receipts` |
| `OpenDispute` | `POST /v1/disputes` |
| `CreateAPIKey` | `POST /v1/admin/api-keys` (admin scope) |
| `SubscribeWebhook` | `POST /v1/webhooks` (admin scope) |
| `RunDemo` | `POST /api/demo/run` (raw) |
| `RunRealfiDemo` | `POST /api/demo/realfi` (raw) |

### The `Motes` type

CSPR amounts are integer **motes** (1 CSPR = 1e9 motes). The API encodes them
as decimal strings to avoid float precision loss. `cred402.Motes` wraps a
`*big.Int`, unmarshals from a JSON string (or number), and provides:

```go
m, _ := cred402.MotesFromString("50000000000")
m.String() // "50000000000"
m.CSPR()    // 50  (float64, display convenience)
```

> Note: the `/v1/credit/lines/:id/draw` and `/repay` routes accept
> `amount_cspr` as a **number in whole CSPR** (not motes). `DrawCredit` and
> `RepayCredit` take a `float64` CSPR amount accordingly.

## Verification

```bash
cd sdk/go
go build ./...   # clean
go vet ./...     # clean

# Against the live API (from repo root: npm start):
go build -o /tmp/cred402cli ./cmd/cred402
/tmp/cred402cli demo run
/tmp/cred402cli agents list
/tmp/cred402cli credit explain EvidenceSellerAgent
```
