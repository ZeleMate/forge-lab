// Smoke test for the local TrueForge + OpenRouter setup (ticket #7).
//
//   bun run smoke            # all three models
//   bun run smoke glm-5-3-flash
//
// For each model it: registers the DeepWiki MCP server, upserts a `smoke-<model>`
// agent, opens a Session tagged experiment=smoke, runs a tool-using Turn plus a
// short follow-up (cache check), and optionally a Subagent Turn. It prints what it
// observed and writes the raw numbers to smoke-results/<timestamp>.json.
// It never touches provider keys: TrueForge already holds them.

const BASE = "http://127.0.0.1:8790/api/v1";
const ALL_MODELS = ["opus-5-5", "glm-5-3-flash", "deepseek-v4-flash", "openrouter-auto"] as const;
type ModelName = (typeof ALL_MODELS)[number]; // a union of the three string literals

// ---------- tiny typed HTTP helper ----------

// TrueForge wraps every response: one resource is { data: {...} }, a list is
// { data: [...], pagination: {...} }. `Envelope<T>` describes that wrapper.
type Envelope<T> = { data: T; pagination?: { next_page_token?: string | null } };

// A generic function: the caller says what shape it expects inside `data` (T).
async function api<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : { data: undefined }) as Envelope<T>;
}

// Only the fields we read. Everything else in the payloads is ignored.
type Turn = { id: string; state: { status: string; metrics?: Record<string, number>; error?: unknown } };
type Event = { type: string; [key: string]: unknown };

// ---------- setup ----------

async function ensureDeepWiki() {
  await api("PUT", "/settings/mcp-servers", {
    manifest: {
      type: "remote",
      name: "deepwiki",
      url: "https://mcp.deepwiki.com/mcp",
      description: "Read documentation and ask questions about any public GitHub repository.",
    },
  });
}

// Agents have no upsert: find by exact name, then update or create.
async function upsertAgent(model: ModelName, withSubagents: boolean) {
  const name = `smoke-${model}`;
  const manifest = {
    model: {
      name: `openrouter/${model}`,
      // No reasoning_effort: TrueForge rejects it unless the provider manifest
      // declares `reasoning_efforts` for the model (HTTP 422 otherwise).
      params: { max_tokens: 16_384 },
    },
    instructions:
      "You answer questions about the truefoundry/trueforge GitHub repository. Use the deepwiki tools; don't guess.",
    mcp_servers: [{ name: "deepwiki" }], // deferred by default: the model must discover the tools
    config: { iteration_limit: 20, dynamic_sub_agents: { enabled: withSubagents } },
  };
  const found = await api<{ id: string; name: string }[]>("GET", `/agents?name=${encodeURIComponent(name)}`);
  const existing = found.data.find((a) => a.name === name);
  const description = `Smoke-test agent on ${model}`;
  // Names are immutable, so an update sends everything except `name`.
  if (existing) await api("PUT", `/agents/${existing.id}`, { description, manifest });
  else await api("POST", "/agents", { name, description, manifest });
  return name;
}

// ---------- running turns ----------

async function runTurn(sessionId: string, content: string, previousTurnId?: string): Promise<Turn> {
  const { data: created } = await api<Turn>("POST", `/sessions/${sessionId}/turns`, {
    input: [{ type: "user.message", content }],
    stream: false, // returns at once; we poll instead of holding an SSE stream open
    ...(previousTurnId ? { previous_turn_id: previousTurnId } : {}),
  });
  const deadline = Date.now() + 240_000;
  for (;;) {
    const { data: turn } = await api<Turn>("GET", `/sessions/${sessionId}/turns/${created.id}`);
    if (turn.state.status !== "running") return turn;
    if (Date.now() > deadline) throw new Error(`turn ${created.id} still running after 240 s`);
    await Bun.sleep(2_000);
  }
}

async function allEvents(sessionId: string, turnId: string): Promise<Event[]> {
  const out: Event[] = [];
  let token: string | null | undefined;
  do {
    const q = new URLSearchParams({ limit: "100", ...(token ? { page_token: token } : {}) });
    const page = await api<Event[]>("GET", `/sessions/${sessionId}/turns/${turnId}/events?${q}`);
    out.push(...page.data);
    token = page.pagination?.next_page_token;
  } while (token);
  return out;
}

// Pull the facts we care about out of one Turn's events.
function summarise(turn: Turn, events: Event[]) {
  const counts: Record<string, number> = {};
  const toolCalls: string[] = [];
  const answeredBy = new Set<string>();
  let cacheRead = 0;
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === "model.message") {
      const calls = (e.tool_calls ?? []) as { name?: string; function?: { name?: string } }[];
      for (const c of calls) toolCalls.push(c.name ?? c.function?.name ?? "?");
      const usage = (e.usage ?? {}) as Record<string, number>;
      cacheRead += usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? 0;
      if (typeof e.model === "string") answeredBy.add(e.model);
    }
  }
  return {
    status: turn.state.status,
    error: turn.state.error,
    metrics: turn.state.metrics,
    eventCounts: counts,
    toolCalls,
    usedMetaTools: toolCalls.some((t) => ["list_tools", "get_tool_info", "call_tool"].includes(t)),
    usedSubagent: toolCalls.includes("create_sub_agent"),
    cacheReadTokens: cacheRead,
    answeredBy: [...answeredBy],
  };
}

// ---------- main ----------

const requested = Bun.argv.slice(2) as ModelName[];
const models = requested.length ? requested : [...ALL_MODELS];
const health = (await fetch("http://127.0.0.1:8790/healthz").then((r) => r.json()).catch(() => null)) as {
  version: string;
} | null;
console.log(`TrueForge ${health?.version ?? "?"}; models: ${models.join(", ")}\n`);

await ensureDeepWiki();
const results: Record<string, unknown> = {};

for (const model of models) {
  const withSubagents = model === "glm-5-3-flash";
  const agent = await upsertAgent(model, withSubagents);
  const { data: session } = await api<{ id: string }>("POST", "/sessions", {
    agent: { name: agent },
    metadata: { experiment: "smoke", depth: "0" },
  });

  const t1 = await runTurn(
    session.id,
    "In truefoundry/trueforge, how does the agent loop decide when to compact the context? Answer in 3 short bullets.",
  );
  const t2 = await runTurn(session.id, "Now say that in one sentence.", t1.id);
  const r: Record<string, unknown> = {
    session: session.id,
    toolTurn: summarise(t1, await allEvents(session.id, t1.id)),
    followUp: summarise(t2, await allEvents(session.id, t2.id)),
  };

  if (withSubagents) {
    const t3 = await runTurn(
      session.id,
      "Use two subagents in parallel: one finds how approvals pause a turn, the other how subagents are created. Then combine their findings in 4 bullets.",
      t2.id,
    );
    r.subagentTurn = summarise(t3, await allEvents(session.id, t3.id));
  }

  results[model] = r;
  console.log(`== ${model}`);
  console.log(JSON.stringify(r, null, 2), "\n");
}

const dir = `${import.meta.dir}/../smoke-results`;
await Bun.write(`${dir}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify(results, null, 2));
console.log(`Saved to smoke-results/`);
