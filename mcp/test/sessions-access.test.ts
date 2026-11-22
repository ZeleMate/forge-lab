// The Session access policy at its interface (access.ts): what kind of Session
// this is, and which asks it refuses, as a kind × ask table. The MCP-level
// tests (sessions-refusals, sessions-tools, triage-tools) stay the end-to-end net.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  type Ask,
  type Caller,
  type Classified,
  classify,
  depthOf,
  refusalFor,
  replayTags,
} from "../src/sessions/access";
import { FakeSessionsApi } from "./sessions-fake";

const fake = new FakeSessionsApi();
const classes = new Map<string, Classified>();

// The Sessions the table refers to, by id.
beforeAll(async () => {
  fake.addSession("chat");
  fake.addSession("deep-chat", { metadata: { depth: "2" } });
  fake.addSession("exp", { metadata: { experiment: "x", depth: "1" }, inline: true });
  fake.addSession("deep", { metadata: { experiment: "x", depth: "2" }, inline: true });
  fake.addSession("odd-depth", { metadata: { experiment: "x", depth: "one" }, inline: true });
  fake.addSession("replay", { metadata: { experiment: "x", depth: "1", origin: "chat:c1" }, inline: true });
  fake.addSession("orphan", { metadata: { experiment: "x", depth: "1", origin: "gone:t1" }, inline: true });
  fake.addSession("blank-origin", { metadata: { experiment: "x", depth: "1", origin: "" }, inline: true });
  fake.addSession("fork", { metadata: { experiment: "x", depth: "1", origin: "exp:e1" }, inline: true });
  for (const id of ["chat", "deep-chat", "exp", "deep", "odd-depth", "replay", "orphan", "blank-origin", "fork"])
    classes.set(id, await classify(fake, await fake.getSession(id)));
});

const of = (id: string): Classified => {
  const c = classes.get(id);
  if (!c) throw new Error(`no Session ${id} in the table`);
  return c;
};

// The caller is another Session unless a row says otherwise.
const OTHER: Caller = { sessionId: "own", depth: 0, detected: true };
const UNVERIFIED: Caller = { sessionId: "own", depth: 0, detected: false };
const AS = (sessionId: string, more: Partial<Caller> = {}): Caller => ({
  sessionId,
  depth: 0,
  detected: true,
  ...more,
});

describe("classify", () => {
  test.each([
    ["chat", "chat", true],
    ["exp", "experiment", false],
    ["fork", "experiment", false], // a fork of an Experiment Session holds no chat
    ["replay", "replay", true],
    ["orphan", "replay", true], // an origin that names no readable Session counts as a chat
    ["blank-origin", "replay", true],
  ])("%s is a %s Session (holds chat content: %p)", (id, kind, holdsChat) => {
    expect(of(id)).toMatchObject({ id, kind, holdsChat });
  });

  test("keeps the depth and origin tags", () => {
    expect(of("replay")).toMatchObject({ depth: 1, origin: "chat:c1" });
    expect(of("chat")).toMatchObject({ depth: 0, origin: undefined });
  });

  test("a chat or an untagged Experiment Session is never looked up again", async () => {
    const before = fake.calls.length;
    await classify(fake, await fake.getSession("chat"));
    await classify(fake, await fake.getSession("exp"));
    // Only the two getSession calls the test itself made.
    expect(fake.calls.length - before).toBe(2);
  });
});

describe("depthOf", () => {
  test.each([
    [{}, 0],
    [{ depth: "0" }, 0],
    [{ depth: "1" }, 1],
    [{ depth: "12" }, Number.POSITIVE_INFINITY], // only a single digit is a depth
    [{ depth: "one" }, Number.POSITIVE_INFINITY],
    [{ depth: "" }, Number.POSITIVE_INFINITY],
  ])("%p is depth %p", (metadata, depth) => {
    expect(depthOf(metadata)).toBe(depth);
  });
});

// [Session, ask, expected refusal (undefined: allowed)]. Each ask names its
// caller; a write ask also says whether the target has a running Turn.
type Row = [string, Ask, RegExp | undefined];
const READ_ONLY = /refused: Session chat is not an Experiment Session, so it's read-only/;
const table: Row[] = [
  // Free reads: anything but chat content, plus the caller's own Session when the scan found it.
  [
    "chat",
    { action: "read", caller: OTHER },
    /^refused: Session chat is the user's chat, and its messages are read only with the user's Approval\. Try: get_chat_turn or list_chat_events, which ask the user first$/,
  ],
  ["chat", { action: "read", caller: undefined }, /is the user's chat/],
  ["chat", { action: "read", caller: AS("chat") }, undefined],
  ["chat", { action: "read", caller: AS("chat", { detected: false }) }, /is the user's chat/],
  [
    "replay",
    { action: "read", caller: OTHER },
    /^refused: Session replay replays the user's chat \(origin chat:c1\), and its messages are read only/,
  ],
  ["orphan", { action: "read", caller: OTHER }, /replays the user's chat \(origin gone:t1\)/],
  ["exp", { action: "read", caller: undefined }, undefined],
  ["fork", { action: "read", caller: OTHER }, undefined],
  ["deep", { action: "read", caller: OTHER }, undefined],

  // The triage judge: Experiment Sessions that hold no chat content, whoever asks.
  [
    "chat",
    { action: "judge" },
    /^refused: Session chat is the user's chat, and its events aren't sent to the triage judge\. Try: use list_events and read the events yourself$/,
  ],
  [
    "replay",
    { action: "judge" },
    /^refused: Session replay replays the user's chat \(origin chat:c1\), and its events/,
  ],
  ["orphan", { action: "judge" }, /replays the user's chat \(origin gone:t1\)/],
  ["exp", { action: "judge" }, undefined],
  ["fork", { action: "judge" }, undefined],

  // In-place writes, in check order: Experiment Session, not the caller's own,
  // under depth 2, and a running target only for a verified caller (and only to cancel).
  ["chat", { action: "re-run", caller: OTHER, running: false }, READ_ONLY],
  ["chat", { action: "fork in place", caller: OTHER, running: false }, /Try: fork_turn from it instead/],
  ["chat", { action: "cancel", caller: OTHER, running: true }, /read-only\. Try: the user can stop it in the UI$/],
  ["chat", { action: "re-run", caller: AS("chat"), running: false }, READ_ONLY], // the kind is checked first
  [
    "exp",
    { action: "re-run", caller: AS("exp"), running: true },
    /^refused: a re-run in my own Session would move its tip off this Turn\. Try: use another Experiment Session$/,
  ],
  [
    "exp",
    { action: "cancel", caller: AS("exp"), running: true },
    /^refused: cancelling my own Session would end this Turn\. Try: the user can stop it in the UI$/,
  ],
  [
    "deep",
    { action: "re-run", caller: OTHER, running: false },
    /^refused: Session deep is at depth 2; writes stop at depth 2/,
  ],
  ["deep", { action: "cancel", caller: OTHER, running: true }, /is at depth 2/],
  ["odd-depth", { action: "fork in place", caller: OTHER, running: false }, /Session odd-depth is at depth one;/],
  [
    "exp",
    { action: "fork in place", caller: UNVERIFIED, running: true },
    /^refused: I couldn't confirm which Session I'm in, and Session exp has a running Turn that could be mine\. Try: wait until it finishes/,
  ],
  [
    "exp",
    { action: "cancel", caller: UNVERIFIED, running: true },
    /could be mine\. Try: the user can stop it in the UI$/,
  ],
  [
    "exp",
    { action: "fork in place", caller: OTHER, running: true },
    /^refused: Session exp has a running Turn; a fork in place would run alongside it and leave it where cancel_session can't reach\. Try: wait_turn until it finishes, or cancel_session it first$/,
  ],
  ["exp", { action: "re-run", caller: OTHER, running: true }, /a re-run would run alongside it/],
  ["exp", { action: "cancel", caller: OTHER, running: true }, undefined],
  ["exp", { action: "re-run", caller: UNVERIFIED, running: false }, undefined],
  ["replay", { action: "re-run", caller: OTHER, running: false }, undefined], // a Replay is an Experiment Session

  // A replay from the user's chat: the chat under depth 2, and a caller whose
  // new Experiment Session would stay under depth 2 (an unverified caller counts as depth 1).
  ["chat", { action: "replay", caller: OTHER }, undefined],
  ["chat", { action: "replay", caller: AS("chat") }, undefined], // forking the chat Cartographer runs in
  [
    "deep-chat",
    { action: "replay", caller: OTHER },
    /^refused: Session deep-chat is at depth 2; writes stop at depth 2/,
  ],
  [
    "chat",
    { action: "replay", caller: AS("exp", { depth: 1 }) },
    /^refused: I'm running at depth 1, so a new Experiment Session would be depth 2; writes stop at depth 2\. Try: fork from inside the user's chat or a depth-0 Session$/,
  ],
  [
    "chat",
    { action: "replay", caller: UNVERIFIED },
    /^refused: I'm running at depth 1 \(assumed, since I couldn't confirm my Session\), so a new Experiment Session would be depth 2/,
  ],
];

describe("refusalFor", () => {
  // `test.each` runs one named test per row; `%s` prints the Session id.
  test.each(table)("%s, %o", (id, ask, expected) => {
    const refused = refusalFor(of(id), ask);
    if (expected === undefined) expect(refused).toBeUndefined();
    else {
      expect(refused?.isError).toBe(true);
      const text = refused?.content[0]?.type === "text" ? refused.content[0].text : "";
      expect(text).toMatch(expected);
    }
  });
});

describe("replayTags", () => {
  test("names the chat and Turn the replay came from, one level below its caller", () => {
    expect(replayTags("chat", "c2", OTHER, "compaction-trigger")).toEqual({
      experiment: "compaction-trigger",
      depth: "1",
      origin: "chat:c2",
    });
  });

  test("a replay's origin classifies it as a Replay of that chat", async () => {
    fake.addSession("made", { metadata: replayTags("chat", "c2", OTHER, "x"), inline: true });
    expect((await classify(fake, await fake.getSession("made"))).kind).toBe("replay");
  });
});
