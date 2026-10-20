// A throwaway MCP server for Experiments: just enough of the Streamable HTTP
// transport (JSON-RPC over POST, plain JSON replies, no SSE) to serve a few
// tools and to record exactly what TrueForge sends with every request.
//
// It is hand-rolled on purpose, without the MCP SDK, so every header and every
// JSON-RPC field TrueForge sends is visible in the log.

export type ProbeTool = {
  name: string;
  description: string;
  // MCP tool annotations. TrueForge's default approval rule pauses tools that
  // are `@write` (readOnlyHint: false) or `@destructive` (destructiveHint: true).
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  // What the tool returns. `ctx` is what this request carried.
  run: (ctx: CallContext) => Promise<unknown>;
};

export type CallContext = {
  mcpSessionId: string | null;
  headers: Record<string, string>;
  meta: unknown; // the JSON-RPC `params._meta`, if TrueForge sends one
  args: unknown;
};

export type LoggedRequest = {
  at: string;
  httpMethod: string;
  rpcMethod?: string;
  mcpSessionId: string | null;
  headers: Record<string, string>;
  meta?: unknown;
};

// Header values that could carry a credential are never logged.
const REDACT = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);

function headerRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = REDACT.has(key) ? "<redacted>" : value;
  });
  return out;
}

export function startProbeMcp(port: number, tools: ProbeTool[]) {
  const log: LoggedRequest[] = [];
  const sessions = new Set<string>(); // MCP transport session ids we handed out

  // `Bun.serve` starts an HTTP server; `fetch` handles every request.
  const server = Bun.serve({
    hostname: "127.0.0.1", // loopback only
    port,
    idleTimeout: 120, // seconds; a tool may take a while
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });

      const headers = headerRecord(req.headers);
      const mcpSessionId = req.headers.get("mcp-session-id");
      const entry: LoggedRequest = { at: new Date().toISOString(), httpMethod: req.method, mcpSessionId, headers };
      log.push(entry);

      // GET would open a server-to-client SSE stream; DELETE ends a session.
      // This probe needs neither.
      if (req.method === "GET") return new Response(null, { status: 405 });
      if (req.method === "DELETE") {
        if (mcpSessionId) sessions.delete(mcpSessionId);
        return new Response(null, { status: 200 });
      }

      // A JSON-RPC message: a request has an `id`; a notification has none.
      const msg = (await req.json()) as { id?: number | string; method: string; params?: Record<string, unknown> };
      entry.rpcMethod = msg.method;
      entry.meta = msg.params?._meta;

      if (msg.id === undefined) return new Response(null, { status: 202 }); // notifications: accepted, no body

      const reply = (result: unknown, extraHeaders: Record<string, string> = {}) =>
        Response.json({ jsonrpc: "2.0", id: msg.id, result }, { headers: extraHeaders });

      if (msg.method === "initialize") {
        const id = crypto.randomUUID();
        sessions.add(id);
        return reply(
          {
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "session-probe", version: "0.0.1" },
          },
          { "mcp-session-id": id }, // the transport session id the client must send back
        );
      }
      if (mcpSessionId && !sessions.has(mcpSessionId)) {
        // Per the spec, an unknown session gets 404 so the client re-initializes.
        return new Response("unknown session", { status: 404 });
      }
      if (msg.method === "ping") return reply({});
      if (msg.method === "tools/list") {
        return reply({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: t.annotations,
          })),
        });
      }
      if (msg.method === "tools/call") {
        const name = msg.params?.name as string;
        const tool = tools.find((t) => t.name === name);
        if (!tool) return reply({ content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
        try {
          const out = await tool.run({ mcpSessionId, headers, meta: msg.params?._meta, args: msg.params?.arguments });
          return reply({ content: [{ type: "text", text: JSON.stringify(out) }] });
        } catch (err) {
          return reply({ content: [{ type: "text", text: String(err) }], isError: true });
        }
      }
      return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    },
  });

  return { url: `http://127.0.0.1:${port}/mcp`, log, stop: () => server.stop(true) };
}
