// Compact projections of TrueForge's Session, Turn and event payloads (#8, #21
// section 3.2): the model never sees a raw page, only these shapes, each with a
// `{session_id, turn_id, event_id}` citation.

import { z } from "zod";
import type { Session, SessionEvent, Turn } from "./api";

export const SessionCitation = z.object({
  session_id: z.string(),
  turn_id: z.string().optional(),
  event_id: z.string().optional(),
});
export type SessionCitation = z.infer<typeof SessionCitation>;

// Cuts text to `max` characters and says how long it was.
export function excerpt(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length} chars]`;
}

// Message content is a string or a list of parts; only text parts are kept.
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
      .join("");
  return "";
}

export const SessionSummary = z.object({
  citation: SessionCitation,
  title: z.string().nullable(),
  agent: z.string(),
  metadata: z.record(z.string(), z.string()),
  experiment: z.boolean(),
  turns: z.number().int(),
  cost_usd: z.number().nullable(),
  duration_ms: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function sessionSummary(s: Session): z.infer<typeof SessionSummary> {
  return {
    citation: { session_id: s.id },
    title: s.title,
    // A named Agent shows its name; an inline copy (every Experiment Session) shows "inline".
    agent: s.agent.type === "reference" ? (s.agent.name ?? s.agent.id) : "inline",
    metadata: s.metadata,
    experiment: s.metadata.experiment !== undefined,
    turns: s.metrics.totalTurns,
    cost_usd: s.metrics.totalCostInUsd ?? null,
    duration_ms: s.metrics.totalDurationMs,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

export const Metrics = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  reasoning_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  cost_usd: z.number().optional(),
});

// A Turn's `totalXxx` counters under the shorter names the model sees.
export function metricsOf(m: {
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalReasoningTokens?: number;
  totalCacheReadTokens?: number;
  totalCostInUsd?: number;
}): z.infer<typeof Metrics> {
  return {
    input_tokens: m.totalInputTokens,
    output_tokens: m.totalOutputTokens,
    reasoning_tokens: m.totalReasoningTokens,
    cache_read_tokens: m.totalCacheReadTokens,
    cost_usd: m.totalCostInUsd,
  };
}

export const TurnSummary = z.object({
  citation: SessionCitation,
  previous_turn_id: z.string().nullable(),
  status: z.string(),
  // Why it stopped: the cancel reason, or the error message.
  detail: z.string().optional(),
  // Pending Approvals or answers: a `done` Turn with these is waiting on the user (#24).
  required_actions: z.number().int(),
  created_at: z.string(),
  completed_at: z.string().optional(),
  input: z.string(),
  metrics: Metrics.optional(),
});
export type TurnSummary = z.infer<typeof TurnSummary>;

export function requiredActions(turn: Turn): number {
  return turn.state.status === "done" ? turn.state.requiredActions.length : 0;
}

export function turnSummary(t: Turn, inputChars: number): TurnSummary {
  const s = t.state;
  // `in` narrows a union by asking whether a property exists on this member.
  const metrics = "metrics" in s && s.metrics ? s.metrics : undefined;
  const detail = s.status === "cancelled" ? s.reason : s.status === "error" ? s.message : undefined;
  return {
    citation: { session_id: t.sessionId, turn_id: t.id },
    previous_turn_id: t.previousTurnId,
    status: s.status,
    ...(detail ? { detail } : {}),
    required_actions: requiredActions(t),
    created_at: t.createdAt,
    ...("completedAt" in s ? { completed_at: s.completedAt } : {}),
    input: excerpt(inputText(t), inputChars),
    ...(metrics ? { metrics: metricsOf(metrics) } : {}),
  };
}

// What started the Turn: its user messages, or the kind of input it was.
export function inputText(t: Turn): string {
  return (t.input ?? []).map((i) => (i.type === "user.message" ? textOf(i.content) : `[${i.type}]`)).join("\n");
}

export const EventView = z.object({
  citation: SessionCitation,
  type: z.string(),
  created_at: z.string(),
  thread_id: z.string().optional(),
  text: z.string().optional(),
  tool_calls: z.array(z.object({ id: z.string(), name: z.string(), args_chars: z.number().int() })).optional(),
  pending_tool_call_ids: z.array(z.string()).optional(),
  tool_call_id: z.string().optional(),
  content_chars: z.number().int().optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
  servers: z.array(z.string()).optional(),
});
export type EventView = z.infer<typeof EventView>;

export function eventView(sessionId: string, turnId: string, e: SessionEvent, textChars: number): EventView {
  const base = {
    citation: { session_id: sessionId, turn_id: turnId, event_id: e.id },
    type: e.type,
    created_at: e.createdAt,
    // Some event types carry a nullable thread id; null and absent both mean "none".
    ...("threadId" in e && e.threadId ? { thread_id: e.threadId } : {}),
  };
  // `switch` on `type` narrows the union, so each case sees that event's fields.
  switch (e.type) {
    case "model.message": {
      const text = textOf(e.content);
      return {
        ...base,
        ...(text ? { text: excerpt(text, textChars) } : {}),
        ...(e.toolCalls?.length
          ? {
              tool_calls: e.toolCalls.map((c) => ({
                id: c.id,
                name: c.function.name,
                args_chars: c.function.arguments.length,
              })),
            }
          : {}),
        ...(e.usage ? { usage: { input_tokens: e.usage.inputTokens, output_tokens: e.usage.outputTokens } } : {}),
      };
    }
    case "tool.response":
      return {
        ...base,
        tool_call_id: e.toolCallId,
        content_chars: e.content.length,
        text: excerpt(e.content, textChars),
      };
    case "mcp.initialize":
      return { ...base, servers: e.mcpServers.map((s) => s.name) };
    case "tool.approval_required":
      return { ...base, pending_tool_call_ids: e.toolCalls.map((c) => c.id) };
    default:
      return base;
  }
}
