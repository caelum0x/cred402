# Cred402 Rust SDK + CLI

A real blocking HTTP client (ureq + serde) for the Cred402 protocol, plus a
`cred402` CLI. Talks to the production `/v1` surface (envelope, bearer auth,
idempotency) and the raw `/api` routes.

## Library

```rust
use cred402::{Client, types::motes_to_cspr};

let c = Client::new("http://localhost:4021").with_api_key("c402_...");
let explain = c.explain_credit("EvidenceSellerAgent")?;
let line = explain["decision"]["credit_line"].as_str().unwrap_or("0");
println!("credit line: {:.2} CSPR", motes_to_cspr(line));
```

Methods: `health`, `list_agents`, `get_agent`, `credit_pool`, `explain_credit`,
`marketplace`, `economics`, `analytics`, `search`, `screen_compliance`,
`register_agent`, `open_credit_line`, `draw_credit`, `repay_credit`,
`verify_operator`, `run_demo`.

## CLI

```bash
cargo build
./target/debug/cred402 demo          # seed live data
./target/debug/cred402 analytics     # protocol dashboard
./target/debug/cred402 agents
./target/debug/cred402 explain EvidenceSellerAgent
./target/debug/cred402 --api http://host:4021 --key c402_... market
```

`cargo build` is clean.
