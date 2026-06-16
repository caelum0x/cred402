//! Cred402 Rust SDK.
//!
//! A real blocking HTTP client for the Cred402 protocol API. Talks to both the
//! production `/v1` surface (envelope `{success,data,request_id}`, bearer auth,
//! idempotency) and the raw `/api` routes. No mocks — every call hits the server.
//!
//! ```no_run
//! use cred402::Client;
//! let c = Client::new("http://localhost:4021").with_api_key("c402_...");
//! let agents = c.list_agents().unwrap();
//! println!("{} agents", agents.as_array().map(|a| a.len()).unwrap_or(0));
//! ```

pub mod error;
pub mod types;

pub use error::Cred402Error;

use serde_json::{json, Value};

/// A Cred402 API client.
pub struct Client {
    base_url: String,
    api_key: Option<String>,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(base_url: impl Into<String>) -> Self {
        Client {
            base_url: trim_slash(base_url.into()),
            api_key: None,
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(20))
                .build(),
        }
    }

    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    // -- HTTP plumbing ------------------------------------------------------

    fn get(&self, path: &str) -> Result<Value, Cred402Error> {
        let mut req = self.agent.get(&format!("{}{}", self.base_url, path));
        if let Some(k) = &self.api_key {
            req = req.set("Authorization", &format!("Bearer {}", k));
        }
        Self::handle(req.call())
    }

    fn post(&self, path: &str, body: Value, idem: Option<&str>) -> Result<Value, Cred402Error> {
        let mut req = self
            .agent
            .post(&format!("{}{}", self.base_url, path))
            .set("Content-Type", "application/json");
        if let Some(k) = &self.api_key {
            req = req.set("Authorization", &format!("Bearer {}", k));
        }
        if let Some(i) = idem {
            req = req.set("Idempotency-Key", i);
        }
        Self::handle(req.send_json(body))
    }

    /// Unwrap a response: the `/v1` envelope yields `data`; raw `/api` yields the body.
    fn handle(res: Result<ureq::Response, ureq::Error>) -> Result<Value, Cred402Error> {
        match res {
            Ok(resp) => {
                let v: Value = resp
                    .into_json()
                    .map_err(|e| Cred402Error::Decode(e.to_string()))?;
                if let Some(false) = v.get("success").and_then(Value::as_bool) {
                    let code = v
                        .pointer("/error/code")
                        .and_then(Value::as_str)
                        .unwrap_or("error")
                        .to_string();
                    let msg = v
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("request failed")
                        .to_string();
                    return Err(Cred402Error::Api { code, message: msg });
                }
                Ok(v.get("data").cloned().unwrap_or(v))
            }
            Err(ureq::Error::Status(code, resp)) => {
                let body: Value = resp.into_json().unwrap_or(Value::Null);
                let msg = body
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("http error")
                    .to_string();
                Err(Cred402Error::Api {
                    code: format!("http_{}", code),
                    message: msg,
                })
            }
            Err(e) => Err(Cred402Error::Transport(e.to_string())),
        }
    }

    // -- endpoints ----------------------------------------------------------

    pub fn health(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/health")
    }
    pub fn list_agents(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/agents")
    }
    pub fn get_agent(&self, id: &str) -> Result<Value, Cred402Error> {
        self.get(&format!("/v1/agents/{}", id))
    }
    pub fn credit_pool(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/credit/pool")
    }
    pub fn explain_credit(&self, id: &str) -> Result<Value, Cred402Error> {
        self.get(&format!("/v1/agents/{}/credit-explain", id))
    }
    pub fn marketplace(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/marketplace")
    }
    pub fn economics(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/economics")
    }
    pub fn analytics(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/analytics")
    }
    pub fn screen_compliance(&self, id: &str) -> Result<Value, Cred402Error> {
        self.get(&format!("/v1/compliance/agents/{}", id))
    }
    pub fn search(&self, q: &str) -> Result<Value, Cred402Error> {
        self.get(&format!("/v1/search?q={}", urlencode(q)))
    }

    pub fn register_agent(
        &self,
        agent_id: &str,
        service_type: &str,
    ) -> Result<Value, Cred402Error> {
        self.post(
            "/v1/agents",
            json!({"agent_id": agent_id, "service_type": service_type}),
            None,
        )
    }
    pub fn open_credit_line(&self, agent_id: &str) -> Result<Value, Cred402Error> {
        self.post(
            "/v1/credit/lines",
            json!({"agent_id": agent_id}),
            Some(agent_id),
        )
    }
    pub fn draw_credit(&self, agent_id: &str, amount_cspr: f64) -> Result<Value, Cred402Error> {
        self.post(
            &format!("/v1/credit/lines/{}/draw", agent_id),
            json!({"amount_cspr": amount_cspr}),
            None,
        )
    }
    pub fn repay_credit(&self, agent_id: &str, amount_cspr: f64) -> Result<Value, Cred402Error> {
        self.post(
            &format!("/v1/credit/lines/{}/repay", agent_id),
            json!({"amount_cspr": amount_cspr}),
            None,
        )
    }
    pub fn verify_operator(
        &self,
        operator_id: &str,
        jurisdiction: &str,
        reference: &str,
    ) -> Result<Value, Cred402Error> {
        self.post(
            "/v1/realfi/operators",
            json!({"operator_id": operator_id, "verification_level": "business_verified", "jurisdiction": jurisdiction, "verification_reference": reference}),
            None,
        )
    }
    /// Trigger the demo loop (raw /api route) to seed live data.
    pub fn run_demo(&self) -> Result<Value, Cred402Error> {
        self.post("/api/demo/run", json!({}), None)
    }

    // --- bureau analytics: discovery, trust, portfolio, benchmark, history ---

    /// Rank agents by the composite discovery score. `service_type` is optional.
    pub fn discover(
        &self,
        service_type: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, Cred402Error> {
        let mut query = Vec::new();
        if let Some(st) = service_type {
            query.push(format!("service_type={}", urlencode(st)));
        }
        if let Some(l) = limit {
            query.push(format!("limit={}", l));
        }
        let path = if query.is_empty() {
            "/v1/discovery".to_string()
        } else {
            format!("/v1/discovery?{}", query.join("&"))
        };
        self.get(&path)
    }
    /// The web-of-trust attestation graph.
    pub fn attestation_graph(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/attestations/graph")
    }
    /// Issue a trust attestation (vouch) from one agent to another.
    pub fn attest(&self, from: &str, to: &str, note: &str) -> Result<Value, Cred402Error> {
        self.post(
            "/v1/attestations",
            json!({"from": from, "to": to, "note": note}),
            None,
        )
    }
    /// LP portfolio & concentration-risk report (HHI).
    pub fn portfolio(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/credit/portfolio")
    }
    /// Side-by-side comparison of two agents.
    pub fn compare_agents(&self, a: &str, b: &str) -> Result<Value, Cred402Error> {
        self.get(&format!(
            "/v1/agents/compare?a={}&b={}",
            urlencode(a),
            urlencode(b)
        ))
    }
    /// An agent's green/amber/red health badge.
    pub fn agent_health(&self, agent_id: &str) -> Result<Value, Cred402Error> {
        self.get(&format!("/v1/agents/{}/health", agent_id))
    }
    /// Itemized cost of a specific draw against an agent's line.
    pub fn credit_cost(&self, agent_id: &str, draw_cspr: f64) -> Result<Value, Cred402Error> {
        self.get(&format!(
            "/v1/agents/{}/credit-cost?draw_cspr={}",
            agent_id, draw_cspr
        ))
    }
    /// Market intelligence aggregated by service category.
    pub fn category_analytics(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/analytics/categories")
    }
    /// Biggest reputation gainers and losers.
    pub fn reputation_movers(&self, limit: Option<u32>) -> Result<Value, Cred402Error> {
        match limit {
            Some(n) => self.get(&format!("/v1/analytics/reputation-movers?limit={}", n)),
            None => self.get("/v1/analytics/reputation-movers"),
        }
    }
    /// Protocol-level dispute statistics.
    pub fn dispute_stats(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/analytics/disputes")
    }
    /// x402 receipt-network statistics.
    pub fn x402_stats(&self) -> Result<Value, Cred402Error> {
        self.get("/v1/analytics/x402")
    }
    /// Percentile benchmark of an agent against its service-type cohort.
    pub fn benchmark(&self, agent_id: &str) -> Result<Value, Cred402Error> {
        self.get(&format!("/v1/agents/{}/benchmark", agent_id))
    }
    /// The agent's chronological credit file (every event concerning it).
    pub fn credit_history(&self, agent_id: &str) -> Result<Value, Cred402Error> {
        self.get(&format!("/v1/agents/{}/history", agent_id))
    }
    /// Read-only "what-if" underwriting preview against the live risk policy.
    pub fn simulate_credit(
        &self,
        monthly_revenue_cspr: f64,
        reputation: Option<f64>,
        stake_cspr: Option<f64>,
    ) -> Result<Value, Cred402Error> {
        let mut body = json!({"monthly_revenue_cspr": monthly_revenue_cspr});
        if let Some(r) = reputation {
            body["reputation"] = json!(r);
        }
        if let Some(s) = stake_cspr {
            body["stake_cspr"] = json!(s);
        }
        self.post("/v1/credit/simulate", body, None)
    }
    /// List credit pre-approval offers, optionally for one agent.
    pub fn credit_offers(&self, agent_id: Option<&str>) -> Result<Value, Cred402Error> {
        match agent_id {
            Some(id) => self.get(&format!("/v1/credit/offers?agent_id={}", urlencode(id))),
            None => self.get("/v1/credit/offers"),
        }
    }
    /// Issue a time-bounded credit pre-approval offer for an agent.
    pub fn issue_credit_offer(&self, agent_id: &str) -> Result<Value, Cred402Error> {
        self.post(
            "/v1/credit/offers",
            json!({"agent_id": agent_id}),
            Some(agent_id),
        )
    }
    /// Accept a pending offer — opens a credit line at the locked terms.
    pub fn accept_credit_offer(&self, offer_id: &str) -> Result<Value, Cred402Error> {
        self.post(
            &format!("/v1/credit/offers/{}/accept", offer_id),
            json!({}),
            None,
        )
    }
}

fn trim_slash(s: String) -> String {
    s.trim_end_matches('/').to_string()
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}
