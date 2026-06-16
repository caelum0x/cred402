import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSseFrames,
  decodeSidecarData,
  extractContractMessages,
  CasperSidecarClient,
  sidecarFromEnv,
} from "../lib/casper/sidecar.js";

/**
 * Wires `casper-network/casper-sidecar`. These tests use the EXACT SSE frame
 * shapes from the Sidecar's USAGE docs — `data:{...}` payloads, `id:` lines, and
 * `:` keep-alives — proving the parser/decoder are faithful to the real feed.
 * Only the live network stream needs a running Sidecar (CRED402_SIDECAR_URL).
 */

// Verbatim from casper-sidecar USAGE.md (trimmed execution_result for brevity).
const TX_PROCESSED = JSON.stringify({
  TransactionProcessed: {
    transaction_hash: { Version1: "25329c14a4f9307830f2b4b6b529b0c3fd618dec65af7456ad9f9e2c7ba1ff4a" },
    timestamp: "2020-08-07T01:30:33.119Z",
    block_hash: "315210f005e7d2d7130004f0178c29cf7e4718d8b642f3f832a35a028ed094cf",
    messages: [
      {
        entity_addr: "entity-contract-a8648307789543cbf38afb24c970844e755654d462a25624edd775219d0cdacf",
        message: { String: "ReceiptRecorded:rcpt-abc" },
        topic_name: "cred402_events",
        topic_index: 4003932854,
      },
    ],
  },
});

test("sidecar: parses real ApiVersion + TransactionProcessed frames with keep-alives", () => {
  const stream = `data:{"ApiVersion":"2.0.0"}\n\n` + `data:${TX_PROCESSED}\nid:21821471\n\n` + `:\n\n`;
  const { events, rest } = parseSseFrames(stream);
  assert.equal(events.length, 2, "two real events, keep-alive ignored");
  assert.equal(events[0]!.kind, "ApiVersion");
  assert.equal(events[0]!.data, "2.0.0");
  assert.equal(events[1]!.kind, "TransactionProcessed");
  assert.equal(events[1]!.id, "21821471");
  assert.equal(rest, "", "no trailing partial frame");
});

test("sidecar: carries a trailing partial frame across chunk boundaries", () => {
  const first = `data:{"ApiVersion":"2.0.0"}\n\ndata:{"BlockAdd`;
  const { events, rest } = parseSseFrames(first);
  assert.equal(events.length, 1);
  assert.equal(rest, `data:{"BlockAdd`, "partial frame is returned, not dropped");

  const { events: more } = parseSseFrames(rest + `ed":{"height":42}}\n\n`);
  assert.equal(more[0]!.kind, "BlockAdded");
  assert.deepEqual(more[0]!.data, { height: 42 });
});

test("sidecar: extracts contract-emitted messages from TransactionProcessed", () => {
  const event = decodeSidecarData(TX_PROCESSED, "21821471");
  const msgs = extractContractMessages(event);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.topic_name, "cred402_events");
  assert.deepEqual(msgs[0]!.payload, { String: "ReceiptRecorded:rcpt-abc" });
  assert.match(msgs[0]!.entity_addr, /^entity-contract-/);
});

test("sidecar: streamEvents consumes a real SSE body via the client", async () => {
  // A stubbed fetch returns a ReadableStream of SSE bytes split mid-frame —
  // exercising the real streaming reader + incremental parser.
  const chunks = [
    `data:{"ApiVersion":"2.0.0"}\n\ndata:${TX_PROCESSED}\n`,
    `id:1\n\n:\n\ndata:{"Shutdown":null}\n\n`,
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  const stubFetch = (async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;

  const client = new CasperSidecarClient({ baseUrl: "http://127.0.0.1:19999", fetchFn: stubFetch });
  const seen: string[] = [];
  for await (const e of client.streamEvents()) seen.push(e.kind);
  assert.deepEqual(seen, ["ApiVersion", "TransactionProcessed", "Shutdown"]);
});

test("sidecar: sidecarFromEnv is null unless CRED402_SIDECAR_URL is set", () => {
  assert.equal(sidecarFromEnv({}), null);
  assert.ok(sidecarFromEnv({ CRED402_SIDECAR_URL: "http://127.0.0.1:19999" }));
});
