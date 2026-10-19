// Shared helpers for talking to the local TrueForge server.
// Scripts import what they need: `import { api, runTurn } from "./lib/trueforge"`.

export const ORIGIN = "http://127.0.0.1:8790";
const BASE = `${ORIGIN}/api/v1`;

export const ALL_MODELS = ["opus-5-5", "glm-5-3-flash", "deepseek-v4-flash", "openrouter-auto"] as const;
export type ModelName = (typeof ALL_MODELS)[number]; // a union of the string literals above

// ---------- typed HTTP ----------

// TrueForge wraps every response: one resource is { data: {...} }, a list is
// { data: [...], pagination: {...} }. `Envelope<T>` describes that wrapper.
export type Envelope<T> = { data: T; pagination?: { next_page_token?: string | null } };

// A generic function: the caller says what shape it expects inside `data` (T).
export async function api<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : { data: undefined }) as Envelope<T>;
}

export async function serverVersion(): Promise<string> {
  const res = await fetch(`${ORIGIN}/healthz`).catch(() => null);
  if (!res?.ok) return "unreachable";
  const body = (await res.json()) as { version?: string };
  return body.version ?? "?";
}

// Only the fields we read. Everything else in the payloads is ignored.
export type Turn = { id: string; state: { status: string; metrics?: Record<string, number>; error?: unknown } };
export type Event = { type: string; [key: string]: unknown };

// ---------- setup ----------

export async function ensureDeepWiki() {
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
// Names are immutable, so an update sends everything except `name`.
export async function upsertAgent(name: string, description: string, manifest: Record<string, unknown>) {
  const found = await api<{ id: string; name: string }[]>("GET", `/agents?name=${encodeURIComponent(name)}`);
  const existing = found.data.find((a) => a.name === name);
  if (existing) await api("PUT", `/agents/${existing.id}`, { description, manifest });
  else await api("POST", "/agents", { name, description, manifest });
  return name;
}

// Opens a Session tagged as an Experiment Session (see CONTEXT.md).
export async function openExperimentSession(agent: string, experiment: string) {
  const { data } = await api<{ id: string }>("POST", "/sessions", {
    agent: { name: agent },
    metadata: { experiment, depth: "0" },
  });
  return data.id;
}

// ---------- running turns ----------

export async function runTurn(
  sessionId: string,
  content: string,
  previousTurnId?: string,
  timeoutMs = 240_000,
): Promise<Turn & { wallMs: number }> {
  const started = Date.now();
  const { data: created } = await api<Turn>("POST", `/sessions/${sessionId}/turns`, {
    input: [{ type: "user.message", content }],
    stream: false, // returns at once; we poll instead of holding an SSE stream open
    ...(previousTurnId ? { previous_turn_id: previousTurnId } : {}),
  });
  for (;;) {
    const { data: turn } = await api<Turn>("GET", `/sessions/${sessionId}/turns/${created.id}`);
    if (turn.state.status !== "running") return { ...turn, wallMs: Date.now() - started };
    if (Date.now() - started > timeoutMs) throw new Error(`turn ${created.id} still running after ${timeoutMs} ms`);
    await Bun.sleep(2_000);
  }
}

export async function allEvents(sessionId: string, turnId: string): Promise<Event[]> {
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
export function summarise(turn: Turn & { wallMs?: number }, events: Event[]) {
  const counts: Record<string, number> = {};
  const toolCalls: string[] = [];
  let cacheRead = 0;
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === "model.message") {
      const calls = (e.tool_calls ?? []) as { name?: string; function?: { name?: string } }[];
      for (const c of calls) toolCalls.push(c.name ?? c.function?.name ?? "?");
      const usage = (e.usage ?? {}) as Record<string, number>;
      cacheRead += usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? 0;
    }
  }
  return {
    status: turn.state.status,
    error: turn.state.error,
    wallMs: turn.wallMs,
    metrics: turn.state.metrics,
    eventCounts: counts,
    toolCalls,
    usedMetaTools: toolCalls.some((t) => ["list_tools", "get_tool_info", "call_tool"].includes(t)),
    usedSubagent: toolCalls.includes("create_sub_agent"),
    cacheReadTokens: cacheRead,
  };
}

export async function saveResults(folder: string, results: unknown) {
  const file = `${import.meta.dir}/../../${folder}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await Bun.write(file, JSON.stringify(results, null, 2));
  return file;
}
