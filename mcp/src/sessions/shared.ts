// What the sessions tools share: their dependencies, the annotations TrueForge's
// Approval selectors read, common input fields, and small predicates.

import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Clock } from "../clock";
import type { Session, SessionsApi, Turn } from "./api";

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

// How often anything that waits on a Turn reads it again.
export const POLL_MS = 2_000;

export const sessionId = z.string().min(1).describe("A Session id, as list_sessions returns it.");

export const isExperiment = (s: Session) => s.metadata.experiment !== undefined;

// Still going: running, or `paused` (which #24 never saw on the wire, since an
// Approval wait shows as `done` with required actions, but the type allows it).
export const isUnfinished = (t: Turn) => t.state.status === "running" || t.state.status === "paused";

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
