// The sessions server's read tools (#8): they inspect TrueForge's own
// Sessions, Turns and events and change nothing, and are labelled `observed`.
//
// The user's chats hold their own messages, which a prompt injection could have
// Cartographer copy out of the sandbox. So get_turn, list_events and wait_turn
// read Experiment Sessions and Cartographer's own Session (already in its
// context) freely, and refuse any other chat. Two twins, get_chat_turn and
// list_chat_events, read chats; Cartographer's spec gates them by name, so each
// call waits for the user's Approval, and TrueForge refuses them from sandbox code.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fitList, guarded, listCut, maxChars, ok, refuse } from "../result";
import type { Session, SessionEvent, SessionsApi } from "./api";
import type { FindOwn } from "./own";
import {
  EventView,
  eventView,
  excerpt,
  Metrics,
  metricsOf,
  SessionCitation,
  SessionSummary,
  sessionSummary,
  TurnSummary,
  textOf,
  turnSummary,
} from "./project";
import {
  CHAT_READ_TOOLS,
  isExperiment,
  isUnfinished,
  POLL_MS,
  READ_ANNOTATIONS,
  type SessionsDeps,
  sessionId,
  sum,
} from "./shared";

export function registerReadTools(server: McpServer, deps: SessionsDeps, findOwn: FindOwn): void {
  const { api, clock } = deps;

  // A refusal when `session` is one of the user's chats other than the caller's own.
  async function chatRefusal(session: Session): Promise<CallToolResult | undefined> {
    if (isExperiment(session)) return undefined;
    // No `caller_session_id` here: only a Session the scan found counts as the caller's.
    const own = await findOwn();
    if (own?.detected && own.sessionId === session.id) return undefined;
    return refuse(
      `Session ${session.id} is the user's chat, and its messages are read only with the user's Approval`,
      `${CHAT_READ_TOOLS.join(" or ")}, which ask the user first`,
    );
  }

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

  const GetTurn = {
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
  };
  const TURN_DETAIL =
    "One Turn in detail (input, status, output, pending Approvals, metrics), plus the Session's Turns newest first so you can find other ids. Without turn_id, shows the newest Turn.";

  // `z.infer` on the schema gives the arguments' type, so both tools share one handler.
  async function getTurn(args: z.infer<typeof GetTurn.inputSchema>, gate: boolean): Promise<CallToolResult> {
    const [session, turns] = await Promise.all([api.getSession(args.session_id), api.listTurns(args.session_id)]);
    const refused = gate ? await chatRefusal(session) : undefined;
    if (refused) return refused;
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
  }

  server.registerTool(
    "get_turn",
    {
      ...GetTurn,
      title: "Get a Turn",
      description: `${TURN_DETAIL} Experiment Sessions and your own Session only; for the user's other chats use get_chat_turn.`,
    },
    guarded((args) => getTurn(args, true)),
  );
  server.registerTool(
    "get_chat_turn",
    {
      ...GetTurn,
      title: "Get a Turn of the user's chat",
      description: `${TURN_DETAIL} For one of the user's chats; each call waits for the user's Approval. Read only the chat the user pointed you to.`,
    },
    guarded((args) => getTurn(args, false)),
  );

  const ListEvents = {
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
  };
  const EVENTS_DETAIL =
    "One Turn's persisted events, oldest first, projected: model messages (text excerpt, tool calls, usage), tool responses (size, excerpt), MCP connections, Approval requests. A running Turn shows everything up to now, without streamed text.";

  async function listEvents(args: z.infer<typeof ListEvents.inputSchema>, gate: boolean): Promise<CallToolResult> {
    const refused = gate ? await chatRefusal(await api.getSession(args.session_id)) : undefined;
    if (refused) return refused;
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
  }

  server.registerTool(
    "list_events",
    {
      ...ListEvents,
      title: "List a Turn's events",
      description: `${EVENTS_DETAIL} Experiment Sessions and your own Session only; for the user's other chats use list_chat_events.`,
    },
    guarded((args) => listEvents(args, true)),
  );
  server.registerTool(
    "list_chat_events",
    {
      ...ListEvents,
      title: "List a Turn's events in the user's chat",
      description: `${EVENTS_DETAIL} For one of the user's chats; each call waits for the user's Approval. Read only the chat the user pointed you to.`,
    },
    guarded((args) => listEvents(args, false)),
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
        "Token, cost and timing figures for a Session's newest Turns, with model calls, tool calls and Subagent threads per Turn, and the latest context breakdown (harness, instructions, tools, messages). A Turn without recorded metrics (running, or cancelled for the next Turn) has tokens summed from its events and no cost: TrueForge prices a Turn only when it ends.",
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
      const newest = turns.slice(-args.last_turns).reverse();
      // The reads run in parallel; `Promise.all` keeps the results in the
      // input's order, so the loop below still walks newest first.
      const eventsOf = await Promise.all(newest.map((t) => allEvents(api, args.session_id, t.id)));
      for (const [i, turn] of newest.entries()) {
        const events = eventsOf[i] ?? [];
        const messages = events.filter((e) => e.type === "model.message");
        // `flatMap` maps and flattens one level, so per-message lists become one list.
        const usage = messages.flatMap((m) => (m.usage ? [m.usage] : []));
        const last = usage.at(-1);
        if (!breakdown && last) breakdown = { ...last.inputTokensBreakdown };
        const state = turn.state;
        const recorded = metricsOf(turn);
        rows.push({
          citation: { session_id: args.session_id, turn_id: turn.id },
          status: state.status,
          ...("completedAt" in state
            ? { duration_ms: Date.parse(state.completedAt) - Date.parse(turn.createdAt) }
            : {}),
          metrics: recorded
            ? recorded
            : {
                input_tokens: sum(usage.map((u) => u.inputTokens)),
                output_tokens: sum(usage.map((u) => u.outputTokens)),
                cache_read_tokens: sum(usage.map((u) => u.cacheReadTokens ?? 0)),
              },
          metrics_from: recorded ? "turn" : "events",
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
        "Polls a Turn every 2 s until it stops running, for at most timeout_s (under 90). Returns its summary, or still_running: call it again to keep waiting. Experiment Sessions and your own Session only.",
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
      const refused = await chatRefusal(await api.getSession(args.session_id));
      if (refused) return refused;
      const started = clock.now();
      const deadline = started + args.timeout_s * 1000;
      let turn = await api.getTurn(args.session_id, args.turn_id);
      while (isUnfinished(turn) && clock.now() < deadline) {
        await clock.sleep(Math.min(POLL_MS, deadline - clock.now()));
        turn = await api.getTurn(args.session_id, args.turn_id);
      }
      return ok({
        provenance: "observed" as const,
        still_running: isUnfinished(turn),
        waited_ms: clock.now() - started,
        turn: turnSummary(turn, 500),
      });
    }),
  );
}

const EVENT_PAGES = 5;
const EVENTS_PAGE_SIZE = 100;

// Every event of a Turn, at most EVENT_PAGES pages of EVENTS_PAGE_SIZE.
async function allEvents(api: SessionsApi, sessionId: string, turnId: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < EVENT_PAGES; page++) {
    const res = await api.listTurnEvents(sessionId, turnId, {
      limit: EVENTS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...res.items);
    cursor = res.next;
    if (!cursor) break;
  }
  return out;
}
