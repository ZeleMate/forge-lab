// The sessions server's three write tools (#8, amended by #9 and #24): fork,
// re-run and cancel. Each is Approval-gated through its annotations, acts only
// on Experiment Sessions, and runs the checks in checks.ts first.

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { guarded, ok, refuse } from "../result";
import type { Session, Turn, TurnInputItem } from "./api";
import { checkDepth, checkInPlaceTarget, checkSourceTurn, checkTurnId, isRefusal, ownOrRefuse } from "./checks";
import type { FindOwn } from "./own";
import { SessionCitation } from "./project";
import { branchTo, costOf, replayRunner, userMessagesOf } from "./replay";
import {
  DESTRUCTIVE_ANNOTATIONS,
  isExperiment,
  isUnfinished,
  type SessionsDeps,
  sessionId,
  sum,
  WRITE_ANNOTATIONS,
} from "./shared";
import { applyConfigPatch, ConfigPatch } from "./spec";

export const MAX_REPLAY = 5;
// A replay's cost estimate may be rough, but not hide most of the real cost.
const MIN_ESTIMATE_SHARE = 0.5;

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

export function registerWriteTools(server: McpServer, deps: SessionsDeps, findOwn: FindOwn): void {
  const { api, clock } = deps;
  const replay = replayRunner(api, clock);
  const spawn =
    deps.spawn ??
    ((task: Promise<void>) => {
      // A background replay has nobody to report to, so a failure is logged.
      task.catch((error) => console.error("replay failed:", error));
    });

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
      const own = await ownOrRefuse(findOwn, args.caller_session_id);
      if (isRefusal(own)) return own;
      const bad = checkTurnId(args.from_turn_id);
      if (bad) return bad;
      const [session, turns] = await Promise.all([api.getSession(args.session_id), api.listTurns(args.session_id)]);
      const source = turns.find((t) => t.id === args.from_turn_id);
      if (!source) return refuse(`no Turn ${args.from_turn_id} in Session ${args.session_id}`, "get_turn for the ids");
      const unfinished = checkSourceTurn(source);
      if (unfinished) return unfinished;
      const message: TurnInputItem = { type: "user.message", content: args.message };

      if (isExperiment(session)) {
        const target = checkInPlaceTarget(session, own, "fork in place", turns.some(isUnfinished));
        if (target) return target;
        return startInPlace(
          session,
          { input: [message], previousTurnId: source.id },
          args.config_patch,
          "wait_turn to follow it",
        );
      }

      // The user's chat: replay into a new inline Experiment Session.
      const deep = checkDepth(session);
      if (deep) return deep;
      // An unverified caller might be deeper than the Session it names, so it
      // counts as depth 1, and its replays stop here.
      const callerDepth = own.verified ? own.depth : Math.max(own.depth, 1);
      const depth = callerDepth + 1;
      if (depth >= 2)
        return refuse(
          `I'm running at depth ${callerDepth}${own.verified ? "" : " (assumed, since I couldn't confirm my Session)"}, so a new Experiment Session would be depth ${depth}; writes stop at depth 2`,
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
        note: `replaying ${replayed.length} user Turns, then your message, one at a time. Its tag \`replay\` becomes done or failed:<reason>; it stays running if the MCP server stops mid-replay. get_turn on ${created.id} to follow it.`,
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
      const own = await ownOrRefuse(findOwn, args.caller_session_id);
      if (isRefusal(own)) return own;
      const bad = checkTurnId(args.turn_id);
      if (bad) return bad;
      const [session, turns] = await Promise.all([api.getSession(args.session_id), api.listTurns(args.session_id)]);
      const source = turns.find((t) => t.id === args.turn_id);
      if (!source) return refuse(`no Turn ${args.turn_id} in Session ${args.session_id}`, "get_turn for the ids");
      const unfinished = checkSourceTurn(source);
      if (unfinished) return unfinished;
      const target = checkInPlaceTarget(session, own, "re-run", turns.some(isUnfinished));
      if (target) return target;
      const input = source.input ?? [];
      if (!input.length || input.some((i) => i.type !== "user.message"))
        return refuse(
          `Turn ${source.id} wasn't started by a user message (it answered an Approval)`,
          "re-run the Turn before it",
        );
      return startInPlace(
        session,
        { input, previousTurnId: source.previousTurnId ?? "none" },
        args.config_patch,
        `re-runs ${source.id}'s input from ${source.previousTurnId ?? "the root"}; wait_turn to follow it`,
      );
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
      const own = await ownOrRefuse(findOwn, args.caller_session_id);
      if (isRefusal(own)) return own;
      const session = await api.getSession(args.session_id);
      // A cancel only ever acts on a running Session.
      const target = checkInPlaceTarget(session, own, "cancel", true);
      if (target) return target;
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

  // The end of every in-place write: patch the spec if asked, create the Turn,
  // and say where it is.
  async function startInPlace(
    session: Session,
    body: { input: TurnInputItem[]; previousTurnId: string },
    patch: ConfigPatch | undefined,
    note: string,
  ): Promise<CallToolResult> {
    const patched = await patchInPlace(session, patch);
    if (isRefusal(patched)) return patched;
    const turn = await createAfterPatch(session.id, body, patch);
    return ok({
      provenance: "observed" as const,
      citation: { session_id: session.id, turn_id: turn.id },
      mode: "in-place" as const,
      context: "kept" as const,
      status: turn.state.status,
      note,
    });
  }

  // Creates the Turn after a patch. The patch can't be undone atomically, so if
  // the create fails the error says the spec already changed.
  async function createAfterPatch(
    id: string,
    body: { input: TurnInputItem[]; previousTurnId: string },
    patch?: ConfigPatch,
  ): Promise<Turn> {
    try {
      return await api.createTurn(id, body);
    } catch (error) {
      if (!patch) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} (Session ${id}'s spec was already patched with config_patch; no Turn was created)`);
    }
  }
}
