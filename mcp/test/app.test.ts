// The HTTP layer: DNS-rebinding guards and routing by Mcp-Session-Id.
import { beforeAll, describe, expect, test } from "bun:test";
import { HOST, PORTS } from "@forge-lab/lib/ports";
import { createApp } from "../src/app";
import type { Snapshot } from "../src/source/snapshot";
import { connect, fixtureCopy, fixtureSnapshot } from "./helpers";

const URL_SOURCE = `http://${HOST}:${PORTS.mcp}/mcp/source`;
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};
function post(headers: Record<string, string>, body: unknown = initialize) {
  return new Request(URL_SOURCE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

let source: Snapshot;
beforeAll(() => {
  source = fixtureSnapshot(fixtureCopy().root);
});

describe("guards", () => {
  test("refuses a Host that isn't loopback (DNS rebinding)", async () => {
    const res = await createApp({ source }).fetch(post({ host: "evil.example:8791" }));
    expect(res.status).toBe(403);
  });

  test("refuses a browser Origin that isn't loopback", async () => {
    const res = await createApp({ source }).fetch(
      post({ host: `${HOST}:${PORTS.mcp}`, origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  test("an unknown endpoint is a 404", async () => {
    const res = await createApp({ source }).fetch(
      new Request(`http://${HOST}:${PORTS.mcp}/mcp/nope`, { headers: { host: `${HOST}:${PORTS.mcp}` } }),
    );
    expect(res.status).toBe(404);
  });
});

describe("connections", () => {
  test("initialize issues an Mcp-Session-Id and keeps the connection", async () => {
    const app = createApp({ source });
    const res = await app.fetch(post({ host: `${HOST}:${PORTS.mcp}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeString();
    expect(app.openConnections()).toBe(1);
  });

  test("an unknown Mcp-Session-Id is a 404, so the client re-initializes", async () => {
    const res = await createApp({ source }).fetch(
      post({ host: `${HOST}:${PORTS.mcp}`, "mcp-session-id": "nope" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );
    expect(res.status).toBe(404);
  });

  test("a request without an Mcp-Session-Id that isn't initialize is a 400", async () => {
    const res = await createApp({ source }).fetch(
      post({ host: `${HOST}:${PORTS.mcp}` }, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );
    expect(res.status).toBe(400);
  });

  test("GET for a server-to-client stream is a 405, so the client doesn't hold one open", async () => {
    const app = createApp({ source });
    const init = await app.fetch(post({ host: `${HOST}:${PORTS.mcp}` }));
    const sid = init.headers.get("mcp-session-id") ?? "";
    const res = await app.fetch(
      new Request(URL_SOURCE, {
        headers: { host: `${HOST}:${PORTS.mcp}`, accept: "text/event-stream", "mcp-session-id": sid },
      }),
    );
    expect(res.status).toBe(405);
  });

  test("two clients get two connections", async () => {
    const a = await connect({ source }, "source");
    const b = await connect({ source }, "source");
    expect(a.client.transport?.sessionId).not.toBe(b.client.transport?.sessionId);
  });
});
