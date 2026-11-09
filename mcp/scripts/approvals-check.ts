// Live check of the sessions write tools (#56 "Done when"), on the stack
// `bun run dev` brings up. Not a test: it needs TrueForge, the model and its key.
//
//   bun run --filter @forge-lab/mcp approvals:check
//
// Phase 1, refusals: an MCP client talks to /mcp/sessions directly and calls
// every refusal against real Experiment Sessions (plus one untagged stand-in for
// the user's chat). Expected: each is refused with its reason, and no Session's
// Turns or tags change.
// Phase 2, Approvals: a copy of Cartographer on glm-5-3-flash (in an inline
// Experiment Session, gated `@write` and `@destructive` as registered) is asked
// to call each write tool once. Expected: each call pauses the Turn as `done`
// with a `tool.approval_required`; once the script approves it (as Experiment
// scripts do, #9) the tool runs and changes the target Experiment Session.
// Phase 3, chat reads from sandbox code: a script that calls get_chat_turn must
// fail, and no tool response may carry the stand-in chat's marker word.
// Throughout: no Session outside this script's own changes at all.
// Writes mcp/approvals-results/<timestamp>.json and exits 1 if anything differs.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HOST, PORTS } from "@forge-lab/lib/ports";
import {
  allEvents,
  api,
  createTurn,
  findAgent,
  ORIGIN,
  onSmokeModel,
  openInlineExperimentSession,
  SLOW_PROMPT,
  SMOKE_MODEL,
  saveResults,
  serverVersion,
  type Turn,
  waitTurn,
} from "@forge-lab/lib/trueforge";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { sdkSessionsApi } from "../src/sessions/api";

const EXPERIMENT = "approvals-check";
// The stand-in chat says this word, so any tool response that carries it has read the chat.
const MARKER = `CHATMARK${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const failures: string[] = [];
const results: Record<string, unknown> = { model: SMOKE_MODEL, version: await serverVersion() };

const agent = await findAgent("cartographer");
if (!agent) {
  console.error("approvals: no cartographer Agent; `bun run dev` applies it");
  process.exit(1);
}
const spec = onSmokeModel(agent.manifest);

const sessions = sdkSessionsApi(ORIGIN);

// Every Session's Turn count and tags, to prove what a phase didn't touch.
async function fingerprint(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let cursor: string | undefined;
  do {
    const page = await sessions.listSessions({ limit: 25, ...(cursor ? { cursor } : {}) });
    for (const s of page.items) out[s.id] = `${s.metrics.totalTurns} ${JSON.stringify(s.metadata)}`;
    cursor = page.next;
  } while (cursor);
  return out;
}

function changed(before: Record<string, string>, after: Record<string, string>, allowed: string[]): string[] {
  return Object.keys(before).filter((id) => !allowed.includes(id) && before[id] !== after[id]);
}

// ---------- setup ----------

const target = await openInlineExperimentSession(spec, EXPERIMENT); // what the writes act on
const t1 = await waitTurn(target, (await createTurn(target, "Say hi in one word.", "none")).id);
const caller = await openInlineExperimentSession(spec, EXPERIMENT); // where Cartographer runs
const { data: chat } = await api<{ id: string }>("POST", "/sessions", {
  agent: { spec },
  metadata: { probe: EXPERIMENT }, // no `experiment` tag: it stands in for the user's chat
});
const c1 = await waitTurn(chat.id, (await createTurn(chat.id, `Reply with exactly this word: ${MARKER}`, "none")).id);
const { data: deep } = await api<{ id: string }>("POST", "/sessions", {
  agent: { spec },
  metadata: { experiment: EXPERIMENT, depth: "2" },
});
const d1 = await waitTurn(deep.id, (await createTurn(deep.id, "Say hi in one word.", "none")).id);
// A Turn waiting on an Approval and a depth-1 Session, from the last fixtures recording.
const fixturesDir = join(import.meta.dir, "..", "fixtures-results");
const recording = readdirSync(fixturesDir).sort().at(-1) ?? "";
const fixtures = (await Bun.file(join(fixturesDir, recording)).json()) as {
  sessions: { main: { id: string } };
  turns: { pending: { id: string } };
};
const running = await createTurn(target, SLOW_PROMPT, t1.id);
// A `caller_session_id` only counts for a Session that's mid-Turn, as a real
// caller is, so the two Sessions phase 1 calls "from" each get a running Turn.
const callerBusy = await createTurn(caller, SLOW_PROMPT, "none");
const { data: nested } = await api<{ id: string }>("POST", "/sessions", {
  agent: { spec },
  metadata: { experiment: EXPERIMENT, depth: "1" },
});
const nestedBusy = await createTurn(nested.id, SLOW_PROMPT, "none");

// ---------- phase 1: refusals ----------

const mcp = new Client({ name: "approvals-check", version: "0.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://${HOST}:${PORTS.mcp}/mcp/sessions`)));
const before = await fingerprint();

const own = { caller_session_id: caller };
const REFUSALS: [string, string, Record<string, unknown>, RegExp][] = [
  ["no own Session", "fork_turn", { session_id: target, from_turn_id: t1.id, message: "x" }, /can't tell/],
  [
    "pending Approval",
    "fork_turn",
    { session_id: fixtures.sessions.main.id, from_turn_id: fixtures.turns.pending.id, message: "x", ...own },
    /waiting on an Approval/,
  ],
  ["running", "fork_turn", { session_id: target, from_turn_id: running.id, message: "x", ...own }, /still running/],
  ["auto", "fork_turn", { session_id: target, from_turn_id: "auto", message: "x", ...own }, /explicit Turn id/],
  ["depth 2", "fork_turn", { session_id: deep.id, from_turn_id: d1.id, message: "x", ...own }, /depth/],
  [
    "replay from depth 1",
    "fork_turn",
    {
      session_id: chat.id,
      from_turn_id: c1.id,
      message: "x",
      experiment: "nested",
      estimated_cost_usd: 1,
      caller_session_id: nested.id,
    },
    /depth/,
  ],
  [
    "own Session, in place",
    "fork_turn",
    { session_id: target, from_turn_id: t1.id, message: "x", caller_session_id: target },
    /own Session/,
  ],
  ["rerun own Session", "rerun_turn", { session_id: target, turn_id: t1.id, caller_session_id: target }, /own Session/],
  ["rerun the chat", "rerun_turn", { session_id: chat.id, turn_id: c1.id, ...own }, /not an Experiment Session/],
  ["rerun depth 2", "rerun_turn", { session_id: deep.id, turn_id: d1.id, ...own }, /depth/],
  ["cancel own Session", "cancel_session", { session_id: target, caller_session_id: target }, /own Session/],
  ["cancel the chat", "cancel_session", { session_id: chat.id, ...own }, /not an Experiment Session/],
  ["cancel depth 2", "cancel_session", { session_id: deep.id, ...own }, /depth/],
  // This client isn't any Session, so the chat isn't its own.
  ["read the chat", "get_turn", { session_id: chat.id }, /the user's chat/],
  ["chat events", "list_events", { session_id: chat.id, turn_id: c1.id }, /the user's chat/],
];
const refusals: Record<string, string> = {};
for (const [label, tool, args, reason] of REFUSALS) {
  const r = await mcp.callTool({ name: tool, arguments: args });
  const text = (r.content as { text?: string }[])[0]?.text ?? "";
  refusals[label] = text;
  if (!r.isError || !reason.test(text)) failures.push(`refusal "${label}": ${text}`);
}
const afterRefusals = await fingerprint();
// The slow Turn may finish meanwhile, which moves no counts or tags.
const touched = changed(before, afterRefusals, []);
if (touched.length) failures.push(`refusals changed Sessions: ${touched.join(", ")}`);
results.refusals = refusals;
await mcp.close();
await api("POST", `/sessions/${target}/cancel`, {});
await waitTurn(target, running.id);
// `as const` makes these fixed-length tuples with a type per position, not string[] arrays.
for (const [id, turn] of [
  [caller, callerBusy],
  [nested.id, nestedBusy],
] as const) {
  await api("POST", `/sessions/${id}/cancel`, {});
  await waitTurn(id, turn.id);
}

// ---------- phase 2: Approvals ----------

type Step = { tool: string; args: Record<string, unknown>; beforeApproval?: () => Promise<void> };
let slowForCancel: Turn | undefined;
const STEPS: Step[] = [
  { tool: "fork_turn", args: { session_id: target, from_turn_id: t1.id, message: "Say bye in one word." } },
  { tool: "rerun_turn", args: { session_id: target, turn_id: t1.id } },
  // Read-only, but gated by name in Cartographer's spec.
  { tool: "get_chat_turn", args: { session_id: chat.id } },
  {
    tool: "cancel_session",
    args: { session_id: target },
    // The tip must be running when the approved call runs, so it starts now.
    beforeApproval: async () => {
      const tip = await sessions.tipTurnId(target);
      slowForCancel = await createTurn(target, SLOW_PROMPT, tip ?? "none");
    },
  },
];

const approvals: Record<string, unknown> = {};
let previous = "none";
for (const step of STEPS) {
  // A write into a Session with a running Turn is refused, so the last step's
  // Turn in the target finishes first.
  for (const t of await sessions.listTurns(target)) if (t.state.status === "running") await waitTurn(target, t.id);
  const ask = `Call the sessions tool ${step.tool} exactly once with exactly these arguments, then stop: ${JSON.stringify(step.args)}`;
  const paused = await waitTurn(caller, (await createTurn(caller, ask, previous)).id);
  const state = paused.state as {
    status: string;
    required_actions?: { thread_id: string; tool_calls: { id: string }[] }[];
  };
  const pending = state.required_actions?.[0];
  const events = await allEvents(caller, paused.id);
  // The call the gate stopped, as the model made it (a deferred tool goes through `call_tool`).
  const gated = events
    .filter((e) => e.type === "model.message")
    .flatMap((e) => (e.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[])
    .find((c) => c.id === pending?.tool_calls[0]?.id);
  const record: Record<string, unknown> = { pausedTurn: paused.id, status: state.status, gated: gated?.function };
  approvals[step.tool] = record;
  if (state.status !== "done" || !pending || !gated?.function.arguments.includes(step.tool)) {
    failures.push(`${step.tool}: no Approval pause (status ${state.status})`);
    previous = paused.id;
    continue;
  }
  const targetBefore = await sessions.getSession(target);
  await step.beforeApproval?.();
  // The approval goes in as a new Turn that continues the paused one.
  const { data: resumed } = await api<Turn>("POST", `/sessions/${caller}/turns`, {
    input: pending.tool_calls.map((c) => ({
      type: "user.tool_approval",
      thread_id: pending.thread_id,
      tool_call_id: c.id,
      approval: { status: "allow" },
    })),
    previous_turn_id: paused.id,
    stream: false,
  });
  const done = await waitTurn(caller, resumed.id);
  const response = (await allEvents(caller, done.id)).find(
    (e) => e.type === "tool.response" && e.tool_call_id === gated.id,
  );
  record.toolResponse = String(response?.content ?? "").slice(0, 600);
  const targetAfter = await sessions.getSession(target);
  record.targetTurns = [targetBefore.metrics.totalTurns, targetAfter.metrics.totalTurns];
  if (!response || String(response.content).startsWith("refused"))
    failures.push(`${step.tool}: didn't run after Approval`);
  previous = done.id;
}
if (slowForCancel) {
  const cancelled = await waitTurn(target, slowForCancel.id);
  (approvals.cancel_session as Record<string, unknown>).cancelledTurn = cancelled.state;
  if (cancelled.state.reason !== "client-cancelled") failures.push("cancel_session: the tip wasn't client-cancelled");
}
results.approvals = approvals;
const chatRead = String((approvals.get_chat_turn as Record<string, unknown> | undefined)?.toolResponse ?? "");
if (!chatRead.includes(MARKER)) failures.push("get_chat_turn: the approved call didn't return the chat");

// ---------- phase 3: chat reads from sandbox code ----------

// TrueForge refuses a name-gated tool from Code Mode (CodeModeDispatcher), so a
// script must fail to read the chat, and no tool response may carry the marker.
const script = `Using code mode, write and run ONE sandbox script that calls the sessions tool get_chat_turn with {"session_id": "${chat.id}"} and prints the result. Don't call get_chat_turn directly. Report what the script printed.`;
// A new root Turn: phase 2's approved read put the marker in the caller's context,
// and a script echoing it from there would look like a leak.
const codeTurn = await waitTurn(caller, (await createTurn(caller, script, "none")).id, 300_000);
const codeEvents = await allEvents(caller, codeTurn.id);
const calls = codeEvents
  .filter((e) => e.type === "model.message")
  .flatMap((e) => (e.tool_calls ?? []) as { function: { name: string; arguments: string } }[])
  .map((c) => c.function);
const leaked = codeEvents.some((e) => e.type === "tool.response" && String(e.content ?? "").includes(MARKER));
const ranScript = calls.some((c) => c.name === "exec" || c.name.includes("code"));
results.codeMode = {
  turn: codeTurn.id,
  status: codeTurn.state.status,
  calls: calls.map((c) => c.name),
  leaked,
  responses: codeEvents.filter((e) => e.type === "tool.response").map((e) => String(e.content ?? "").slice(0, 400)),
};
if (leaked) failures.push("code mode: a tool response carried the chat's marker");
if (!ranScript) failures.push("code mode: no sandbox script ran, so the path wasn't tested");

// Nothing outside this script's Sessions moved, across both phases.
const ours = [target, caller, chat.id, deep.id, nested.id];
const outside = changed(before, await fingerprint(), ours);
if (outside.length) failures.push(`Sessions outside the check changed: ${outside.join(", ")}`);
results.sessions = {
  target,
  caller,
  chat: chat.id,
  deep: deep.id,
  untouchedOthers: Object.keys(before).length - ours.length,
};
results.failures = failures;

console.log(
  JSON.stringify({ refusals: Object.keys(refusals).length, approvals, codeMode: results.codeMode, failures }, null, 2),
);
console.log(`Saved to ${await saveResults(`${import.meta.dir}/../approvals-results`, results)}`);
process.exit(failures.length ? 1 : 0);
