// The result contract every tool follows (#8, #27, #54):
// - success: compact JSON in `structuredContent` (checked against the tool's
//   `outputSchema`) and the same JSON as text, kept under `max_chars`;
// - every result names its provenance (`source` or `observed`) and cites
//   `{path, line, sha}` or `{session_id, turn_id, event_id}`;
// - refusals and failures are `isError` results with one line of text. A tool
//   never throws, so the model always gets a reason it can act on.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

export const Provenance = z.enum(["source", "observed"]);

// `sha` is the 7-character short form, as in the prose form `path:line@sha7`.
export const SourceCitation = z.object({ path: z.string(), line: z.number().int(), sha: z.string() });
// `z.infer` turns a schema into the TypeScript type it validates.
export type SourceCitation = z.infer<typeof SourceCitation>;

// About 6k tokens is where TrueForge offloads a tool result to a file. Code and
// JSON tokenize nearer 3 characters per token than 4, so 18,000 stays under it.
export const MAX_CHARS_LIMIT = 18_000;
export const DEFAULT_MAX_CHARS = 16_000;
export const maxChars = z
  .number()
  .int()
  .min(500)
  .max(MAX_CHARS_LIMIT)
  .default(DEFAULT_MAX_CHARS)
  .describe("Upper bound on the JSON result's length in characters. Items past it are dropped and counted.");

export function ok<T extends Record<string, unknown>>(structured: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

export function refuse(reason: string, hint: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `refused: ${reason}. Try: ${hint}` }] };
}

// Wraps a tool handler so an unexpected exception becomes an `isError` result.
// `A` is a type parameter: the wrapper accepts and passes on whatever arguments
// the handler takes, so the SDK still sees the handler's own argument type.
export function guarded<A>(handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      // `catch` gives `unknown`: anything can be thrown, not only Error objects.
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text", text: `error: ${message}` }] };
    }
  };
}

// Puts `items` under `key` next to `fields`, dropping items from the end until
// the JSON is at most `limit` characters. Callers sort best-first, so what's
// dropped is what matters least. `truncated` and `omitted` say what happened.
export function fitList<F extends Record<string, unknown>, K extends string, I>(
  fields: F,
  key: K,
  items: I[],
  limit: number,
) {
  // A computed key `[key]` with a type parameter `K`: the result type has a
  // property literally named after the argument (e.g. `matches: I[]`).
  const build = (kept: I[]) =>
    ({ ...fields, [key]: kept, truncated: kept.length < items.length, omitted: items.length - kept.length }) as F &
      Record<K, I[]> & { truncated: boolean; omitted: number };
  // Binary search for the longest prefix that fits: the JSON length grows with
  // the prefix, so this needs about log2(n) serialisations instead of n.
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(build(items.slice(0, mid))).length <= limit) lo = mid;
    else hi = mid - 1;
  }
  return build(items.slice(0, lo));
}
