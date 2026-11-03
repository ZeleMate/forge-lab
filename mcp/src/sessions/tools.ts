// The sessions server's eight tools (#8, amended by #9 and #24): five reads
// that inspect TrueForge's own Sessions, and three Approval-gated writes that
// act only on Experiment Sessions. Every result is labelled `observed` and
// cites `{session_id, turn_id, event_id}`.
//
// Write safety, in the order the checks run:
// 1. the tool must know its own Session (auto-detected, or `caller_session_id`);
// 2. only Experiment Sessions are changed in place; the user's chat is only
//    ever read, and a fork from it replays into a new Experiment Session;
// 3. depth 2 or more is refused, and so is the caller's own Session in place;
// 4. a source Turn must be finished and not waiting on an Approval (#24: the
//    server would accept it), and every create names an explicit Turn id.
// Only after all of that does a mutating call go out.

import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Clock } from "../clock";
import { fitList, guarded, listCut, maxChars, ok, refuse } from "../result";
import type { Session, SessionEvent, SessionsApi, Turn, TurnInputItem } from "./api";
import { depthOf, type FindOwn, type OwnSession, ownSessionFinder } from "./own";
import {
  EventView,
  eventView,
  excerpt,
  Metrics,
  requiredActions,
  SessionCitation,
  SessionSummary,
  sessionSummary,
  TurnSummary,
  textOf,
  turnSummary,
} from "./project";
import { applyConfigPatch, ConfigPatch } from "./spec";

// `spawn` runs work that outlives the tool call (a replay); tests pass one
// that collects the promises so they can await them.
export type SessionsDeps = { api: SessionsApi; clock: Clock; spawn?: (task: Promise<void>) => void };

export const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
// `@write` matches readOnlyHint false; `@destructive` matches destructiveHint true (#8).
export const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
export const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = { ...WRITE_ANNOTATIONS, destructiveHint: true };

export const MAX_REPLAY = 5;
const POLL_MS = 2_000;
// A replayed Turn may take a while on Opus; TrueForge itself stops a Turn at 600 s.
const REPLAY_TURN_TIMEOUT_MS = 660_000;
// A replay's cost estimate may be rough, but not hide most of the real cost.
const MIN_ESTIMATE_SHARE = 0.5;

const sessionId = z.string().min(1).describe("A Session id, as list_sessions returns it.");
const turnIdInput = z.string().min(1).describe("A Turn id, as get_turn returns it. Never `auto` or `none`.");
const callerSessionId = z
  .string()
  .min(1)
  .optional()
  .describe("The Session you are running in. Only needed when the tool says it can't tell.");
const experimentName = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case, e.g. compaction-trigger")
  .max(60);

const isExperiment = (s: Session) => s.metadata.experiment !== undefined;

export function registerSessionsTools(server: McpServer, deps: SessionsDeps, mcpSessionId: string): void {
  const { api, clock } = deps;
  const findOwn: FindOwn = ownSessionFinder(api, mcpSessionId);
  const spawn =
    deps.spawn ??
    ((task: Promise<void>) => {
      // A background replay has nobody to report to, so a failure is logged.
      task.catch((error) => console.error("replay failed:", error));
    });

  // ---------- shared checks ----------

  // The write tools' own-Session check: the first thing every write does.
  async function ownOrRefuse(override?: string): Promise<OwnSession | CallToolResult> {
    const own = await findOwn(override);
    return (
      own ??
      refuse(
        "can't tell which Session I'm running in, so I can't rule out acting on it",
        "pass caller_session_id (your Session's id)",
      )
    );
  }

  // `own is CallToolResult` is a type predicate: where it returns true,
  // TypeScript narrows the value to a refusal.
  const isRefusal = (v: unknown): v is CallToolResult => typeof v === "object" && v !== null && "isError" in v;

  function checkSourceTurn(turn: Turn): CallToolResult | undefined {
    if (turn.state.status === "running" || turn.state.status === "paused")
      return refuse(`Turn ${turn.id} is still running`, "wait_turn until it finishes, or pick a finished Turn");
    if (requiredActions(turn) > 0)
      return refuse(
        `Turn ${turn.id} is waiting on an Approval or answer (${requiredActions(turn)} pending)`,
        "pick an earlier Turn, or resolve it in the UI first",
      );
    return undefined;
  }

  function checkTurnId(id: string): CallToolResult | undefined {
    if (id === "auto" || id === "none")
      return refuse(`\`${id}\` isn't allowed: every write names an explicit Turn id`, "get_turn to find the Turn's id");
    return undefined;
  }

  function checkDepth(session: Session): CallToolResult | undefined {
    const depth = depthOf(session.metadata);
    if (depth >= 2)
      return refuse(
        `Session ${session.id} is at depth ${session.metadata.depth}; writes stop at depth 2`,
        "work in a shallower Experiment Session",
      );
    return undefined;
  }

  // ---------- reads ----------

  server.registerTool(
    "list_sessions",
    {
      title: "List Sessions",
      description:
        "TrueForge Sessions, most recently updated first: the user's chats and Experiment Sessions (tagged `experiment`). Filter by Agent name or tags.",
      inputSchema: z.object({
        agent_name: z.string().optional().describe("Only Sessions bound to this named Agent, e.g. cartographer."),
        experiment: z.string().optional().describe("Only Experiment Sessions with this `experiment` tag."),
        metadata: z.record(z.string(), z.string()).default({}).describe("Other exact-match tags."),
        limit: z.number().int().min(1).max(25).default(10),
        cursor: z.string().optional().describe("`next_cursor` from the previous call."),
        max_chars: maxChars,
      }),
      outputSchema: z.object({
        provenance: z.literal("observed"),
        sessions: z.array(SessionSummary),
        next_cursor: z.string().optional(),
        ...listCut,
      }),
      annotations: READ_ANNOTATIONS,
    },
    guarded(async (args) => {
      let agentId: string | undefined;
      if (args.agent_name) {
        agentId = await api.findAgentId(args.agent_name);
        if (!agentId) return refuse(`no Agent named ${args.agent_name}`, "omit agent_name to list every Session");
      }
      const metadata = { ...args.metadata, ...(args.experiment ? { experiment: args.experiment } : {}) };
      const page = await api.listSessions({
        limit: args.limit,
        ...(agentId ? { agentId } : {}),
        ...(Object.keys(metadata).length ? { metadata } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
      });
      return ok(
        fitList(
          { provenance: "observed" as const, ...(page.next ? { next_cursor: page.next } : {}) },
          "sessions",
          page.items.map(sessionSummary),
          args.max_chars,
        ),
      );
    }),
  );

  server.registerTool(
    "get_turn",
    {
      title: "Get a Turn",
      description:
        "One Turn in detail (input, status, output, pending Approvals, metrics), plus the Session's Turns newest first so you can find other ids. Without turn_id, shows the newest Turn.",
      inputSchema: z.object({
        session_id: sessionId,
        turn_id: z.string().min(1).optional(),
        max_chars: maxChars,
      }),
      outputSchema: z.object({
        provenance: z.literal("observed"),
        session: SessionSummary,
        turn: TurnSummary.extend({ output: z.string().optional(), pending: z.array(z.string()).optional() }),
        turns: z.array(TurnSummary),
        ...listCut,
      }),
      annotations: READ_ANNOTATIONS,
    },
    guarded(async (args) => {
      const [session, turns] = await Promise.all([api.getSession(args.session_id), api.listTurns(args.session_id)]);
      const turn = args.turn_id ? turns.find((t) => t.id === args.turn_id) : turns.at(-1);
      if (!turn)
        return refuse(
          args.turn_id ? `no Turn ${args.turn_id} in Session ${args.session_id}` : "this Session has no Turns",
          "omit turn_id to see the newest Turn and the list of ids",
        );
      const output = turn.state.status === "done" && turn.state.output ? textOf(turn.state.output.content) : "";
      const pending = turn.state.status === "done" ? turn.state.requiredActions.map((a) => a.type) : [];
      const detail = {
        ...turnSummary(turn, 2_000),
        ...(output ? { output: excerpt(output, 4_000) } : {}),
        ...(pending.length ? { pending } : {}),
      };
      return ok(
        fitList(
          { provenance: "observed" as const, session: sessionSummary(session), turn: detail },
          "turns",
          [...turns].reverse().map((t) => turnSummary(t, 120)),
          args.max_chars,
        ),
      );
    }),
  );

  server.registerTool(
    "list_events",
    {
      title: "List a Turn's events",
      description:
        "One Turn's persisted events, oldest first, projected: model messages (text excerpt, tool calls, usage), tool responses (size, excerpt), MCP connections, Approval requests. A running Turn shows everything up to now, without streamed text.",
      inputSchema: z.object({
        session_id: sessionId,
        turn_id: z.string().min(1),
        types: z.array(z.string()).default([]).describe('Only these event types, e.g. ["model.message"].'),
        thread_id: z.string().optional().describe("Only this thread (the main agent or one Subagent)."),
        limit: z.number().int().min(1).max(100).default(50).describe("Events read per call, before filtering."),
        cursor: z.string().optional(),
        excerpt_chars: z.number().int().min(0).max(2_000).default(300),
        max_chars: maxChars,
      }),
      outputSchema: z.object({
        provenance: z.literal("observed"),
        events: z.array(EventView),
        next_cursor: z.string().optional(),
        ...listCut,
      }),
      annotations: READ_ANNOTATIONS,
    },
    guarded(async (args) => {
      const page = await api.listTurnEvents(args.session_id, args.turn_id, {
        limit: args.limit,
        ...(args.cursor ? { cursor: args.cursor } : {}),
      });
      const events = page.items
        .filter((e) => !args.types.length || args.types.includes(e.type))
        .filter((e) => !args.thread_id || ("threadId" in e && e.threadId === args.thread_id))
        .map((e) => eventView(args.session_id, args.turn_id, e, args.excerpt_chars));
      return ok(
        fitList(
          { provenance: "observed" as const, ...(page.next ? { next_cursor: page.next } : {}) },
          "events",
          events,
          args.max_chars,
        ),
      );
    }),
  );

  const TurnStats = z.object({
    citation: SessionCitation,
    status: z.string(),
    duration_ms: z.number().optional(),
    metrics: Metrics,
    // Summed from `model.message` usage when the Turn has no metrics yet (running,
    // or cancelled for the next Turn, #24).
    metrics_from: z.enum(["turn", "events"]),
    model_calls: z.number().int(),
    tool_calls: z.number().int(),
    threads: z.number().int(),
  });

  server.registerTool(
    "session_stats",
    {
      title: "Session stats",
      description:
        "Token, cost and timing figures for a Session's newest Turns, with model calls, tool calls and Subagent threads per Turn, and the latest context breakdown (harness, instructions, tools, messages).",
      inputSchema: z.object({
        session_id: sessionId,
        last_turns: z.number().int().min(1).max(25).default(10),
        max_chars: maxChars,
      }),
      outputSchema: z.object({
        provenance: z.literal("observed"),
        session: SessionSummary,
        context_breakdown: z.record(z.string(), z.number()).optional(),
        turns: z.array(TurnStats),
        ...listCut,
      }),
      annotations: READ_ANNOTATIONS,
    },
    guarded(async (args) => {
      const [session, turns] = await Promise.all([api.getSession(args.session_id), api.listTurns(args.session_id)]);
      let breakdown: Record<string, number> | undefined;
      const rows: z.infer<typeof TurnStats>[] = [];
      for (const turn of turns.slice(-args.last_turns).reverse()) {
        const events = await allEvents(api, args.session_id, turn.id);
        const messages = events.filter((e) => e.type === "model.message");
        // `flatMap` maps and flattens one level, so per-message lists become one list.
        const usage = messages.flatMap((m) => (m.usage ? [m.usage] : []));
        const last = usage.at(-1);
        if (!breakdown && last) breakdown = { ...last.inputTokensBreakdown };
        const s = turn.state;
        const m = "metrics" in s ? s.metrics : undefined;
        rows.push({
          citation: { session_id: args.session_id, turn_id: turn.id },
          status: s.status,
          ...("completedAt" in s ? { duration_ms: Date.parse(s.completedAt) - Date.parse(turn.createdAt) } : {}),
          metrics: m
            ? {
                input_tokens: m.totalInputTokens,
                output_tokens: m.totalOutputTokens,
                reasoning_tokens: m.totalReasoningTokens,
                cache_read_tokens: m.totalCacheReadTokens,
                cost_usd: m.totalCostInUsd,
              }
            : {
                input_tokens: sum(usage.map((u) => u.inputTokens)),
                output_tokens: sum(usage.map((u) => u.outputTokens)),
                cache_read_tokens: sum(usage.map((u) => u.cacheReadTokens ?? 0)),
              },
          metrics_from: m ? "turn" : "events",
          model_calls: messages.length,
          tool_calls: sum(messages.map((e) => e.toolCalls?.length ?? 0)),
          threads: events.filter((e) => e.type === "thread.created").length,
        });
      }
      return ok(
        fitList(
          {
            provenance: "observed" as const,
            session: sessionSummary(session),
            ...(breakdown ? { context_breakdown: breakdown } : {}),
          },
          "turns",
          rows,
          args.max_chars,
        ),
      );
    }),
  );

  server.registerTool(
    "wait_turn",
    {
      title: "Wait for a Turn",
      description:
        "Polls a Turn every 2 s until it stops running, for at most timeout_s (under 90). Returns its summary, or still_running: call it again to keep waiting.",
      inputSchema: z.object({
        session_id: sessionId,
        turn_id: z.string().min(1),
        timeout_s: z.number().int().min(1).max(85).default(60),
      }),
      outputSchema: z.object({
        provenance: z.literal("observed"),
        still_running: z.boolean(),
        waited_ms: z.number(),
        turn: TurnSummary,
      }),
      annotations: READ_ANNOTATIONS,
    },
    guarded(async (args) => {
      const started = clock.now();
      const deadline = started + args.timeout_s * 1000;
      let turn = await api.getTurn(args.session_id, args.turn_id);
      while (turn.state.status === "running" && clock.now() < deadline) {
        await clock.sleep(Math.min(POLL_MS, deadline - clock.now()));
        turn = await api.getTurn(args.session_id, args.turn_id);
      }
      return ok({
        provenance: "observed" as const,
        still_running: turn.state.status === "running",
        waited_ms: clock.now() - started,
        turn: turnSummary(turn, 500),
      });
    }),
  );

  // ---------- writes ----------

  const WriteResult = z.object({
    provenance: z.literal("observed"),
    citation: SessionCitation,
    mode: z.enum(["in-place", "replay", "cancel"]),
    context: z.enum(["kept", "replayed"]).optional(),
    status: z.string(),
    note: z.string(),
  });

  server.registerTool(
    "fork_turn",
    {
      title: "Fork from a Turn",
      description: `Sends a new message from a finished Turn. In an Experiment Session the fork happens in place. From the user's chat it never touches the chat: it opens a new inline Experiment Session (tagged experiment, depth, origin) and replays up to ${MAX_REPLAY} user messages up to that Turn, then your message, in the background. Give the replay's cost estimate (session_stats) in estimated_cost_usd. Needs the user's Approval.`,
      inputSchema: z.object({
        session_id: sessionId,
        from_turn_id: turnIdInput,
        message: z.string().min(1),
        experiment: experimentName
          .optional()
          .describe("Name for the new Experiment Session; required when forking from the user's chat."),
        estimated_cost_usd: z
          .number()
          .min(0)
          .optional()
          .describe("Estimated cost of the replay; required when forking from the user's chat."),
        config_patch: ConfigPatch.optional(),
        caller_session_id: callerSessionId,
      }),
      outputSchema: WriteResult,
      annotations: WRITE_ANNOTATIONS,
    },
    guarded(async (args) => {
      const own = await ownOrRefuse(args.caller_session_id);
      if (isRefusal(own)) return own;
      const bad = checkTurnId(args.from_turn_id);
      if (bad) return bad;
      const [session, turns] = await Promise.all([api.getSession(args.session_id), api.listTurns(args.session_id)]);
      const source = turns.find((t) => t.id === args.from_turn_id);
      if (!source) return refuse(`no Turn ${args.from_turn_id} in Session ${args.session_id}`, "get_turn for the ids");
      const deep = checkDepth(session);
      if (deep) return deep;
      const unfinished = checkSourceTurn(source);
      if (unfinished) return unfinished;
      const message: TurnInputItem = { type: "user.message", content: args.message };

      if (isExperiment(session)) {
        if (session.id === own.sessionId)
          return refuse(
            "an in-place fork of my own Session would move its tip off this Turn",
            "fork another Experiment Session",
          );
        const patched = await patchInPlace(session, args.config_patch);
        if (isRefusal(patched)) return patched;
        const turn = await api.createTurn(session.id, { input: [message], previousTurnId: source.id });
        return ok({
          provenance: "observed" as const,
          citation: { session_id: session.id, turn_id: turn.id },
          mode: "in-place" as const,
          context: "kept" as const,
          status: turn.state.status,
          note: "wait_turn to follow it",
        });
      }

      // The user's chat: replay into a new inline Experiment Session.
      const depth = own.depth + 1;
      if (depth >= 2)
        return refuse(
          `I'm running at depth ${own.depth}, so a new Experiment Session would be depth ${depth}; writes stop at depth 2`,
          "fork from inside the user's chat or a depth-0 Session",
        );
      if (!args.experiment)
        return refuse(
          "forking the user's chat opens a new Experiment Session, which needs an experiment name",
          "set experiment, e.g. compaction-trigger",
        );
      const path = branchTo(turns, source.id);
      const replayed = path.filter((t) => (t.input ?? []).some((i) => i.type === "user.message"));
      if (replayed.length > MAX_REPLAY)
        return refuse(
          `the replay would be ${replayed.length} user Turns, more than ${MAX_REPLAY}`,
          "fork from an earlier Turn",
        );
      const cost = sum(replayed.map(costOf));
      if (args.estimated_cost_usd === undefined || args.estimated_cost_usd < cost * MIN_ESTIMATE_SHARE)
        return refuse(
          `estimated_cost_usd must show the replay's cost: the replayed Turns cost $${cost.toFixed(4)} last time`,
          `set estimated_cost_usd to at least ${(cost * MIN_ESTIMATE_SHARE).toFixed(4)} (session_stats has the figures)`,
        );
      const base = session.agent.type === "inline" ? session.agent.spec : await api.getAgentSpec(session.agent.id);
      const spec = args.config_patch ? applyConfigPatch(base, args.config_patch) : { ok: true as const, spec: base };
      if (!spec.ok) return refuse(`config_patch doesn't fit the spec: ${spec.reason}`, "fix the patch's values");

      const tags = {
        experiment: args.experiment,
        depth: String(depth),
        origin: `${session.id}:${source.id}`,
        replay: "running",
      };
      const created = await api.createSession({ spec: spec.spec, metadata: tags });
      const inputs = [...replayed.map(userMessagesOf), [message]];
      spawn(replay(created.id, tags, inputs));
      return ok({
        provenance: "observed" as const,
        citation: { session_id: created.id },
        mode: "replay" as const,
        context: "replayed" as const,
        status: "replaying",
        note: `replaying ${replayed.length} user Turns, then your message, one at a time. Its tag \`replay\` becomes done or failed:<reason>; get_turn on ${created.id} to follow it.`,
      });
    }),
  );

  server.registerTool(
    "rerun_turn",
    {
      title: "Re-run a Turn",
      description:
        "Runs a finished Turn's input again from the same parent, in place, in an Experiment Session only, optionally after a config_patch to its spec. Needs the user's Approval.",
      inputSchema: z.object({
        session_id: sessionId,
        turn_id: turnIdInput,
        config_patch: ConfigPatch.optional(),
        caller_session_id: callerSessionId,
      }),
      outputSchema: WriteResult,
      annotations: WRITE_ANNOTATIONS,
    },
    guarded(async (args) => {
      const own = await ownOrRefuse(args.caller_session_id);
      if (isRefusal(own)) return own;
      const bad = checkTurnId(args.turn_id);
      if (bad) return bad;
      const session = await api.getSession(args.session_id);
      if (!isExperiment(session))
        return refuse(
          `Session ${session.id} is not an Experiment Session, so it's read-only`,
          "fork_turn from it instead, which replays into a new Experiment Session",
        );
      if (session.id === own.sessionId)
        return refuse(
          "re-running a Turn in my own Session would move its tip off this Turn",
          "use another Experiment Session",
        );
      const deep = checkDepth(session);
      if (deep) return deep;
      const source = await api.getTurn(session.id, args.turn_id);
      const unfinished = checkSourceTurn(source);
      if (unfinished) return unfinished;
      const input = source.input ?? [];
      if (!input.length || input.some((i) => i.type !== "user.message"))
        return refuse(
          `Turn ${source.id} wasn't started by a user message (it answered an Approval)`,
          "re-run the Turn before it",
        );
      const patched = await patchInPlace(session, args.config_patch);
      if (isRefusal(patched)) return patched;
      const turn = await api.createTurn(session.id, { input, previousTurnId: source.previousTurnId ?? "none" });
      return ok({
        provenance: "observed" as const,
        citation: { session_id: session.id, turn_id: turn.id },
        mode: "in-place" as const,
        context: "kept" as const,
        status: turn.state.status,
        note: `re-runs ${source.id}'s input from ${source.previousTurnId ?? "the root"}; wait_turn to follow it`,
      });
    }),
  );

  server.registerTool(
    "cancel_session",
    {
      title: "Cancel an Experiment Session's running Turn",
      description:
        "Cancels the running Turn at an Experiment Session's tip (TrueForge cancels per Session, not per Turn). Never the user's chat or this Session. Needs the user's Approval.",
      inputSchema: z.object({ session_id: sessionId, caller_session_id: callerSessionId }),
      outputSchema: WriteResult,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    guarded(async (args) => {
      const own = await ownOrRefuse(args.caller_session_id);
      if (isRefusal(own)) return own;
      const session = await api.getSession(args.session_id);
      if (!isExperiment(session))
        return refuse(
          `Session ${session.id} is not an Experiment Session, so it's read-only`,
          "the user can stop it in the UI",
        );
      if (session.id === own.sessionId)
        return refuse("cancelling my own Session would end this Turn", "the user can stop it in the UI");
      const deep = checkDepth(session);
      if (deep) return deep;
      const tip = await api.tipTurnId(session.id);
      const tipTurn = tip ? await api.getTurn(session.id, tip) : undefined;
      if (tipTurn?.state.status !== "running")
        return refuse(
          `nothing to cancel: the tip Turn ${tip ?? "(none)"} is ${tipTurn?.state.status ?? "missing"}`,
          "list_sessions to find a running Experiment Session",
        );
      await api.cancel(session.id);
      // Cancel returns before the Turn winds down (#21 4.3), so read it once more.
      const after = await api.getTurn(session.id, tipTurn.id);
      return ok({
        provenance: "observed" as const,
        citation: { session_id: session.id, turn_id: tipTurn.id },
        mode: "cancel" as const,
        status: after.state.status,
        note: after.state.status === "running" ? "cancel requested; wait_turn to see it end" : "cancelled",
      });
    }),
  );

  // ---------- helpers that need deps ----------

  // Patches an inline Experiment Session's spec before an in-place write.
  async function patchInPlace(session: Session, patch?: ConfigPatch): Promise<CallToolResult | undefined> {
    if (!patch) return undefined;
    if (session.agent.type !== "inline")
      return refuse(
        `Session ${session.id} runs the named Agent, which no tool edits`,
        "fork the user's chat into an inline Experiment Session and patch that",
      );
    const patched = applyConfigPatch(session.agent.spec, patch);
    if (!patched.ok) return refuse(`config_patch doesn't fit the spec: ${patched.reason}`, "fix the patch's values");
    await api.updateSession(session.id, { spec: patched.spec });
    return undefined;
  }

  // Runs the replayed Turns one after another: each must finish before the next
  // chains on it, or creating the next would cancel it (#21 6.2).
  async function replay(newSessionId: string, tags: Record<string, string>, inputs: TurnInputItem[][]) {
    let previous = "none";
    for (const [index, input] of inputs.entries()) {
      const created = await api.createTurn(newSessionId, { input, previousTurnId: previous });
      const turn = await waitUntilDone(newSessionId, created.id);
      const failed =
        turn.state.status !== "done"
          ? `turn ${index + 1} ended ${turn.state.status}`
          : requiredActions(turn) > 0
            ? `turn ${index + 1} wants an Approval`
            : undefined;
      if (failed) {
        await api.updateSession(newSessionId, { metadata: { ...tags, replay: `failed:${failed}`.slice(0, 128) } });
        return;
      }
      previous = turn.id;
    }
    await api.updateSession(newSessionId, { metadata: { ...tags, replay: "done" } });
  }

  async function waitUntilDone(id: string, turnId: string): Promise<Turn> {
    const deadline = clock.now() + REPLAY_TURN_TIMEOUT_MS;
    for (;;) {
      const turn = await api.getTurn(id, turnId);
      if (turn.state.status !== "running" || clock.now() >= deadline) return turn;
      await clock.sleep(POLL_MS);
    }
  }
}

// ---------- pure helpers ----------

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function costOf(t: Turn): number {
  return ("metrics" in t.state && t.state.metrics?.totalCostInUsd) || 0;
}

// The Turns from the root down to `turnId`, following `previousTurnId`.
export function branchTo(turns: Turn[], turnId: string): Turn[] {
  const byId = new Map(turns.map((t) => [t.id, t]));
  const path: Turn[] = [];
  for (let t = byId.get(turnId); t; t = t.previousTurnId ? byId.get(t.previousTurnId) : undefined) path.unshift(t);
  return path;
}

// Only a Turn's user messages are replayed; Approval answers belong to the
// original Turn's pending calls, which the replay doesn't have.
function userMessagesOf(t: Turn): TurnInputItem[] {
  return (t.input ?? []).filter((i) => i.type === "user.message");
}

// Every event of a Turn, at most 5 pages of 100.
async function allEvents(api: SessionsApi, sessionId: string, turnId: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await api.listTurnEvents(sessionId, turnId, { limit: 100, ...(cursor ? { cursor } : {}) });
    out.push(...res.items);
    cursor = res.next;
    if (!cursor) break;
  }
  return out;
}
