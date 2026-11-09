// Flattens one Turn's persisted events into rows a learner can scan. Pure, so it's
// tested against payloads recorded from a live TrueForge (mcp/fixtures-results).

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

export type SessionEvent = TrueForgeApi.SessionEvent;
export type RowKind = "turn" | "model" | "tool" | "approval" | "subagent" | "context" | "other";

export type TraceRow = {
  id: string;
  createdAt: string;
  kind: RowKind;
  label: string;
  detail?: string;
  thread?: string; // set only for a Subagent's thread; the root thread is `main`
};

const MAIN_THREAD = "main";
const CALL_TOOL = "call_tool";
// A model call under half the previous call's input means the context was replaced.
const SHRINK_RATIO = 0.5;

const shortId = (id: string) => id.slice(-8);
const tokens = (n: number) => `${n.toLocaleString("en-US")} tokens`;

// A deferred tool runs through the `call_tool` meta-tool, so its real name is inside the
// arguments. The model wrote those, so they're checked before use, never assumed.
function deferredToolName(argumentsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed !== "object" || parsed === null || !("tool_name" in parsed)) return undefined;
    return typeof parsed.tool_name === "string" ? parsed.tool_name : undefined;
  } catch {
    return undefined;
  }
}

function toolLabel(call: TrueForgeApi.ToolCall): string {
  const { name, arguments: args } = call.function;
  const deferred = name === CALL_TOOL ? deferredToolName(args) : undefined;
  return deferred ? `${deferred} via ${CALL_TOOL}` : name;
}

// Tool call ids only say which call they answer; the name lives on the model.message.
function toolNames(events: readonly SessionEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "model.message") continue;
    for (const call of event.toolCalls ?? []) names.set(call.id, toolLabel(call));
  }
  return names;
}

function decisionText(approval: TrueForgeApi.ApprovalDecision): string {
  return approval.status === "allow" ? "allowed" : `denied${approval.reason ? `: ${approval.reason}` : ""}`;
}

function turnCreatedRows(event: TrueForgeApi.TurnCreatedEvent, names: Map<string, string>): TraceRow[] {
  const base = { id: event.id, createdAt: event.createdAt };
  const answers = (event.input ?? []).flatMap((item) => {
    if (item.type !== "user.tool_approval") return [];
    const name = names.get(item.toolCallId) ?? shortId(item.toolCallId);
    return [`${name}: ${decisionText(item.approval)}`];
  });
  // A Turn that carries an Approval answer is the resume half of an Approval pause.
  if (answers.length > 0)
    return [{ ...base, kind: "approval", label: "Approval answered", detail: answers.join("; ") }];
  const inputs = (event.input ?? []).map((item) => item.type).join(", ");
  return [{ ...base, kind: "turn", label: "Turn started", ...(inputs ? { detail: inputs } : {}) }];
}

function turnDoneDetail(event: TrueForgeApi.TurnDoneEvent): string | undefined {
  const total = event.state.metrics?.totalTokens;
  return total === undefined ? undefined : tokens(total);
}

function rowsFor(event: SessionEvent, names: Map<string, string>): TraceRow[] {
  const base = { id: event.id, createdAt: event.createdAt };
  // `threadId` is on most events but not all, so `in` checks before reading it.
  const threadId = "threadId" in event ? event.threadId : null;
  const thread = threadId && threadId !== MAIN_THREAD ? { thread: threadId } : {};
  const nameOf = (id: string) => names.get(id) ?? shortId(id);

  switch (event.type) {
    case "turn.created":
      return turnCreatedRows(event, names);
    case "turn.done": {
      const detail = turnDoneDetail(event);
      return [{ ...base, kind: "turn", label: `Turn ${event.state.status}`, ...(detail ? { detail } : {}) }];
    }
    case "model.message": {
      const calls = (event.toolCalls ?? []).map(toolLabel);
      const detail = event.usage ? `${tokens(event.usage.inputTokens)} in, ${event.usage.outputTokens} out` : undefined;
      return [
        {
          ...base,
          ...thread,
          kind: "model",
          label: calls.length > 0 ? `Model calls ${calls.join(", ")}` : "Model replies",
          ...(detail ? { detail } : {}),
        },
      ];
    }
    case "tool.response":
      return [{ ...base, ...thread, kind: "tool", label: `Tool response: ${nameOf(event.toolCallId)}` }];
    case "tool.approval_required": {
      const calls = event.toolCalls.map((call) => nameOf(call.id)).join(", ");
      return [
        { ...base, ...thread, kind: "approval", label: `Approval needed: ${calls}`, detail: "the Turn ends here" },
      ];
    }
    case "user.tool_approval":
      return [
        {
          ...base,
          ...thread,
          kind: "approval",
          label: `Approval: ${nameOf(event.toolCallId)}`,
          detail: decisionText(event.approval),
        },
      ];
    case "tool.response_required": {
      const calls = event.toolCalls.map((call) => nameOf(call.id)).join(", ");
      return [{ ...base, ...thread, kind: "approval", label: `Answer needed: ${calls}` }];
    }
    case "mcp.auth_required":
      return [{ ...base, ...thread, kind: "approval", label: "MCP sign-in needed" }];
    case "thread.created":
      return [{ ...base, kind: "subagent", label: `Subagent started: ${event.title}`, thread: event.threadId }];
    case "thread.done":
      return [
        {
          ...base,
          kind: "subagent",
          label: `Subagent ${event.state.status}: ${event.title}`,
          thread: event.threadId,
        },
      ];
    default:
      return [{ ...base, ...thread, kind: "other", label: event.type }];
  }
}

// Compaction leaves no persisted event (`agent.context.overwrite` only rewrites the
// thread's context in the store), so the only trace is a model call's input falling.
// `previous` carries the last input size per thread between events.
function contextRow(event: SessionEvent, previous: Map<string, number>): TraceRow | undefined {
  if (event.type !== "model.message" || !event.usage) return undefined;
  const before = previous.get(event.threadId);
  const after = event.usage.inputTokens;
  previous.set(event.threadId, after);
  if (before === undefined || after >= before * SHRINK_RATIO) return undefined;
  return {
    id: `${event.id}:context`,
    createdAt: event.createdAt,
    kind: "context",
    label: "Context shrank (inferred)",
    detail: `${tokens(before)} to ${tokens(after)}, probably compaction`,
    ...(event.threadId === MAIN_THREAD ? {} : { thread: event.threadId }),
  };
}

// `previousTurn` only supplies names: an Approval's answer and the tool's response land
// in the new Turn, while the call that names them is in the Turn before it.
export function traceRows(events: readonly SessionEvent[], previousTurn: readonly SessionEvent[] = []): TraceRow[] {
  const names = toolNames([...previousTurn, ...events]);
  const inputSizes = new Map<string, number>();
  return events.flatMap((event) => {
    const context = contextRow(event, inputSizes);
    return [...(context ? [context] : []), ...rowsFor(event, names)];
  });
}
