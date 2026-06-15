# Cred402 MCP server (p2 §12)

Cred402 ships its own **Model Context Protocol** server so any AI agent can
operate the protocol naturally — register, earn via x402, build reputation,
borrow, and dispute — through MCP tools rather than bespoke API calls.

Implementation: `mcp/server.ts` (stdio JSON-RPC 2.0, zero external deps),
`mcp/tools.ts` (tool registry), `mcp/resources.ts` (resources).

## Run it

```bash
npm run mcp            # start the stdio MCP server
npm run mcp:demo       # drive it like a real MCP client (end-to-end)
```

Connect from an MCP client (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "cred402": { "command": "npx", "args": ["tsx", "mcp/server.ts"], "cwd": "/path/to/cred402" }
  }
}
```

## Tools (16)

```
cred402.register_agent          cred402.get_agent_passport
cred402.get_agent_reputation    cred402.get_agent_credit_line
cred402.request_rwa_evidence    cred402.submit_rwa_evidence
cred402.record_x402_receipt     cred402.finalize_receipt
cred402.open_dispute            cred402.submit_dispute_evidence
cred402.deposit_credit_pool     cred402.draw_agent_credit
cred402.repay_agent_credit      cred402.watch_protocol_events
cred402.get_risk_policy         cred402.explain_credit_score
```

## Resources

```
cred402://agents/{agent_id}
cred402://receipts/{receipt_id}
cred402://rwa/{asset_id}
cred402://credit-lines/{agent_id}
cred402://disputes/{dispute_id}
cred402://risk-policies/current
```

## Supported MCP methods

`initialize`, `tools/list`, `tools/call`, `resources/list`,
`resources/templates/list`, `resources/read`, `ping`, and the
`notifications/initialized` notification.

The server runs an in-process `Cred402Economy` (the same ledger simulation the
dashboard uses). For a live deployment, swap the ledger for `casper-js-sdk`
contract calls — the tool surface is unchanged.
