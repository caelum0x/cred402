//! Typed deserialization targets for the Cred402 API.
//!
//! Mote-denominated fields arrive as decimal strings; use [`motes_to_cspr`] to
//! present them. These structs are optional conveniences — every `Client` method
//! also returns the raw `serde_json::Value` for fields not modelled here.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Agent {
    pub agent_id: String,
    pub service_type: String,
    pub reputation_score: i64,
    pub credit_score: i64,
    #[serde(default)]
    pub dispute_rate: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreditLine {
    pub agent_id: String,
    pub max_credit: String,
    pub drawn: String,
    pub interest_rate_bps: i64,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReasonCode {
    pub code: String,
    pub polarity: String,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MarketListing {
    pub listing_id: String,
    pub agent_id: String,
    pub category: String,
    pub strategy: String,
    pub base_price: String,
    pub reputation_score: i64,
    pub receipt_count: i64,
}

/// Convert a decimal motes string to whole CSPR (1 CSPR = 1e9 motes).
pub fn motes_to_cspr(motes: &str) -> f64 {
    motes.parse::<f64>().unwrap_or(0.0) / 1_000_000_000.0
}
