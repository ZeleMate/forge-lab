// `config_patch` (#9, #24): an Experiment changes one thing about the inline
// copy of Cartographer's spec. TrueForge's PATCH replaces the whole spec, so the
// patch is merged here, client-side, and the full spec is sent back.

import { serialization } from "@truefoundry/trueforge-sdk";
import { z } from "zod";
import type { AgentSpec } from "./api";

// The allowlist, in the wire's snake_case, since that's what the docs and the
// model see. `.strict()` makes zod reject any other key, so nothing outside it
// can be patched. The values' own shapes are checked by the SDK's schema below.
// Any JSON object; the SDK's schema checks what's inside (below).
const anyObject = z.record(z.string(), z.unknown());
export const ConfigPatch = z
  .object({
    context_management: anyObject.optional(),
    iteration_limit: z.number().int().min(1).max(200).optional(),
    model: z.object({ params: anyObject }).strict().optional(),
    dynamic_sub_agents: anyObject.optional(),
    sandbox: z.object({ enabled: z.boolean() }).strict().optional(),
  })
  .strict()
  .describe(
    "Changes to the Experiment Session's own copy of the spec. Only these keys; nested objects are merged, other values replaced.",
  );
export type ConfigPatch = z.infer<typeof ConfigPatch>;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

// Objects merge key by key; anything else (numbers, arrays) is replaced whole.
export function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

// `unrecognizedObjectKeys: "fail"` makes the SDK's schema reject a key it
// doesn't know, so a typo inside an allowed object is refused, not dropped.
const strict = { unrecognizedObjectKeys: "fail" } as const;

export type Patched = { ok: true; spec: AgentSpec } | { ok: false; reason: string };

export function applyConfigPatch(spec: AgentSpec, patch: ConfigPatch): Patched {
  // The SDK types the wire form as its own `Raw` interface; going through
  // `unknown` tells TypeScript we mean to treat it as plain JSON.
  const wire = serialization.AgentSpec.jsonOrThrow(spec) as unknown as Json;
  // `model.params` sits on the model; everything else sits under `config`.
  const { model, ...config } = patch;
  let merged = deepMerge(wire, { config });
  if (model) merged = deepMerge(merged, { model });
  const parsed = serialization.AgentSpec.parse(merged, strict);
  if (!parsed.ok)
    return { ok: false, reason: parsed.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ") };
  return { ok: true, spec: parsed.value };
}
