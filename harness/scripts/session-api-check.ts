// Session API live check for ticket #24: what can an MCP tool see of its own
// Session, and do the fork / re-run / replay assumptions from #8 and #9 hold?
//
//   bun run session-api-check          # the full check
//   bun run session-api-check guard    # only: is a loopback MCP server reachable?
//
// Expected results are written down in session-api-results/README.md.
// Uses the cheap GLM model. Every Session it creates is an Experiment Session.

import { TrueForge } from "@truefoundry/trueforge-sdk";
import { type CallContext, startProbeMcp } from "./lib/probe-mcp";
import {
  ORIGIN,
  type Event,
  type Turn,
  allEvents,
  api,
  createTurn,
  openExperimentSession,
  request,
  saveResults,
  summarise,
  upsertAgent,
  waitTurn,
} from "./lib/trueforge";

const EXPERIMENT = "session-api-check";
const PROBE_PORT = 8791;
const MODE = process.argv[2] ?? "full"; // process.argv: [bun, script, ...args]

const results: Record<string, unknown> = { mode: MODE, startedAt: new Date().toISOString() };
function record(key: string, value: unknown) {
  results[key] = value;
  console.log(`== ${key}\n${JSON.stringify(value, null, 2)}\n`);
}

// ---------- what the probe tools see ----------

// The Session the driver is running a Turn in right now. The tools use it as
// the "explicit Session id" a real tool would be given, and compare it with
// what they can work out on their own.
let current: { session: string; turn?: string } = { session: "" };
const whoamiCalls: unknown[] = [];
let selfFork: Record<string, unknown> = {};

// Workaround 1 from research §6.3: find Sessions whose persisted
// `mcp.initialize` event carries this MCP transport session id.
async function sessionsByMcpSessionId(mcpSessionId: string | null) {
  if (!mcpSessionId) return { matches: [], note: "no Mcp-Session-Id header" };
  const q = new URLSearchParams({ limit: "25", "metadata[experiment]": EXPERIMENT });
  const list = await request("GET", `/sessions?${q}`);
  if (list.status !== 200) return { matches: [], note: `session list -> ${list.status}` };
  const sessions = (list.json as { data: { id: string }[] }).data;
  const matches: { session: string; turn: string }[] = [];
  for (const s of sessions) {
    const page = await api<{ turn_id: string; event: Event }[]>("GET", `/sessions/${s.id}/events?limit=100`);
    for (const item of page.data) {
      if (item.event.type !== "mcp.initialize") continue;
      const servers = (item.event.mcp_servers ?? []) as { session_id?: string }[];
      if (servers.some((m) => m.session_id === mcpSessionId)) matches.push({ session: s.id, turn: item.turn_id });
    }
  }
  return { matches, scannedSessions: sessions.length };
}

// Research §5: read the caller's own running Turn from inside the tool call.
async function runningTurnsSeenFromInside(sessionId: string) {
  const turns = await allTurns(sessionId);
  const running = turns.filter((t) => t.state.status === "running");
  return Promise.all(
    running.map(async (t) => {
      const events = await allEvents(sessionId, t.id);
      const toolCallNames = events
        .filter((e) => e.type === "model.message")
        .flatMap((e) => ((e.tool_calls ?? []) as { function?: { name?: string } }[]).map((c) => c.function?.name));
      return {
        turn: t.id,
        isDriversTurn: t.id === current.turn,
        status: t.state.status,
        hasMetrics: t.state.metrics !== undefined,
        eventTypes: events.map((e) => e.type),
        toolCallNames,
        hasToolResponse: events.some((e) => e.type === "tool.response"),
      };
    }),
  );
}

const probe = startProbeMcp(PROBE_PORT, [
  {
    name: "whoami",
    description: "Reports what this tool call can see. Takes no arguments.",
    annotations: { readOnlyHint: true },
    run: async (ctx: CallContext) => {
      whoamiCalls.push({
        driverSession: current.session,
        driverTurn: current.turn,
        mcpSessionId: ctx.mcpSessionId,
        meta: ctx.meta ?? null,
        headers: ctx.headers,
        correlation: await sessionsByMcpSessionId(ctx.mcpSessionId),
        inFlight: await runningTurnsSeenFromInside(current.session),
      });
      return { ok: true }; // keep the model's view tiny
    },
  },
  {
    // Marked read-only only so that it runs without an Approval; it is a write.
    name: "self_fork",
    description: "Starts a follow-up step. Takes no arguments.",
    annotations: { readOnlyHint: true },
    run: async () => {
      // No previous_turn_id, so the server uses "auto": the Session tip, which
      // is the very Turn this tool call belongs to.
      const res = await request("POST", `/sessions/${current.session}/turns`, {
        input: [{ type: "user.message", content: "Reply with the single word: forked." }],
        stream: false,
      });
      const newTurn = (res.json as { data?: Turn })?.data;
      await Bun.sleep(4_000);
      const caller = await api<Turn>("GET", `/sessions/${current.session}/turns/${current.turn}`);
      selfFork = {
        createStatus: res.status,
        newTurn: newTurn?.id,
        newTurnPrevious: newTurn?.previous_turn_id,
        callerStateSeenByToolAfter4s: caller.data.state,
      };
      return { ok: true };
    },
  },
  {
    name: "needs_approval",
    description: "A write action that needs approval. Takes no arguments.",
    annotations: { readOnlyHint: false },
    run: async () => ({ ok: true }),
  },
]);

// ---------- helpers ----------

async function allTurns(sessionId: string): Promise<Turn[]> {
  const out: Turn[] = [];
  let token: string | null | undefined;
  do {
    const q = new URLSearchParams({ limit: "25", ...(token ? { page_token: token } : {}) });
    const page = await api<Turn[]>("GET", `/sessions/${sessionId}/turns?${q}`);
    out.push(...page.data);
    token = page.pagination?.next_page_token;
  } while (token);
  return out;
}

// One Turn, start to finish, with an explicit previous Turn (or "none").
async function turn(sessionId: string, content: string, previous: string) {
  const created = await createTurn(sessionId, content, previous);
  current = { session: sessionId, turn: created.id };
  const done = await waitTurn(sessionId, created.id, 300_000);
  const events = await allEvents(sessionId, done.id);
  return { turn: done, events, summary: summarise(done, events) };
}

function lastText(events: Event[]) {
  const last = [...events].reverse().find((e) => e.type === "model.message");
  return String(last?.content ?? "").slice(0, 300);
}

type Usage = { input_tokens?: number; output_tokens?: number; input_tokens_breakdown?: Record<string, number> };
function modelUsages(events: Event[]): Usage[] {
  return events.filter((e) => e.type === "model.message").map((e) => (e.usage ?? {}) as Usage);
}

function mcpInits(events: Event[]) {
  return events
    .filter((e) => e.type === "mcp.initialize")
    .flatMap((e) => (e.mcp_servers ?? []) as { name: string; session_id?: string }[]);
}

// ---------- setup ----------

const health = await (await fetch(`${ORIGIN}/healthz`)).json();
record("E10_healthz", health);

const register = await request("PUT", "/settings/mcp-servers", {
  manifest: {
    type: "remote",
    name: "session-probe",
    url: probe.url,
    description: "Throwaway probe server for the session API live check.",
  },
});
record("register_probe_mcp", { status: register.status, body: register.text.slice(0, 500) });

if (MODE === "guard") {
  // E15: with the default network policy, TrueForge refuses the loopback URL
  // already at registration (the record above); nothing more to run.
  console.log(`Saved to ${await saveResults("session-api-results", results)}`);
  probe.stop();
  process.exit(0);
}

const AGENT = "session-probe-glm";
const agentSpec = {
  model: { name: "openrouter/glm-5-3-flash", params: { max_tokens: 16_384 } },
  instructions:
    "You are a fixture for harness experiments. Do exactly what the user asks and nothing more. When asked to call a tool, call it exactly once, then answer in one short sentence.",
  mcp_servers: [{ name: "session-probe", preload: true }],
  config: { iteration_limit: 6 },
};
await upsertAgent(AGENT, "Session API live check (#24)", agentSpec);

const WHOAMI = "Call the whoami tool exactly once, then reply with the word done.";

// ---------- E1–E3: what a tool sees, and correlation ----------

const sessionA = await openExperimentSession(AGENT, EXPERIMENT);
const a1 = await turn(sessionA, WHOAMI, "none");
const a2 = await turn(sessionA, WHOAMI, a1.turn.id);
const sessionB = await openExperimentSession(AGENT, EXPERIMENT);
const b1 = await turn(sessionB, WHOAMI, "none");

record("E1_E3_whoami", {
  turns: {
    a1: { id: a1.turn.id, ...a1.summary, mcpInit: mcpInits(a1.events) },
    a2: { id: a2.turn.id, ...a2.summary, mcpInit: mcpInits(a2.events) },
    b1: { id: b1.turn.id, ...b1.summary, mcpInit: mcpInits(b1.events) },
  },
  sessions: { A: sessionA, B: sessionB },
  calls: whoamiCalls,
  // Every request TrueForge made to the probe, in order.
  probeLog: probe.log.map(({ at, httpMethod, rpcMethod, mcpSessionId, meta }) => ({
    at,
    httpMethod,
    rpcMethod,
    mcpSessionId,
    meta,
  })),
  headerNamesSeen: [...new Set(probe.log.flatMap((r) => Object.keys(r.headers)))].sort(),
});

// ---------- E4: self-cancel through previous_turn_id "auto" ----------

const a3 = await turn(sessionA, "Call the self_fork tool exactly once, then reply with the word done.", a2.turn.id);
// The caller is cancelled as soon as the tool creates its Turn, so `turn()`
// returns while the tool is still in its 4 s sleep. Wait for the tool's record.
for (let i = 0; i < 30 && !selfFork.newTurn; i++) await Bun.sleep(500);
const forked = selfFork.newTurn ? await waitTurn(sessionA, String(selfFork.newTurn), 300_000) : undefined;
const forkedEvents = forked ? await allEvents(sessionA, forked.id) : [];
record("E4_self_cancel", {
  caller: { id: a3.turn.id, state: a3.turn.state, eventTypes: a3.events.map((e) => e.type) },
  toolSaw: selfFork,
  forked: forked && {
    id: forked.id,
    previous_turn_id: forked.previous_turn_id,
    status: forked.state.status,
    answer: lastText(forkedEvents),
  },
});

// ---------- E6: fork from cancelled Turns ----------

const forkCancelledForNext = await turn(sessionA, "Reply with the word ok.", a3.turn.id);
const sessionD = await openExperimentSession(AGENT, EXPERIMENT);
const d1 = await createTurn(
  sessionD,
  "Write the numbers from one to three hundred as English words, one per line.",
  "none",
);
current = { session: sessionD, turn: d1.id };
await Bun.sleep(5_000);
const cancel = await request("POST", `/sessions/${sessionD}/cancel`, {});
const d1Final = await waitTurn(sessionD, d1.id);
const d2 = await turn(sessionD, "Reply with the word ok.", d1.id);
record("E6_fork_from_cancelled", {
  cancelledForNextTurn: {
    from: { id: a3.turn.id, state: a3.turn.state },
    fork: { id: forkCancelledForNext.turn.id, ...forkCancelledForNext.summary },
    answer: lastText(forkCancelledForNext.events),
  },
  clientCancelled: {
    cancelCall: { status: cancel.status, body: cancel.text },
    from: { id: d1.id, state: d1Final.state },
    fork: { id: d2.turn.id, ...d2.summary },
    answer: lastText(d2.events),
  },
});

// ---------- E5: fork from a paused Turn ----------

const sessionC = await openExperimentSession(AGENT, EXPERIMENT);
const c1 = await turn(sessionC, "Call the needs_approval tool exactly once.", "none");
const forkPaused = await request("POST", `/sessions/${sessionC}/turns`, {
  input: [{ type: "user.message", content: "Reply with the word ok." }],
  previous_turn_id: c1.turn.id,
  stream: false,
});
record("E5_fork_from_paused", {
  paused: { id: c1.turn.id, state: c1.turn.state, eventTypes: c1.events.map((e) => e.type) },
  forkAttempt: { status: forkPaused.status, body: forkPaused.text.slice(0, 500) },
});

// ---------- E11: replay a Session into an inline Experiment Session ----------

const sourceS = await openExperimentSession(AGENT, EXPERIMENT);
const topics = [
  "In about 120 words, explain how a lighthouse lens concentrates light.",
  "In about 120 words, explain how sourdough starter makes bread rise.",
  "In about 120 words, explain how a bicycle's derailleur changes gear.",
];
let prev = "none";
for (const t of topics) prev = (await turn(sourceS, t, prev)).turn.id;

// Walk the source's active branch from its tip back to the root, then replay
// its user.message inputs oldest first (at most 5, per #9).
const sourceTurns = await allTurns(sourceS);
const byId = new Map(sourceTurns.map((t) => [t.id, t]));
const chain: Turn[] = [];
for (let t = byId.get(prev); t; t = t.previous_turn_id ? byId.get(t.previous_turn_id) : undefined) chain.unshift(t);
const replayInputs = chain
  .flatMap((t) => (t.input ?? []).filter((i) => i.type === "user.message").map((i) => String(i.content)))
  .slice(-5);

// The inline Session holds its own copy of the Agent's spec, read from the server.
const agents = await api<{ id: string; name: string }[]>("GET", `/agents?name=${AGENT}`);
const agentId = agents.data.find((a) => a.name === AGENT)?.id;
const agentRead = await api<{ manifest?: Record<string, unknown> }>("GET", `/agents/${agentId}`);
const specCopy = (agentRead.data.manifest ?? agentSpec) as typeof agentSpec;

const createInline = await request("POST", "/sessions", {
  agent: { spec: specCopy },
  metadata: { experiment: EXPERIMENT, depth: "1", origin: sourceS, context: "replayed" },
});
const sessionR = (createInline.json as { data: { id: string; agent: unknown } }).data.id;
const replayed: Awaited<ReturnType<typeof turn>>[] = [];
prev = "none";
for (const input of replayInputs) {
  const r = await turn(sessionR, input, prev);
  replayed.push(r);
  prev = r.turn.id;
}
record("E11_replay", {
  source: sourceS,
  specCopySource: agentRead.data.manifest ? "GET /agents/{id} manifest" : "local spec (manifest missing)",
  createInline: { status: createInline.status, agent: (createInline.json as { data: { agent: unknown } }).data.agent },
  inline: sessionR,
  replayedInputs: replayInputs.length,
  turns: replayed.map((r) => ({
    id: r.turn.id,
    previous: r.turn.previous_turn_id,
    status: r.turn.state.status,
    inputTokens: modelUsages(r.events).map((u) => u.input_tokens),
  })),
});

// ---------- E13, E14: PATCH shapes that should be refused ----------

const partialPatch = await request("PATCH", `/sessions/${sessionR}`, {
  agent: { spec: { config: { iteration_limit: 1 } } },
});
const afterPartial = await api<{ agent: { spec?: { config?: unknown } } }>("GET", `/sessions/${sessionR}`);
const namedPatch = await request("PATCH", `/sessions/${sessionA}`, { agent: { spec: specCopy } });
record("E13_E14_patch_refusals", {
  partialSpecOnInline: { status: partialPatch.status, body: partialPatch.text.slice(0, 400) },
  inlineConfigAfter: afterPartial.data.agent.spec?.config,
  fullSpecOnNamed: { status: namedPatch.status, body: namedPatch.text.slice(0, 400) },
});

// ---------- E12: PATCH the inline spec, then the next Turn ----------

// Pick a compaction trigger the next Turn's first model call is sure to cross,
// but which a compacted context falls well under: the fixed part of the prompt
// (harness, instructions, tool definitions) plus half of the message history,
// plus the 931 tokens the compaction check adds for its own prompt.
const lastUsage = modelUsages(replayed.at(-1)?.events ?? []).at(-1) ?? {};
const messagesTokens = lastUsage.input_tokens_breakdown?.messages ?? 0;
const fixedTokens = (lastUsage.input_tokens ?? 0) - messagesTokens;
const trigger = fixedTokens + 931 + Math.floor(messagesTokens / 2);

const withCompaction = structuredClone(specCopy) as Record<string, any>; // a deep copy
withCompaction.config = {
  ...withCompaction.config,
  context_management: { compaction: { enabled: true, trigger: { type: "input_tokens", value: trigger } } },
};
const patchCompaction = await request("PATCH", `/sessions/${sessionR}`, { agent: { spec: withCompaction } });
const r4 = await turn(sessionR, "In one sentence, name the three topics we discussed so far.", prev);
const r4Usages = modelUsages(r4.events);
record("E12a_patch_compaction", {
  patch: { status: patchCompaction.status, body: patchCompaction.text.slice(0, 300) },
  trigger,
  before: { lastInputTokens: lastUsage.input_tokens, messagesTokens, fixedTokens },
  after: {
    id: r4.turn.id,
    status: r4.turn.state.status,
    inputTokensPerCall: r4Usages.map((u) => u.input_tokens),
    messagesTokensPerCall: r4Usages.map((u) => u.input_tokens_breakdown?.messages),
    // A compaction is a model call that is not persisted as a model.message,
    // so the Turn's totals exceed the sum over its model.message events.
    turnTotalInputTokens: r4.turn.state.metrics?.total_input_tokens,
    sumOfModelMessageInputTokens: r4Usages.reduce((n, u) => n + (u.input_tokens ?? 0), 0),
    answer: lastText(r4.events),
  },
});

const withLimit = structuredClone(specCopy) as Record<string, any>;
withLimit.config = { ...withLimit.config, iteration_limit: 1 };
const patchLimit = await request("PATCH", `/sessions/${sessionR}`, { agent: { spec: withLimit } });
const r5 = await turn(sessionR, WHOAMI, r4.turn.id);
const restore = await request("PATCH", `/sessions/${sessionR}`, { agent: { spec: specCopy } });

// ---------- E7: fork from an error Turn ----------

const r6 = await turn(sessionR, "Reply with the word ok.", r5.turn.id);
record("E12b_E7_iteration_limit_and_error_fork", {
  patch: { status: patchLimit.status },
  limited: { id: r5.turn.id, state: r5.turn.state, ...r5.summary },
  restore: { status: restore.status },
  forkFromError: { id: r6.turn.id, ...r6.summary, answer: lastText(r6.events) },
});

// ---------- E9: the SDK under Bun ----------

const sdk = new TrueForge({ baseUrl: ORIGIN, maxRetries: 0 });
const sdkCheck: Record<string, unknown> = {};
try {
  const s = await sdk.sessions.get(sessionA);
  sdkCheck.getSessionKeys = Object.keys(s.data ?? s);
  let count = 0;
  // `for await` drives the SDK's Page, which fetches further pages on demand.
  for await (const t of await sdk.sessions.listTurns(sessionA, { limit: 2 })) {
    count++;
    if (count === 1) sdkCheck.firstTurnKeys = Object.keys(t);
  }
  sdkCheck.turnsIterated = count;
  const events = await sdk.sessions.listTurnEvents(sessionA, a1.turn.id);
  sdkCheck.firstEventPage = events.data.map((e) => e.type);
  sdkCheck.ok = true;
} catch (err) {
  sdkCheck.ok = false;
  sdkCheck.error = String(err);
}
record("E9_sdk", sdkCheck);

// ---------- E8: payload sizes ----------

const sizes = {
  getSession: [] as number[],
  listTurnsPage: [] as number[],
  getTurn: [] as number[],
  eventsPage: [] as number[],
  sessionEventsPage: [] as number[],
};
const perType: Record<string, { count: number; max: number; total: number }> = {};
for (const s of [sessionA, sessionB, sessionC, sessionD, sourceS, sessionR]) {
  sizes.getSession.push((await request("GET", `/sessions/${s}`)).bytes);
  sizes.listTurnsPage.push((await request("GET", `/sessions/${s}/turns?limit=25`)).bytes);
  sizes.sessionEventsPage.push((await request("GET", `/sessions/${s}/events?limit=100`)).bytes);
  for (const t of await allTurns(s)) {
    sizes.getTurn.push((await request("GET", `/sessions/${s}/turns/${t.id}`)).bytes);
    const page = await request("GET", `/sessions/${s}/turns/${t.id}/events?limit=100`);
    sizes.eventsPage.push(page.bytes);
    for (const e of (page.json as { data: Event[] }).data) {
      const n = new TextEncoder().encode(JSON.stringify(e)).length;
      const slot = (perType[e.type] ??= { count: 0, max: 0, total: 0 }); // ??= assigns only if missing
      slot.count++;
      slot.max = Math.max(slot.max, n);
      slot.total += n;
    }
  }
}
const stats = (xs: number[]) => ({ n: xs.length, max: Math.max(...xs), mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) });
record("E8_payload_bytes", {
  ...Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, stats(v)])),
  eventByType: Object.fromEntries(
    Object.entries(perType).map(([k, v]) => [k, { count: v.count, max: v.max, mean: Math.round(v.total / v.count) }]),
  ),
});

results.sessions = { A: sessionA, B: sessionB, C: sessionC, D: sessionD, source: sourceS, inline: sessionR };
console.log(`Saved to ${await saveResults("session-api-results", results)}`);
probe.stop();
