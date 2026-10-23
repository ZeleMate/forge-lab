// Shared helpers for talking to the local TrueForge server.
// Scripts import what they need: `import { api, runTurn } from "@forge-lab/lib/trueforge"`.

import { TRUEFORGE_ORIGIN } from "./ports";

export const ORIGIN = TRUEFORGE_ORIGIN;
const BASE = `${ORIGIN}/api/v1`;

export const ALL_MODELS = ["opus-5-5", "glm-5-3-flash", "deepseek-v4-flash", "openrouter-auto"] as const;
export type ModelName = (typeof ALL_MODELS)[number]; // a union of the string literals above

// ---------- typed HTTP ----------

// TrueForge wraps every response: one resource is { data: {...} }, a list is
// { data: [...], pagination: {...} }. `Envelope<T>` describes that wrapper.
export type Envelope<T> = { data: T; pagination?: { next_page_token?: string | null } };

// The raw outcome of one call. Never throws on an HTTP error, so a script can
// record an expected 4xx. `bytes` is the response body size on the wire.
export type RawResult = { status: number; bytes: number; text: string; json: unknown };

export async function request(method: string, path: string, body?: unknown): Promise<RawResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined; // not JSON (e.g. an HTML error page); `text` still has it
  }
  return { status: res.status, bytes: new TextEncoder().encode(text).length, text, json };
}

// A generic function: the caller says what shape it expects inside `data` (T).
export async function api<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
  const res = await request(method, path, body);
  if (res.status >= 400) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${res.text.slice(0, 500)}`);
  return (res.json ?? { data: undefined }) as Envelope<T>;
}

export async function serverVersion(): Promise<string> {
  const res = await fetch(`${ORIGIN}/healthz`).catch(() => null);
  if (!res?.ok) return "unreachable";
  const body = (await res.json()) as { version?: string };
  return body.version ?? "?";
}

// Only the fields we read. Everything else in the payloads is ignored.
export type Turn = {
  id: string;
  previous_turn_id?: string | null;
  input?: { type: string; content?: unknown }[];
  created_at?: string;
  // `reason` is set on `cancelled`; `error` on `error`.
  state: { status: string; metrics?: Record<string, number>; error?: unknown; reason?: string };
};
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

// Starts a Turn and returns at once (`stream: false`), still `running`.
// `previousTurnId`: omitted means "auto" (the Session tip), "none" a new root,
// an id forks from that Turn.
export async function createTurn(sessionId: string, content: string, previousTurnId?: string): Promise<Turn> {
  const { data } = await api<Turn>("POST", `/sessions/${sessionId}/turns`, {
    input: [{ type: "user.message", content }],
    stream: false, // returns at once; we poll instead of holding an SSE stream open
    ...(previousTurnId ? { previous_turn_id: previousTurnId } : {}),
  });
  return data;
}

// Polls until the Turn leaves `running` (done, paused, cancelled or error).
export async function waitTurn(sessionId: string, turnId: string, timeoutMs = 240_000): Promise<Turn> {
  const started = Date.now();
  for (;;) {
    const { data: turn } = await api<Turn>("GET", `/sessions/${sessionId}/turns/${turnId}`);
    if (turn.state.status !== "running") return turn;
    if (Date.now() - started > timeoutMs) throw new Error(`turn ${turnId} still running after ${timeoutMs} ms`);
    await Bun.sleep(2_000);
  }
}

export async function runTurn(
  sessionId: string,
  content: string,
  previousTurnId?: string,
  timeoutMs = 240_000,
): Promise<Turn & { wallMs: number }> {
  const started = Date.now();
  const created = await createTurn(sessionId, content, previousTurnId);
  const turn = await waitTurn(sessionId, created.id, timeoutMs);
  return { ...turn, wallMs: Date.now() - started };
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

// `dir` is the caller's absolute results folder, e.g. `${import.meta.dir}/../smoke-results`
// (`import.meta.dir` is the folder of the file that writes it, so it names the caller's own).
export async function saveResults(dir: string, results: unknown) {
  const file = `${dir}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await Bun.write(file, JSON.stringify(results, null, 2));
  return file;
}
