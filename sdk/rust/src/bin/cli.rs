//! `cred402` — Rust CLI for the Cred402 protocol.
//!
//!   cred402 [--api URL] [--key KEY] <command> [args]
//!   commands: health | agents | agent <id> | pool | explain <id> |
//!             market | economics | analytics | search <q> |
//!             register <id> <service> | draw <id> <cspr> | repay <id> <cspr> |
//!             verify-operator <op> <jurisdiction> | compliance <id> | demo

use cred402::{types::motes_to_cspr, Client};
use serde_json::Value;
use std::env;
use std::process::exit;

fn main() {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let mut api = "http://localhost:4021".to_string();
    let mut key: Option<String> = None;

    // Parse global flags.
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--api" if i + 1 < args.len() => {
                api = args.remove(i + 1);
                args.remove(i);
            }
            "--key" if i + 1 < args.len() => {
                key = Some(args.remove(i + 1));
                args.remove(i);
            }
            _ => i += 1,
        }
    }

    if args.is_empty() {
        usage();
        exit(2);
    }

    let mut client = Client::new(api);
    if let Some(k) = key {
        client = client.with_api_key(k);
    }

    let cmd = args[0].as_str();
    let rest = &args[1..];
    let result = run(&client, cmd, rest);
    match result {
        Ok(()) => {}
        Err(msg) => {
            eprintln!("error: {}", msg);
            exit(1);
        }
    }
}

fn run(c: &Client, cmd: &str, rest: &[String]) -> Result<(), String> {
    let map = |r: Result<Value, cred402::Cred402Error>| r.map_err(|e| e.to_string());
    match cmd {
        "health" => print_json(map(c.health())?),
        "agents" => print_agents(map(c.list_agents())?),
        "agent" => print_json(map(c.get_agent(arg(rest, 0)?))?),
        "pool" => print_json(map(c.credit_pool())?),
        "explain" => print_explain(map(c.explain_credit(arg(rest, 0)?))?),
        "market" => print_market(map(c.marketplace())?),
        "economics" => print_json(map(c.economics())?),
        "analytics" => print_analytics(map(c.analytics())?),
        "search" => print_json(map(c.search(arg(rest, 0)?))?),
        "compliance" => print_json(map(c.screen_compliance(arg(rest, 0)?))?),
        "register" => print_json(map(c.register_agent(arg(rest, 0)?, arg(rest, 1)?))?),
        "draw" => print_json(map(c.draw_credit(arg(rest, 0)?, num(rest, 1)?))?),
        "repay" => print_json(map(c.repay_credit(arg(rest, 0)?, num(rest, 1)?))?),
        "verify-operator" => print_json(map(c.verify_operator(
            arg(rest, 0)?,
            arg(rest, 1)?,
            "cli-ref",
        ))?),
        "demo" => print_json(map(c.run_demo())?),
        _ => {
            usage();
            return Err(format!("unknown command: {}", cmd));
        }
    }
    Ok(())
}

fn arg<'a>(rest: &'a [String], i: usize) -> Result<&'a str, String> {
    rest.get(i)
        .map(String::as_str)
        .ok_or_else(|| format!("missing argument #{}", i + 1))
}

fn num(rest: &[String], i: usize) -> Result<f64, String> {
    arg(rest, i)?
        .parse::<f64>()
        .map_err(|_| "expected a number".to_string())
}

fn print_json(v: Value) {
    println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
}

fn print_agents(v: Value) {
    println!(
        "{:<22} {:<28} {:>4} {:>6}",
        "AGENT", "SERVICE", "REP", "SCORE"
    );
    if let Some(arr) = v.as_array() {
        for a in arr {
            println!(
                "{:<22} {:<28} {:>4} {:>6}",
                a["agent_id"].as_str().unwrap_or("-"),
                a["service_type"].as_str().unwrap_or("-"),
                a["reputation_score"].as_i64().unwrap_or(0),
                a["credit_score"].as_i64().unwrap_or(0),
            );
        }
    }
}

fn print_market(v: Value) {
    println!(
        "{:<26} {:<20} {:<18} {:>4}",
        "CATEGORY", "AGENT", "STRATEGY", "REP"
    );
    if let Some(arr) = v.as_array() {
        for l in arr {
            println!(
                "{:<26} {:<20} {:<18} {:>4}",
                l["category"].as_str().unwrap_or("-"),
                l["agent_id"].as_str().unwrap_or("-"),
                l["strategy"].as_str().unwrap_or("-"),
                l["reputation_score"].as_i64().unwrap_or(0),
            );
        }
    }
}

fn print_explain(v: Value) {
    if let Some(line) = v.pointer("/decision/credit_line").and_then(Value::as_str) {
        println!("credit line: {:.4} CSPR", motes_to_cspr(line));
    }
    println!("eligible: {}", v["eligible"].as_bool().unwrap_or(false));
    if let Some(codes) = v
        .pointer("/decision/reason_codes")
        .and_then(Value::as_array)
    {
        for c in codes {
            let sign = if c["polarity"] == "positive" {
                "+"
            } else {
                "-"
            };
            println!(
                "  {} {}: {}",
                sign,
                c["code"].as_str().unwrap_or(""),
                c["detail"].as_str().unwrap_or("")
            );
        }
    }
}

fn print_analytics(v: Value) {
    println!(
        "TVL          {:.0} CSPR",
        motes_to_cspr(
            v.pointer("/pool/tvl_motes")
                .and_then(Value::as_str)
                .unwrap_or("0")
        )
    );
    println!(
        "Outstanding  {:.4} CSPR",
        motes_to_cspr(
            v.pointer("/pool/outstanding_motes")
                .and_then(Value::as_str)
                .unwrap_or("0")
        )
    );
    println!(
        "x402 volume  {:.4} CSPR",
        motes_to_cspr(
            v.pointer("/x402/total_volume_motes")
                .and_then(Value::as_str)
                .unwrap_or("0")
        )
    );
    println!(
        "Agents       {}",
        v.pointer("/totals/agents")
            .and_then(Value::as_i64)
            .unwrap_or(0)
    );
    println!("\nLeaderboard:");
    if let Some(arr) = v.pointer("/leaderboard").and_then(Value::as_array) {
        for (i, r) in arr.iter().enumerate() {
            println!(
                "  {}. {:<22} rev {:.2} CSPR  rep {}",
                i + 1,
                r["agent_id"].as_str().unwrap_or("-"),
                motes_to_cspr(r["revenue_motes"].as_str().unwrap_or("0")),
                r["reputation"].as_i64().unwrap_or(0),
            );
        }
    }
}

fn usage() {
    eprintln!(
        "cred402 [--api URL] [--key KEY] <command> [args]\n\
         commands: health | agents | agent <id> | pool | explain <id> | market |\n\
                   economics | analytics | search <q> | compliance <id> |\n\
                   register <id> <service> | draw <id> <cspr> | repay <id> <cspr> |\n\
                   verify-operator <op> <jur> | demo"
    );
}
