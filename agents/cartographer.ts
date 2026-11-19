// The Cartographer Agent as code (#27), plus the three MCP servers it attaches (#8).
// `scripts/apply.ts` registers both on the local TrueForge; Experiment scripts
// import `cartographer.manifest` for their inline Experiment Session copies.
//
// Fields are the SDK's camelCase types (`maxTokens`, `mcpServers`). The REST API
// takes snake_case, so apply.ts converts with the SDK's `serialization` schemas.

import { HOST, PORTS } from "@forge-lab/lib/ports";
// `import type` is erased when Bun strips types: this file loads no SDK code at runtime.
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

// Top-level `await` works in ES modules: importers wait until the file is read.
const instructions = await Bun.file(`${import.meta.dir}/cartographer.instructions.md`).text();

// The servers are endpoints of one MCP process on 127.0.0.1:8791 (#8, #32).
export const MCP_SERVER_NAMES = ["source", "sessions", "triage"] as const;
// Indexing a tuple type with `number` gives the union of its elements: "source" | "sessions" | "triage".
export type McpServerName = (typeof MCP_SERVER_NAMES)[number];

const descriptions: Record<McpServerName, string> = {
  source: "Read TrueForge's pinned Source Snapshot: status, text search, files, declarations, references and types.",
  sessions: "Inspect TrueForge's own Sessions, Turns and events; fork, re-run or cancel Experiment Sessions only.",
  triage: "Rank candidates by relevance and check events with the OpenAI Decisions API. Costs money; capped daily.",
};

export const mcpServers: TrueForgeApi.RemoteMcpServerManifest[] = MCP_SERVER_NAMES.map((name) => ({
  type: "remote",
  name,
  url: `http://${HOST}:${PORTS.mcp}/mcp/${name}`,
  description: descriptions[name],
}));

// #27's attachment table, defaults written out so the spec reads on its own.
const gated: TrueForgeApi.McpServerApprovalToolSelector[] = ["@write", "@destructive"];

const manifest = {
  model: {
    name: "openrouter/opus-5-5",
    params: { reasoningEffort: "medium", maxTokens: 16_384, parallelToolCalls: true }, // temperature unset
  },
  instructions,
  mcpServers: [
    {
      name: "source",
      enableTools: ["@all"],
      preloadTools: ["source_status", "search_text", "read_file"],
      requireApprovalForTools: gated,
    },
    // The two tools that read the user's other chats are read-only, so their
    // annotations don't match `@write`; naming them makes each call ask the user.
    // TrueForge also refuses a name-gated tool from sandbox code (CodeModeDispatcher).
    {
      name: "sessions",
      enableTools: ["@all"],
      requireApprovalForTools: [...gated, "get_chat_turn", "list_chat_events"],
    },
    { name: "triage", enableTools: ["@all"], requireApprovalForTools: gated },
  ],
  config: {
    iterationLimit: 40,
    contextManagement: {
      compaction: { trigger: { type: "input_tokens", value: 64_000 } },
      largeToolResponse: { enabled: true },
    },
    sandbox: { enabled: true, fileDownloads: false },
    dynamicSubAgents: { enabled: true },
    askUserQuestions: { enabled: true },
    generativeUi: { enabled: false },
    webSearch: { enabled: false },
  },
  // `satisfies` checks the object against the type but keeps its own, narrower
  // inferred type (so `manifest.config.iterationLimit` is known to exist).
} satisfies TrueForgeApi.AgentSpec;

export const cartographer = {
  name: "cartographer",
  description:
    "Explains how TrueForge works from its pinned source and its own live Sessions, with every claim labelled and cited.",
  manifest,
};
