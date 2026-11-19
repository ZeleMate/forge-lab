// Records the TrueForge payloads the sessions tests replay (#54, #56): one
// scripted Experiment Session on glm-5-3-flash, driven through every Turn state
// the tools have to handle, then read back through the same `SessionsApi` the
// tools use, so the fixtures have exactly the shapes the tools see.
//
//   bun run --filter @forge-lab/mcp fixtures:record     (needs `bun run dev`)
//
// Expected states, written before the first run:
//   pending          done, with 1 required action (an Approval on source_status)
//   running          running, read right after it was created
//   next-turn        cancelled, reason cancelled-for-next-turn
//   after-next       done
//   client-cancel    cancelled, reason client-cancelled
//   iteration-limit  error (iteration_limit 1, in a fork tagged depth 1)
// Writes mcp/fixtures-results/<timestamp>.json and exits 1 if a state differs.

import { readPin } from "@forge-lab/lib/snapshot";
import {
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
  type WireSpec,
  waitTurn,
} from "@forge-lab/lib/trueforge";
import { type SessionEvent, sdkSessionsApi, type Turn } from "../src/sessions/api";

const EXPERIMENT = "fixtures-record";

const pin = readPin();
const version = await serverVersion();
if (version !== pin.version) {
  console.error(`fixtures: TrueForge is ${version}, the snapshot pins ${pin.version}; start it with \`bun run dev\``);
  process.exit(1);
}
const agent = await findAgent("cartographer");
if (!agent) {
  console.error("fixtures: no cartographer Agent; `bun run dev` applies it");
  process.exit(1);
}

// Copies of the registered spec (snake_case, as GET /agents returns it) on GLM,
// which rejects reasoning_effort. `pending` needs an Approval on a harmless
// read, so the copy gates every source tool.
const base = onSmokeModel(agent.manifest);
const gated: WireSpec = {
  ...base,
  mcp_servers: base.mcp_servers?.map((s) => (s.name === "source" ? { ...s, require_approval_for_tools: ["@all"] } : s)),
};

const sessions = sdkSessionsApi(ORIGIN);
const turns: Record<string, Turn> = {};

// Waits with the lib's poller, then reads the Turn once more through the SDK,
// since the fixtures must have the SDK's camelCase shape.
async function settle(sessionId: string, turnId: string): Promise<Turn> {
  await waitTurn(sessionId, turnId);
  return sessions.getTurn(sessionId, turnId);
}

// Session A: the main line.
const a = await openInlineExperimentSession(gated, EXPERIMENT);

const pending = await createTurn(a, "Call the source_status tool once and tell me the TrueForge version.", "none");
turns.pending = await settle(a, pending.id);

// A new root, read at once while it runs; then a Turn chained on it freezes it.
const slow = await createTurn(a, SLOW_PROMPT, "none");
turns.running = await sessions.getTurn(a, slow.id);
const next = await createTurn(a, "Say hello in one word.", slow.id);
turns["after-next"] = await settle(a, next.id);
turns["next-turn"] = await sessions.getTurn(a, slow.id);

const toCancel = await createTurn(a, SLOW_PROMPT, next.id);
await Bun.sleep(1_000);
await api("POST", `/sessions/${a}/cancel`, {});
turns["client-cancel"] = await settle(a, toCancel.id);

// Session B: a fork of A tagged one level deeper, where one tool call is too many.
const { data: b } = await api<{ id: string }>("POST", "/sessions", {
  agent: { spec: { ...base, config: { ...base.config, iteration_limit: 1 } } },
  metadata: { experiment: EXPERIMENT, depth: "1", origin: `${a}:${next.id}` },
});
const limited = await createTurn(b.id, "Call source_status, then search_text for AgentThread, then answer.", "none");
turns["iteration-limit"] = await settle(b.id, limited.id);

// Read everything back through the tools' own seam.
const events: Record<string, SessionEvent[]> = {};
for (const [label, turn] of Object.entries(turns))
  events[label] = (await sessions.listTurnEvents(turn.sessionId, turn.id, { limit: 100 })).items;

const expected: Record<string, string> = {
  pending: "done+1",
  running: "running",
  "next-turn": "cancelled:cancelled-for-next-turn",
  "after-next": "done+0",
  "client-cancel": "cancelled:client-cancelled",
  "iteration-limit": "error",
};
const observed = Object.fromEntries(Object.entries(turns).map(([label, t]) => [label, stateOf(t)]));
const mismatches = Object.keys(expected).filter((k) => expected[k] !== observed[k]);

const file = await saveResults(`${import.meta.dir}/../fixtures-results`, {
  version,
  model: SMOKE_MODEL,
  sessions: { main: await sessions.getSession(a), fork: await sessions.getSession(b.id) },
  listed: (await sessions.listSessions({ limit: 5, metadata: { experiment: EXPERIMENT } })).items,
  expected,
  observed,
  turns,
  events,
});
console.log(observed);
console.log(mismatches.length ? `MISMATCH: ${mismatches.join(", ")}` : "all states as expected");
console.log(`Saved to ${file}`);
process.exit(mismatches.length ? 1 : 0);

function stateOf(t: Turn): string {
  const s = t.state;
  if (s.status === "done") return `done+${s.requiredActions.length}`;
  if (s.status === "cancelled") return `cancelled:${s.reason}`;
  return s.status;
}
