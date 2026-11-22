// The tags on an Experiment Session (see CONTEXT.md) are the contract between
// the scripts that open Experiment Sessions and the MCP server that reads them.
// This module is the only place that turns them into metadata strings.
// `import { encodeExperimentTags } from "@forge-lab/lib/experiment-tags"`.

// TrueForge's Session metadata is a flat map of string to string.
export type Metadata = Record<string, string>;

// The Session and Turn an Experiment Session was forked from.
export type Origin = { sessionId: string; turnId: string };

// A discriminated union: `status` tells TypeScript which member it is, so only
// the `failed` member has a `reason`.
export type ReplayState = { status: "running" } | { status: "done" } | { status: "failed"; reason: string };

export type ExperimentTags = {
  experiment: string;
  // How many forks from a root: a script's own Experiment Session is 0. One digit.
  depth: number;
  origin?: Origin; // `?` makes the key optional: a root has no origin
  replay?: ReplayState;
};

// The tag holds the reason too, all of it cut to this many UTF-16 units.
const REPLAY_TAG_MAX = 128;

// Builds the metadata for an Experiment Session. Its input comes from code, not
// from the wire, so a value a reader would misread is a bug: it throws.
export function encodeExperimentTags(tags: ExperimentTags): Metadata {
  if (tags.experiment === "") throw new RangeError("experiment must be a non-empty name");
  // Writes stop at depth 2, so one digit is plenty; "10" would read back as malformed.
  if (!Number.isInteger(tags.depth) || tags.depth < 0 || tags.depth > 9)
    throw new RangeError(`depth must be an integer from 0 to 9, not ${tags.depth}`);
  // Spreading `{}` adds nothing, so an absent optional tag leaves no key behind.
  // The key order (experiment, depth, origin, replay) is the order on the wire.
  return {
    experiment: tags.experiment,
    depth: String(tags.depth),
    ...(tags.origin ? { origin: encodeOrigin(tags.origin) } : {}),
    ...(tags.replay ? { replay: encodeReplay(tags.replay) } : {}),
  };
}

// A copy of an Experiment Session's metadata with its `replay` tag set: how a
// replay reports that it finished or failed. The other tags are kept as they are.
export function withReplay(metadata: Metadata, state: ReplayState): Metadata {
  return { ...metadata, replay: encodeReplay(state) };
}

function encodeOrigin({ sessionId, turnId }: Origin): string {
  for (const part of [sessionId, turnId])
    if (part === "" || part.includes(":"))
      throw new RangeError(`origin ids must be non-empty and free of ":", not ${JSON.stringify(part)}`);
  return `${sessionId}:${turnId}`;
}

function encodeReplay(state: ReplayState): string {
  // `switch` on the discriminant narrows `state`, so `state.reason` type-checks
  // only in the `failed` case.
  switch (state.status) {
    case "running":
    case "done":
      return state.status;
    case "failed":
      return `failed:${state.reason}`.slice(0, REPLAY_TAG_MAX);
  }
}

// ---------- reading ----------

// One tag as read from a Session. A reader picks its own fallback for each case
// (an absent depth is 0; a malformed one refuses writes), so none is applied here.
export type TagField<T> =
  | { kind: "absent" }
  | { kind: "valid"; value: T }
  | { kind: "malformed"; raw: string; problem: string };

// `experiment` is any present string: a Session with the key at all is an
// Experiment Session, which is what the write checks rely on.
export type ExperimentTagReading = {
  experiment: string | undefined;
  depth: TagField<number>;
  origin: TagField<Origin>;
  replay: TagField<ReplayState>;
};

// Reads the tags off any Session's metadata, the user's chat included. It never
// throws: metadata comes from the wire, so a bad tag is data, not a bug.
// Keys it doesn't own (e.g. a script's `probe`) are ignored.
export function decodeExperimentTags(metadata: Metadata): ExperimentTagReading {
  return {
    experiment: metadata.experiment,
    depth: field(metadata.depth, decodeDepth),
    origin: field(metadata.origin, decodeOrigin),
    replay: field(metadata.replay, decodeReplay),
  };
}

// Each decoder returns the value, or a string saying what's wrong with the raw tag.
// `<T>` is a type parameter: one `field` serves every tag's value type.
type Decoder<T> = (raw: string) => { value: T } | { problem: string };

function field<T>(raw: string | undefined, decode: Decoder<T>): TagField<T> {
  if (raw === undefined) return { kind: "absent" };
  const result = decode(raw);
  return "value" in result
    ? { kind: "valid", value: result.value }
    : { kind: "malformed", raw, problem: result.problem };
}

const decodeDepth: Decoder<number> = (raw) =>
  /^\d$/.test(raw) ? { value: Number(raw) } : { problem: "depth must be one digit, 0 to 9" };

const decodeOrigin: Decoder<Origin> = (raw) => {
  // Array destructuring with a length check: exactly two parts means exactly one colon.
  const parts = raw.split(":");
  const [sessionId, turnId] = parts;
  if (parts.length !== 2 || !sessionId || !turnId) return { problem: "origin must be <session>:<turn>" };
  return { value: { sessionId, turnId } };
};

const decodeReplay: Decoder<ReplayState> = (raw) => {
  if (raw === "running" || raw === "done") return { value: { status: raw } };
  if (raw.startsWith("failed:")) return { value: { status: "failed", reason: raw.slice("failed:".length) } };
  return { problem: "replay must be running, done or failed:<reason>" };
};
