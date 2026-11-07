// The triage server's two tools (#8, #17, #57). They ask a cheap judge (decide.ts)
// to rank Source Snapshot files for a question, or to check Session events
// against yes/no predicates. Both cost money, so every call is checked against
// the $0.50/day budget first, and each result shows its cost. When there's no
// backend, the budget is spent or a call fails, the result is `unscored` with a
// reason, never a guess.

import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fitList, guarded, listCut, maxChars, ok, refuse, SourceCitation } from "../result";
import type { SessionEvent, SessionsApi } from "../sessions/api";
import { excerpt, SessionCitation, textOf } from "../sessions/project";
import { isExperiment } from "../sessions/shared";
import type { Snapshot } from "../source/snapshot";
import type { Budget } from "./budget";
import { type Candidate, candidateFor } from "./candidates";
import type { Decide, Judged, Level, Question } from "./decide";

export type TriageDeps = { decide: Decide | undefined; budget: Budget; source: Snapshot; sessions: SessionsApi };

// Read-only, so no Approval gate (#8), but not idempotent (a judge's answers
// vary) and open-world (it calls an outside API).
export const TRIAGE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const MAX_CANDIDATES = 50;
export const MAX_EVENTS = 50;
// check_events runs one call per event; this many run at once.
export const CONCURRENCY = 4;
const EVENT_CHARS = 2_000;

// The four levels #17 measured with; they are the real prompt for `score`.
export const LEVELS: readonly Level[] = [
  { label: "irrelevant", description: "Nothing in this file bears on the question." },
  {
    label: "mentions",
    description: "Touches the topic (imports it, passes it through, names it) but doesn't implement it.",
  },
  { label: "partial", description: "Implements part of the answer, or a closely related step." },
  {
    label: "answers",
    description: "A primary place to read: it implements or defines the mechanism the question asks about.",
  },
];

type Ranked = { citation: SourceCitation; score: number; level: string };

// The `score` request for a pool of candidates. Candidates get short ids, so
// each question names exactly one. triage-record.ts builds its request with this too.
export function buildScoreRequest(candidates: Candidate[], question: string) {
  const id = (i: number) => `C${String(i + 1).padStart(2, "0")}`;
  const listing = candidates.map((c, i) => `### ${id(i)}\n${c.text}`).join("\n\n");
  const input = `Question about the TrueForge agent harness: ${question}\n\nCandidate files:\n\n${listing}`;
  const questions: Question[] = candidates.map((c, i) => ({
    name: id(i),
    instructions: `How much does candidate ${id(i)} (${c.path}) help answer the question? Judge ${id(i)} only.`,
  }));
  return { input, questions, id };
}

const Status = z.enum(["judged", "unscored"]);
const BudgetView = z.object({
  day: z.string(),
  spent_today_usd: z.number(),
  cap_usd: z.number(),
  left_usd: z.number(),
});

export function registerTriageTools(server: McpServer, deps: TriageDeps): void {
  const { decide, budget } = deps;
  const sha7 = deps.source.sha.slice(0, 7);

  const budgetView = () => {
    const s = budget.status();
    return { day: s.day, spent_today_usd: s.spentUsd, cap_usd: s.capUsd, left_usd: s.leftUsd };
  };

  // Why a call can't run now, or undefined when it can.
  function blocked(estimateUsd: number): string | undefined {
    if (!decide) return "no triage backend: neither OPENAI_API_KEY nor OPENROUTER_API_KEY is set in mcp/.env";
    if (!budget.allows(estimateUsd)) {
      const s = budget.status();
      return `the daily triage budget is spent ($${s.spentUsd.toFixed(4)} of $${s.capUsd.toFixed(2)} on ${s.day} UTC)`;
    }
    return undefined;
  }

  // One judged call, its cost added to the budget, or the reason it failed.
  async function judge(
    inputChars: number,
    questionCount: number,
    run: (d: Decide) => Promise<Judged>,
  ): Promise<Judged | string> {
    if (!decide) return blocked(0) ?? "no triage backend";
    const why = blocked(decide.estimateUsd(inputChars, questionCount));
    if (why) return why;
    let judged: Judged;
    try {
      judged = await run(decide);
    } catch (error) {
      return `the ${decide.backend} call failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    // Outside the try: a failed counter write must not discard a paid answer.
    try {
      budget.spend(judged.costUsd);
    } catch (error) {
      console.error(
        `triage: couldn't record $${judged.costUsd} of spend: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return judged;
  }

  // The fields of a result where nothing was judged, plus whatever `extra` adds.
  function unscoredResult<P extends "source" | "observed", E extends object>(provenance: P, reason: string, extra?: E) {
    return {
      provenance,
      status: "unscored" as const,
      reason,
      cost_usd: 0,
      budget: budgetView(),
      ...(extra as E),
    };
  }

  server.registerTool(
    "rank_relevance",
    {
      title: "Rank files by relevance (costs money)",
      description: `Asks a cheap judge how much each candidate file helps answer a question, in one call, and ranks them best first. Pass up to ${MAX_CANDIDATES} snapshot paths, e.g. from search_text. A rank is an estimate to decide what to read, not evidence: cite the files you then read. Returns \`unscored\` with a reason when the daily budget is spent or no backend is set.`,
      inputSchema: z.object({
        question: z.string().min(10).describe("The question the files should answer."),
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_CANDIDATES)
          .describe("Snapshot paths, as search_text and read_file return them."),
        max_chars: maxChars,
      }),
      outputSchema: z.object({
        provenance: z.literal("source"),
        status: Status,
        reason: z.string().optional(),
        judged_by: z.string().optional(),
        ranked: z.array(
          z.object({
            citation: SourceCitation,
            score: z.number(),
            level: z.string(),
          }),
        ),
        unscored: z.array(z.object({ path: z.string(), reason: z.string() })),
        cost_usd: z.number(),
        budget: BudgetView,
        ...listCut,
      }),
      annotations: TRIAGE_ANNOTATIONS,
    },
    guarded(async (args) => {
      const unscored: { path: string; reason: string }[] = [];
      const candidates: Candidate[] = [];
      for (const path of new Set(args.paths)) {
        const c = candidateFor(deps.source, path);
        if (c.ok) candidates.push(c.candidate);
        else unscored.push({ path: c.path, reason: c.reason });
      }
      if (!candidates.length)
        return refuse("none of the paths is a file in the snapshot", "pass paths that search_text returned");

      const { input, questions, id } = buildScoreRequest(candidates, args.question);
      const result = await judge(input.length, questions.length, (d) => d.score(input, questions, LEVELS));

      if (typeof result === "string")
        return ok(
          fitList(
            unscoredResult("source", result, {
              unscored: [...unscored, ...candidates.map((c) => ({ path: c.path, reason: "not judged" }))],
            }),
            "ranked",
            [] as Ranked[],
            args.max_chars,
          ),
        );

      const ranked: Ranked[] = [];
      candidates.forEach((c, i) => {
        const score = result.answers[id(i)];
        if (score === null || score === undefined) unscored.push({ path: c.path, reason: "the judge didn't answer" });
        else
          ranked.push({
            citation: { path: c.path, line: 1, sha: sha7 },
            score: Math.round(score * 100) / 100,
            // The nearest level, for reading the score at a glance.
            level: LEVELS[Math.min(LEVELS.length - 1, Math.max(0, Math.round(score)))]?.label ?? "?",
          });
      });
      // Best first. `confidence` is never used: #17 found it higher for unrelated files.
      ranked.sort((a, b) => b.score - a.score);
      return ok(
        fitList(
          {
            provenance: "source" as const,
            budget: budgetView(),
            status: "judged" as const,
            judged_by: decide?.backend,
            unscored,
            cost_usd: result.costUsd,
          },
          "ranked",
          ranked,
          args.max_chars,
        ),
      );
    }),
  );

  const PredicateInput = z.object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, "snake_case, e.g. calls_exec")
      .describe("A short snake_case name for the answer."),
    instructions: z
      .string()
      .min(10)
      .describe('A concrete action the event shows, e.g. "This event calls the tool exec."'),
  });

  server.registerTool(
    "check_events",
    {
      title: "Check events against predicates (costs money)",
      description: `Asks a cheap judge, once per event, how likely each yes/no predicate is true of one Turn's events in an Experiment Session (never the user's chat). Phrase each predicate as a concrete action the event shows ("This event calls the tool exec", "The tool response reports an error"), never as a topic: the judge reads messages about approvals as approvals. Each event's type is always passed. At most ${MAX_EVENTS} events. Returns \`unscored\` with a reason when the daily budget is spent or no backend is set.`,
      inputSchema: z.object({
        session_id: z.string().min(1),
        turn_id: z.string().min(1),
        predicates: z.array(PredicateInput).min(1).max(5),
        types: z.array(z.string()).default([]).describe('Only these event types, e.g. ["model.message"].'),
        limit: z.number().int().min(1).max(MAX_EVENTS).default(20),
        max_chars: maxChars,
      }),
      outputSchema: z.object({
        provenance: z.literal("observed"),
        status: Status,
        reason: z.string().optional(),
        judged_by: z.string().optional(),
        events: z.array(
          z.object({
            citation: SessionCitation,
            type: z.string(),
            answers: z.record(z.string(), z.number().nullable()),
            unscored: z.string().optional(),
          }),
        ),
        cost_usd: z.number(),
        budget: BudgetView,
        ...listCut,
      }),
      annotations: TRIAGE_ANNOTATIONS,
    },
    guarded(async (args): Promise<CallToolResult> => {
      const names = args.predicates.map((p) => p.name);
      if (new Set(names).size !== names.length) return refuse("two predicates share a name", "give each a unique name");
      // Event text goes to an outside API, so only Experiment Sessions qualify (#57).
      const session = await deps.sessions.getSession(args.session_id);
      if (!isExperiment(session))
        return refuse(
          `Session ${session.id} is not an Experiment Session, and the user's chat isn't sent to the triage judge`,
          "use list_events and read the events yourself",
        );
      // Page through the whole Turn, so the type filter sees every event.
      const all: SessionEvent[] = [];
      let cursor: string | undefined;
      do {
        const page = await deps.sessions.listTurnEvents(args.session_id, args.turn_id, {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        all.push(...page.items);
        cursor = page.next;
      } while (cursor);
      const events = all.filter((e) => !args.types.length || args.types.includes(e.type)).slice(0, args.limit);

      // Every call is checked against the budget on its own, so the events
      // judged before the cap is reached keep their answers.
      let costUsd = 0;
      const results = await mapLimit(events, CONCURRENCY, async (e) => {
        const input = eventInput(e);
        const judged = await judge(input.length, names.length, (d) => d.predicate(input, args.predicates));
        if (typeof judged !== "string") costUsd += judged.costUsd;
        return judged;
      });
      const rows = events.map((e, i) => {
        const judged = results[i];
        const answers =
          judged && typeof judged !== "string"
            ? Object.fromEntries(names.map((n) => [n, judged.answers[n] ?? null]))
            : Object.fromEntries(names.map((n) => [n, null]));
        return {
          citation: { session_id: args.session_id, turn_id: args.turn_id, event_id: e.id },
          type: e.type,
          answers,
          ...(typeof judged === "string" ? { unscored: judged } : {}),
        };
      });
      const firstFailure = results.find((r) => typeof r === "string");
      const allFailed = results.length > 0 && results.every((r) => typeof r === "string");
      if (!events.length)
        return ok(
          fitList(
            unscoredResult("observed", "no events of those types in this Turn"),
            "events",
            rows,
            args.max_chars,
          ),
        );
      if (allFailed && typeof firstFailure === "string")
        return ok(fitList(unscoredResult("observed", firstFailure), "events", rows, args.max_chars));
      return ok(
        fitList(
          {
            provenance: "observed" as const,
            status: "judged" as const,
            ...(decide ? { judged_by: decide.backend } : {}),
            cost_usd: costUsd,
            budget: budgetView(),
          },
          "events",
          rows,
          args.max_chars,
        ),
      );
    }),
  );
}

// One event as the judge sees it. The `type` always goes first: #17 found that
// without it a pause event is nearly empty and its predicate fails.
export function eventInput(e: SessionEvent): string {
  const lines = [`One persisted event from a TrueForge agent Session.`, `Event type: ${e.type}`];
  switch (e.type) {
    case "model.message": {
      const text = textOf(e.content);
      if (text) lines.push(`Text: ${excerpt(text, EVENT_CHARS)}`);
      for (const c of e.toolCalls ?? [])
        lines.push(`Calls tool ${c.function.name} with ${excerpt(c.function.arguments, 300)}`);
      if (!e.toolCalls?.length) lines.push("Calls no tool.");
      break;
    }
    case "tool.response":
      lines.push(`Tool response for call ${e.toolCallId}: ${excerpt(e.content, EVENT_CHARS)}`);
      break;
    case "tool.approval_required":
      lines.push(`Waits for a human to approve ${e.toolCalls.length} tool call(s).`);
      break;
    default:
      break;
  }
  return lines.join("\n");
}

// Runs `fn` over `items`, at most `limit` at a time, keeping the input's order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  // Each worker takes the next index until none are left; JavaScript runs one
  // piece of code at a time, so `next++` can't be taken twice.
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
