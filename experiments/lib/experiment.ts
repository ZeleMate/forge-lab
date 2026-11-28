// What every Experiment script shares (#12, #82): it opens Experiment Sessions
// (`metadata.experiment` set) on a copy of the registered Cartographer, drives
// Turns over the SSE stream, answers Approval pauses from the decision list in
// `<name>.expected.md`, then marks each expectation met or not and writes
// `<name>-results/<model>/observed.json`. Each run replaces that file: the
// committed record is the latest run, and git history keeps the earlier ones.
//
//   bun run --filter @forge-lab/experiments <name> -- --model glm-5-3-flash
//
// Needs the stack from `bun run dev`.

import { readPin } from "@forge-lab/lib/snapshot";
import {
  api,
  findAgent,
  ORIGIN,
  onSmokeModel,
  openInlineExperimentSession,
  recordJson,
  serverVersion,
  type WireSpec,
} from "@forge-lab/lib/trueforge";
import { z } from "zod";
import { type Decision, parseExpected } from "./expected";
import { readSse } from "./sse";

// The two models the map names for Experiments: GLM for mechanics, Opus where
// the expectation is about Cartographer's real model.
export const EXPERIMENT_MODELS = ["glm-5-3-flash", "opus-5-5"] as const;
export type ExperimentModel = (typeof EXPERIMENT_MODELS)[number];

// ---------- wire shapes ----------
// Only the fields this file reads are checked; `looseObject` keeps the rest,
// so the observed record still has every field TrueForge sent.

const WireEventSchema = z.looseObject({ type: z.string(), id: z.string().optional() });
export type WireEvent = z.infer<typeof WireEventSchema>; // `z.infer` turns a schema into its TypeScript type

export const ToolCallSchema = z.looseObject({
  id: z.string(),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
});
const ModelMessageSchema = z.looseObject({ type: z.literal("model.message"), tool_calls: z.array(ToolCallSchema) });

// A deferred tool is called through the `call_tool` meta-tool, which names the real one.
const CallToolArgsSchema = z.looseObject({ tool_name: z.string() });

const TurnStateSchema = z.looseObject({
  status: z.string(),
  required_actions: z
    .array(z.looseObject({ thread_id: z.string(), tool_calls: z.array(z.looseObject({ id: z.string() })) }))
    .optional(),
  metrics: z.record(z.string(), z.number()).optional(),
});
const TurnSchema = z.looseObject({ id: z.string(), state: TurnStateSchema });
// The first event of every Turn's stream. The wire is snake_case (`turn_id`), on
// the stream as over REST; the SDK's camelCase is the SDK's own conversion.
const TurnCreatedSchema = z.looseObject({ type: z.literal("turn.created"), turn_id: z.string() });
// A page of a list endpoint: TrueForge's `{ data, pagination }` envelope.
const EventsPageSchema = z.looseObject({
  data: z.array(WireEventSchema),
  pagination: z.looseObject({ next_page_token: z.string().nullish() }).optional(),
});

// The longest one streamed Turn may take, past TrueForge's own 600 s execution timeout.
const STREAM_TIMEOUT_MS = 660_000;
export type TurnState = z.infer<typeof TurnStateSchema>;

// ---------- what a Turn leaves behind ----------

export type StreamedEvent = {
  seq: number; // the SSE `id`: TrueForge's per-Turn sequence number
  atMs: number; // when it arrived, counted from the request
  event: WireEvent;
};

export type TurnRun = {
  turnId: string;
  previousTurnId: string | undefined;
  state: TurnState; // as GET .../turns/{id} reads it once the stream has ended
  wallMs: number;
  streamed: StreamedEvent[];
  persisted: WireEvent[]; // GET .../events after the Turn ended
};

export type ApprovalRecord = { pausedTurnId: string; toolCallId: string; tool: string; decision: Decision };

export type Verdict = { verdict: "met" | "not met" | "n/a"; observed: unknown };

export type Context = {
  model: ExperimentModel;
  // Cartographer as registered, moved onto `model` (snake_case, as GET /agents returns it).
  spec: WireSpec;
  // Opens an inline Experiment Session on `spec`, or on a changed copy.
  openSession: (spec?: WireSpec) => Promise<string>;
  // Runs one user message to its end: the Turn, plus one continuation Turn per
  // Approval pause, answered from the decision list.
  turn: (sessionId: string, content: string, previousTurnId?: string) => Promise<TurnRun[]>;
};

// `<O>` is the shape of what `drive` observed; every check reads that same shape.
export type ExperimentDefinition<O> = {
  name: string;
  dir: string; // the folder holding `<name>.expected.md`; pass `import.meta.dir`
  drive: (ctx: Context) => Promise<O>;
  // One check per expectation id in the expected file, no more and no fewer.
  checks: Record<string, (observed: O, model: ExperimentModel) => Verdict>;
};

// ---------- running ----------

export async function runExperiment<O>(def: ExperimentDefinition<O>): Promise<void> {
  const model = parseModel(process.argv.slice(2));
  const expected = parseExpected(await Bun.file(`${def.dir}/${def.name}.expected.md`).text());
  const missing = expected.expectationIds.filter((id) => !(id in def.checks));
  const extra = Object.keys(def.checks).filter((id) => !expected.expectationIds.includes(id));
  if (missing.length || extra.length)
    fail(
      `checks don't match the expected file: missing ${missing.join(", ") || "none"}, extra ${extra.join(", ") || "none"}`,
    );

  const pin = readPin();
  const version = await serverVersion();
  if (version !== pin.version) fail(`TrueForge is ${version}, the snapshot pins ${pin.version}; start \`bun run dev\``);
  const agent = await findAgent("cartographer");
  if (!agent) fail("no cartographer Agent; `bun run dev` applies it");

  // The model is set explicitly, so a run is on the model its folder names even
  // if the registered Agent has been moved to another one.
  const registered = structuredClone(agent.manifest) as WireSpec;
  const spec: WireSpec =
    model === "opus-5-5"
      ? { ...registered, model: { ...registered.model, name: "openrouter/opus-5-5" } }
      : onSmokeModel(agent.manifest);
  const sessions: string[] = [];
  const approvals: ApprovalRecord[] = [];

  const ctx: Context = {
    model,
    spec,
    openSession: async (s = spec) => {
      const id = await openInlineExperimentSession(s, def.name);
      sessions.push(id);
      return id;
    },
    turn: (sessionId, content, previousTurnId) => {
      // Only the Experiment Sessions this run opened: never the user's own chats.
      if (!sessions.includes(sessionId))
        throw new Error(`${sessionId} wasn't opened by this Experiment; use ctx.openSession`);
      return runToEnd(sessionId, content, previousTurnId, expected.approvals, approvals);
    },
  };

  const startedAt = new Date();
  const observed = await def.drive(ctx);
  const durationMs = Date.now() - startedAt.getTime();

  // `Object.fromEntries` builds { E1: verdict, ... } from [id, verdict] pairs, in the file's order.
  const verdicts = Object.fromEntries(
    expected.expectationIds.map((id) => {
      const check = def.checks[id];
      // `check` exists: the match between ids and checks was enforced above.
      return [id, check ? check(observed, model) : { verdict: "not met", observed: "no check" }];
    }),
  );

  const dir = `${def.dir}/${def.name}-results/${model}`;
  const file = `${dir}/observed.json`;
  await Bun.write(
    file,
    recordJson({
      experiment: def.name,
      model: spec.model.name,
      trueforge: version,
      snapshot: pin.sha,
      startedAt: startedAt.toISOString(),
      durationMs,
      sessions,
      approvals,
      verdicts,
      observed,
    }),
  );

  for (const [id, v] of Object.entries(verdicts)) console.log(`${id.padEnd(4)} ${v.verdict}`);
  console.log(`${def.name} on ${model}: ${Math.round(durationMs / 1000)} s. Saved to ${file}`);
}

function parseModel(argv: string[]): ExperimentModel {
  const i = argv.indexOf("--model");
  const value = i === -1 ? "glm-5-3-flash" : argv[i + 1];
  // A type guard: after this `find`, TypeScript knows `found` is one of the listed models.
  const found = EXPERIMENT_MODELS.find((m) => m === value);
  if (!found) fail(`--model must be one of ${EXPERIMENT_MODELS.join(", ")}, not ${value}`);
  return found;
}

// `never` as the return type tells TypeScript the code after a call is unreachable.
function fail(message: string): never {
  console.error(`experiment: ${message}`);
  process.exit(1);
}

// The most Approval pauses one user message may go through before the script stops.
const MAX_PAUSES = 10;

async function runToEnd(
  sessionId: string,
  content: string,
  previousTurnId: string | undefined,
  decisions: Map<string, Decision>,
  log: ApprovalRecord[],
): Promise<TurnRun[]> {
  const runs = [await streamTurn(sessionId, [{ type: "user.message", content }], previousTurnId)];
  for (let pauses = 0; ; pauses++) {
    // `at(-1)` is the last element; the array always has one here.
    const last = runs.at(-1) as TurnRun;
    const answers = answerPause(last, decisions);
    if (answers.length === 0) return runs;
    if (pauses === MAX_PAUSES) throw new Error(`more than ${MAX_PAUSES} Approval pauses in one message`);
    log.push(...answers.map((a) => a.record));
    runs.push(
      await streamTurn(
        sessionId,
        answers.map((a) => a.input),
        last.turnId,
      ),
    );
  }
}

export type ApprovalInput = {
  type: "user.tool_approval";
  thread_id: string;
  tool_call_id: string;
  approval: { status: Decision };
};

// The answers to a Turn's Approval pause, one per paused tool call, taken from
// the decision list; an empty array when the Turn didn't pause. `Pick` keeps
// only the fields it reads, so a test can pass a small object.
export function answerPause(
  run: Pick<TurnRun, "turnId" | "state" | "persisted">,
  decisions: Map<string, Decision>,
): { input: ApprovalInput; record: ApprovalRecord }[] {
  const pending = run.state.status === "done" ? (run.state.required_actions ?? []) : [];
  const calls = run.persisted.flatMap((e) => {
    const m = ModelMessageSchema.safeParse(e);
    return m.success ? m.data.tool_calls : [];
  });
  return pending.flatMap((action) =>
    action.tool_calls.map(({ id }) => {
      const tool = toolName(calls.find((c) => c.id === id));
      const decision = decisions.get(tool);
      // A pause the expected file didn't plan for is a finding, not something to guess.
      if (!decision) throw new Error(`Turn ${run.turnId} paused on ${tool}, which has no decision in ## Approvals`);
      return {
        input: {
          type: "user.tool_approval",
          thread_id: action.thread_id,
          tool_call_id: id,
          approval: { status: decision },
        },
        record: { pausedTurnId: run.turnId, toolCallId: id, tool, decision },
      };
    }),
  );
}

export function toolName(call: z.infer<typeof ToolCallSchema> | undefined): string {
  if (!call) return "<unknown call>";
  if (call.function.name !== "call_tool") return call.function.name;
  // The arguments are a JSON string written by the model, so they're parsed defensively.
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return "call_tool";
  }
  const parsed = CallToolArgsSchema.safeParse(args);
  return parsed.success ? parsed.data.tool_name : "call_tool";
}

// Starts a Turn with `stream: true` and records every SSE message until the
// server closes the stream, then reads back the Turn and its persisted events.
async function streamTurn(sessionId: string, input: unknown[], previousTurnId: string | undefined): Promise<TurnRun> {
  const started = Date.now();
  const res = await fetch(`${ORIGIN}/api/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ input, stream: true, ...(previousTurnId ? { previous_turn_id: previousTurnId } : {}) }),
    // Aborts the request, and the stream reading after it, if the server never closes it.
    signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`POST turns -> HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

  const streamed: StreamedEvent[] = [];
  await readSse(res.body, (m) => {
    const event = WireEventSchema.parse(JSON.parse(m.data));
    streamed.push({ seq: Number(m.id), atMs: Date.now() - started, event });
  });
  const wallMs = Date.now() - started;

  // A wire change (a renamed key) fails here, loudly, rather than being guessed around.
  const created = TurnCreatedSchema.safeParse(streamed.find((s) => s.event.type === "turn.created")?.event);
  if (!created.success) throw new Error(`the stream's turn.created has no turn_id: ${created.error.message}`);
  const turnId = created.data.turn_id;
  const turn = TurnSchema.parse((await api<unknown>("GET", `/sessions/${sessionId}/turns/${turnId}`)).data);
  return {
    turnId,
    previousTurnId,
    state: turn.state,
    wallMs,
    streamed,
    persisted: await persistedEvents(sessionId, turnId),
  };
}

async function persistedEvents(sessionId: string, turnId: string): Promise<WireEvent[]> {
  const out: WireEvent[] = [];
  let token: string | null | undefined;
  do {
    const q = new URLSearchParams({ limit: "100", ...(token ? { page_token: token } : {}) });
    const page = EventsPageSchema.parse(
      await api<unknown>("GET", `/sessions/${sessionId}/turns/${turnId}/events?${q}`),
    );
    out.push(...page.data);
    token = page.pagination?.next_page_token;
  } while (token);
  return out;
}
