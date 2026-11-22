// The Session access policy (#8, #9, #24, #57): what kind of Session this is,
// and whether a caller may read it freely, send it to the triage judge, write to
// it in place, or replay it. Every tool asks here instead of composing its own
// predicates, so the kinds, the tag parsing, the check order and the refusal
// texts live in one place.
//
// Two steps: `classify` reads what the Session is (one lookup for an Experiment
// Session with an `origin`), then `refusalFor` answers one ask, without I/O.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { refuse } from "../result";
import type { Metadata, Session, SessionsApi } from "./api";
import { CHAT_READ_TOOLS } from "./shared";

// - chat: one of the user's Chat Sessions (untagged);
// - replay: an Experiment Session forked from a chat, so it holds the chat's messages;
// - experiment: any other Experiment Session.
export type SessionKind = "chat" | "replay" | "experiment";

export type Classified = {
  id: string;
  kind: SessionKind;
  depth: number;
  // The raw tags, for refusal texts: a malformed depth shows as it was written.
  depthTag: string | undefined;
  origin: string | undefined;
  holdsChat: boolean;
};

// What the policy needs to know about the caller's own Session. own.ts's
// OwnSession has these fields and more; TypeScript compares object types by
// their fields (structural typing), so an OwnSession can be passed as a Caller.
// `detected`: found by the scan, not only named by `caller_session_id`.
export type Caller = { sessionId: string; depth: number; detected: boolean };

export type InPlaceWrite = "fork in place" | "re-run" | "cancel";

// One question about one Session. A discriminated union: the `action` field
// decides which other fields exist, and a `switch` on it narrows to them. Write
// asks need a caller, so the type rules out asking one without it.
export type Ask =
  | { action: "read"; caller: Caller | undefined }
  | { action: "judge" }
  | { action: InPlaceWrite; caller: Caller; running: boolean }
  | { action: "replay"; caller: Caller };

// Writes stop here: no Experiment Session at this depth or deeper is written to or made.
const MAX_DEPTH = 2;

export const isExperiment = (s: Session) => s.metadata.experiment !== undefined;

export function depthOf(metadata: Metadata): number {
  // An untagged Session (the user's chat) is depth 0, like a script's root Experiment.
  const raw = metadata.depth;
  if (raw === undefined) return 0;
  // A tag that isn't a small integer counts as too deep, so writes refuse it.
  return /^\d$/.test(raw) ? Number(raw) : Number.POSITIVE_INFINITY;
}

// `origin` is `<session>:<turn>`, the chat and Turn a fork started from.
const formatOrigin = (sessionId: string, turnId: string) => `${sessionId}:${turnId}`;
const originSession = (origin: string) => origin.split(":")[0] ?? "";

export async function classify(api: SessionsApi, session: Session): Promise<Classified> {
  const base = { id: session.id, depth: depthOf(session.metadata), depthTag: session.metadata.depth };
  const origin = session.metadata.origin;
  if (!isExperiment(session)) return { ...base, kind: "chat", origin, holdsChat: true };
  if (origin === undefined) return { ...base, kind: "experiment", origin, holdsChat: false };
  // A replay of a chat, unless the origin names a readable Experiment Session.
  // An origin that can't be read counts as a chat.
  const sourceId = originSession(origin);
  // `.catch` turns a failed lookup into `undefined` instead of an exception.
  const source = sourceId ? await api.getSession(sourceId).catch(() => undefined) : undefined;
  const replay = source === undefined || !isExperiment(source);
  return { ...base, kind: replay ? "replay" : "experiment", origin, holdsChat: replay };
}

// The tags of a new Experiment Session replayed from `chatId` at `turnId`: one
// level below its caller, with an origin `classify` reads back as a Replay.
export function replayTags(chatId: string, turnId: string, caller: Caller, experiment: string): Metadata {
  return { experiment, depth: String(callerDepth(caller) + 1), origin: formatOrigin(chatId, turnId) };
}

// A caller named only by `caller_session_id` might be deeper than the Session
// it names, so it counts as depth 1, and its replays stop at MAX_DEPTH.
const callerDepth = (caller: Caller) => (caller.detected ? caller.depth : Math.max(caller.depth, 1));

// A refusal, or undefined when the ask is allowed.
export function refusalFor(s: Classified, ask: Ask): CallToolResult | undefined {
  switch (ask.action) {
    case "read":
      return readRefusal(s, ask.caller);
    case "judge":
      return judgeRefusal(s);
    case "replay":
      return replayRefusal(s, ask.caller);
    default:
      // After the cases above, TypeScript has narrowed `ask` to the in-place writes.
      return inPlaceRefusal(s, ask.action, ask.caller, ask.running);
  }
}

// What a chat-holding Session is, said the same way by every refusal about its content.
const chatSubject = (s: Classified) =>
  s.kind === "replay"
    ? `Session ${s.id} replays the user's chat (origin ${s.origin})`
    : `Session ${s.id} is the user's chat`;

// Free reads: a Session without chat content, or the caller's own Session (it's
// already in Cartographer's context), but only when the scan found it. A Replay
// counts as the chat, since fork_turn's Approval reads as a write, not as
// opening the chat.
function readRefusal(s: Classified, caller: Caller | undefined): CallToolResult | undefined {
  if (!s.holdsChat) return undefined;
  if (caller?.detected === true && caller.sessionId === s.id) return undefined;
  return refuse(
    `${chatSubject(s)}, and its messages are read only with the user's Approval`,
    `${CHAT_READ_TOOLS.join(" or ")}, which ask the user first`,
  );
}

// Event text goes to an outside API, so only Experiment Sessions without chat
// content qualify, whoever asks.
function judgeRefusal(s: Classified): CallToolResult | undefined {
  if (!s.holdsChat) return undefined;
  return refuse(
    `${chatSubject(s)}, and its events aren't sent to the triage judge`,
    "use list_events and read the events yourself",
  );
}

function depthRefusal(s: Classified): CallToolResult | undefined {
  if (s.depth < MAX_DEPTH) return undefined;
  return refuse(
    `Session ${s.id} is at depth ${s.depthTag}; writes stop at depth ${MAX_DEPTH}`,
    "work in a shallower Experiment Session",
  );
}

// A replay never touches the chat: it opens a new Experiment Session one level
// below the caller. So both the chat and that new Session must stay shallow.
function replayRefusal(s: Classified, caller: Caller): CallToolResult | undefined {
  const deep = depthRefusal(s);
  if (deep) return deep;
  const from = callerDepth(caller);
  const depth = from + 1;
  if (depth < MAX_DEPTH) return undefined;
  return refuse(
    `I'm running at depth ${from}${caller.detected ? "" : " (assumed, since I couldn't confirm my Session)"}, so a new Experiment Session would be depth ${depth}; writes stop at depth ${MAX_DEPTH}`,
    "fork from inside the user's chat or a depth-0 Session",
  );
}

// The target of an in-place write, in this order: only an Experiment Session,
// never the caller's own, never depth 2 or more, and never one with a running
// Turn. Keeping the order in one place is the point: it's what makes the
// writes safe.
function inPlaceRefusal(
  s: Classified,
  action: InPlaceWrite,
  caller: Caller,
  running: boolean,
): CallToolResult | undefined {
  const cancel = action === "cancel";
  // A Replay is an Experiment Session, so it may be written to in place.
  if (s.kind === "chat")
    return refuse(
      `Session ${s.id} is not an Experiment Session, so it's read-only`,
      cancel
        ? "the user can stop it in the UI"
        : "fork_turn from it instead, which replays into a new Experiment Session",
    );
  if (s.id === caller.sessionId)
    return refuse(
      cancel
        ? "cancelling my own Session would end this Turn"
        : `a ${action} in my own Session would move its tip off this Turn`,
      cancel ? "the user can stop it in the UI" : "use another Experiment Session",
    );
  const deep = depthRefusal(s);
  if (deep) return deep;
  if (!running) return undefined;
  // A caller named only by `caller_session_id` might really be any running
  // Session, so it may not touch one, not even to cancel it.
  if (!caller.detected)
    return refuse(
      `I couldn't confirm which Session I'm in, and Session ${s.id} has a running Turn that could be mine`,
      cancel ? "the user can stop it in the UI" : "wait until it finishes, or ask the user to do this in the UI",
    );
  // A fork or re-run chains on a finished Turn, so the running one isn't
  // cancelled (#21 6.2), but the new Turn becomes the tip, and the running one
  // is left where cancel_session can't reach it.
  if (!cancel)
    return refuse(
      `Session ${s.id} has a running Turn; a ${action} would run alongside it and leave it where cancel_session can't reach`,
      "wait_turn until it finishes, or cancel_session it first",
    );
  return undefined;
}
