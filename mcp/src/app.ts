// The HTTP face of the MCP server (#8, #55): one fetch handler serving three
// endpoints, /mcp/source, /mcp/sessions and /mcp/triage. Each is registered in
// TrueForge as its own MCP server, so approvals and preloading are set per server.
//
// TrueForge (0.179.2 and 0.180.0) speaks the 2025-11-25 protocol and identifies a connection
// by its `Mcp-Session-Id`, one per TrueForge Session (#24). The sessions tools
// will use that id to find their own Session, so the transport is sessionful:
// the first `initialize` gets a fresh McpServer and transport, and later
// requests carrying the id are routed back to them.

import { HOST } from "@forge-lab/lib/ports";
import {
  hostHeaderValidationResponse,
  isInitializeRequest,
  McpServer,
  originValidationResponse,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { registerSessionsTools, type SessionsDeps } from "./sessions/tools";
import type { Snapshot } from "./source/snapshot";
import { registerSourceTools } from "./source/tools";
import { registerTriageTools, type TriageDeps } from "./triage/tools";

export const ENDPOINTS = ["source", "sessions", "triage"] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

// The triage tools also read the snapshot and Sessions, which they get from here.
export type AppDeps = {
  source: Snapshot;
  sessions: SessionsDeps;
  triage: Pick<TriageDeps, "decide" | "budget">;
};

// DNS-rebinding guard: a web page can make the browser send requests to
// 127.0.0.1, but not with our Host, and with its own Origin. Only loopback names pass.
const ALLOWED_HOSTS = [HOST, "localhost"];

export function createApp(deps: AppDeps) {
  // A factory per endpoint: each new connection gets its own McpServer instance.
  // It's given the connection's Mcp-Session-Id up front, which the sessions
  // tools use to find the TrueForge Session they're running in (#24).
  const factories: Record<Endpoint, (mcpSessionId: string) => McpServer> = {
    source: () => {
      const server = new McpServer({ name: "cartographer-source", version: deps.source.version });
      registerSourceTools(server, deps.source);
      return server;
    },
    sessions: (mcpSessionId) => {
      const server = new McpServer({ name: "cartographer-sessions", version: deps.source.version });
      registerSessionsTools(server, deps.sessions, mcpSessionId);
      return server;
    },
    triage: () => {
      const server = new McpServer({ name: "cartographer-triage", version: deps.source.version });
      registerTriageTools(server, { ...deps.triage, source: deps.source, sessions: deps.sessions.api });
      return server;
    },
  };

  // Open connections, keyed by endpoint and Mcp-Session-Id (MCP calls them
  // sessions; here "Session" means a TrueForge Session, per CONTEXT.md). They
  // live until the client sends DELETE or the process stops; TrueForge keeps one
  // per Session, so this stays small locally.
  const connections = new Map<string, WebStandardStreamableHTTPServerTransport>();

  async function handle(endpoint: Endpoint, req: Request): Promise<Response> {
    // After initialize, a 2025-era client opens a GET stream for messages the
    // server starts on its own. These tools only answer requests, so there's no
    // stream to offer; 405 is the spec's way to say so, and the client moves on
    // instead of holding an idle connection open.
    if (req.method === "GET")
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST, DELETE" } });
    const id = req.headers.get("mcp-session-id");
    if (id) {
      const transport = connections.get(`${endpoint}:${id}`);
      // 404 tells a client its session is gone, so it initializes a new one.
      return transport ? transport.handleRequest(req) : jsonRpcError(404, "Session not found");
    }
    if (req.method !== "POST") return jsonRpcError(400, "No Mcp-Session-Id: initialize first");
    const body: unknown = await req.json().catch(() => undefined);
    if (!isInitializeRequest(body)) return jsonRpcError(400, "No Mcp-Session-Id: initialize first");

    // The id is made here rather than inside the transport, so the factory can have it.
    const mcpSessionId = crypto.randomUUID();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => mcpSessionId,
      enableJsonResponse: true, // plain JSON replies; no tool here streams progress
      onsessioninitialized: (sid) => {
        connections.set(`${endpoint}:${sid}`, transport);
      },
      onsessionclosed: (sid) => {
        connections.delete(`${endpoint}:${sid}`);
      },
    });
    await factories[endpoint](mcpSessionId).connect(transport);
    // The body was already read above, so it's handed over parsed.
    return transport.handleRequest(req, { parsedBody: body });
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const rejected = hostHeaderValidationResponse(req, ALLOWED_HOSTS) ?? originValidationResponse(req, ALLOWED_HOSTS);
      if (rejected) return rejected;
      const match = /^\/mcp\/([a-z]+)$/.exec(new URL(req.url).pathname);
      const endpoint = ENDPOINTS.find((e) => e === match?.[1]);
      if (!endpoint) return new Response("Not found", { status: 404 });
      return handle(endpoint, req);
    },
    openConnections: () => connections.size,
  };
}

function jsonRpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });
}
