// Registers (or replaces) the OpenRouter model provider on the local TrueForge server.
//
// Run it yourself from harness/, with the server already running:
//   bun run apply:provider
//
// The key is read from the repo-root .env (OPENROUTER_API_KEY), which the script's
// explicit `--env-file=../.env` loads (bunfig.toml turns implicit loading off), and
// is sent only to TrueForge on 127.0.0.1. It's never printed; the response is
// checked for redaction.

import { TRUEFORGE_ORIGIN as TRUEFORGE_URL } from "@forge-lab/lib/ports"; // `as` renames on import

// A type alias for the request body. `as const` below would also work, but an
// explicit type gives you autocompletion and catches typos at compile time.
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type CustomModel = {
  model_id: string; // the OpenRouter model id
  name: string; // TrueForge's name for it: lowercase, digits and hyphens
  properties: {
    context_length: number;
    max_output_tokens: number;
    // Declares which `reasoning_effort` values agents may set. Without it,
    // TrueForge rejects any agent that sets reasoning_effort (HTTP 422).
    reasoning_efforts?: ReasoningEffort[];
  };
};

type CustomProviderManifest = {
  type: "custom"; // a string literal type: only the exact value "custom" is allowed
  name: string;
  base_url: string;
  auth: { api_key: string };
  models: CustomModel[];
};

// 131k context (not the models' 1M) keeps turns cheap and makes compaction
// observable around 105k tokens. 16k output leaves room for reasoning tokens.
const limits = { context_length: 131_072, max_output_tokens: 16_384 };

const models: CustomModel[] = [
  // Main model: SOTA. 131k context still applies, so compaction stays observable
  // and a single turn can't silently cost dollars.
  {
    model_id: "anthropic/claude-opus-5.5",
    name: "opus-5-5",
    properties: { ...limits, reasoning_efforts: ["low", "medium", "high", "max"] },
  },
  // Cheaper alternatives, for work that doesn't need SOTA (mechanics Experiments, smoke tests).
  // GLM-5.3-Flash always reasons and defaults to max effort; declaring the
  // levels lets agents turn it down.
  {
    model_id: "z-ai/glm-5.3-flash",
    name: "glm-5-3-flash",
    properties: { ...limits, reasoning_efforts: ["low", "medium", "high", "max"] },
  },
  { model_id: "deepseek/deepseek-v4-flash-0731", name: "deepseek-v4-flash", properties: limits },
  // OpenRouter's Auto Router picks a model per request. TrueForge drops the
  // `plugins` body field, so its allowed models and cost tier must be set on the
  // OpenRouter account (Settings > Routing), not here.
  { model_id: "openrouter/auto", name: "openrouter-auto", properties: limits },
];

// Bun exposes environment variables on Bun.env (typed as string | undefined).
const apiKey = Bun.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is not set. Is it in the repo-root .env?");
  process.exit(1);
}

const manifest: CustomProviderManifest = {
  type: "custom",
  name: "openrouter",
  base_url: "https://openrouter.ai/api/v1",
  auth: { api_key: apiKey }, // after the check above, TypeScript narrows apiKey to string
  models,
};

// PUT is the upsert-by-name endpoint, so running this twice is safe.
const res = await fetch(`${TRUEFORGE_URL}/api/v1/settings/model-providers`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ manifest }),
});

// The response should show the key redacted. Fail loudly if it ever doesn't, on an
// error response too, since that's the one printed below.
const text = await res.text();
if (text.includes(apiKey)) {
  console.error("Unexpected: the response echoed the raw key. Not printing it.");
  process.exit(1);
}

if (!res.ok) {
  console.error(`TrueForge rejected the provider: HTTP ${res.status}`);
  // JSON.stringify escapes line breaks and control characters, so the response can't fake log lines.
  console.error(JSON.stringify(text));
  process.exit(1);
}

console.log(`Provider "openrouter" saved with models: ${models.map((m) => m.name).join(", ")}`);
