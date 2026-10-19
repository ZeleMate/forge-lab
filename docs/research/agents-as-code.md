# Can agents be defined as code in the repo?

Resolves forge-lab#6. Researched 2026-10-18 against primary sources only: the TrueForge docs (`trueforge.dev/*.md`), the server's published OpenAPI spec (`trueforge.dev/openapi.json`, version `0.0.0`), and the published npm packages `@truefoundry/trueforge-sdk@0.179.0` and `@truefoundry/trueforge-core@0.179.0` (tarballs unpacked, `.d.mts` types and `reference.md` read). Nothing was run against a live server: Node and Bun were not available in the research environment. Items marked **(unverified)** need a smoke test.

## Short answer

Yes, mostly. The whole agent spec (`AgentSpec`) is a plain JSON document that fits in a versioned file. Every field can be set through the REST API and the TS SDK, so a repo file can be the source of truth. Three things get in the way of a one-command "apply":

1. **No upsert for agents.** `POST /agents` fails with 409 on a duplicate name, and `PUT /agents/{agent_id}` needs the server-generated id. The apply script has to do list, match by exact name, then create or update. The shared resources an agent references (model providers, MCP servers, skills, sandbox environments) do have upsert-by-name.
2. **The package is wrong.** The client SDK is `@truefoundry/trueforge-sdk`. `@truefoundry/trueforge-core` is the server's agent-loop library and has no HTTP client (see [Package correction](#package-correction)).
3. **The sandbox provider is Daytona only** (a hosted service with its own API key), which affects the "code mode on a local run" plan (see [Sandbox](#sandbox-and-code-mode)).

## Package correction

The map says glue scripts use `@truefoundry/trueforge-core`. The docs say otherwise:

- SDK quickstart: the TypeScript client is `@truefoundry/trueforge-sdk`, used as `import { TrueForge } from '@truefoundry/trueforge-sdk'` (`/api/quickstart.md`).
- The `trueforge-core` README says it is "the library the TrueForge server is built on", "not a complete product on its own", points users to `@truefoundry/trueforge` for "HTTP APIs, a TypeScript SDK, and a chat UI", and warns it "does not offer backward compatibility guarantees". Its dependencies are server-side (`hono`, `ai`, `@daytona/sdk`, `@modelcontextprotocol/sdk`, `@ai-sdk/*`). It is the in-process harness, not a client.
- `trueforge-sdk@0.179.0` is Fern-generated, has zero runtime dependencies, requires Node >=22, ships ESM and CJS with `.d.ts`, and has a full `reference.md`. Versions track the server (both packages are 0.179.0 as of 2026-10-14).

So the stack decision should read `@truefoundry/trueforge-sdk`. Bun runs it (**unverified**; it needs only `fetch`).

## Agent spec shape

Saved agent = `{ name, description, manifest: AgentSpec }`. `name` matches `^[a-z][a-z0-9-]{0,62}[a-z0-9]$` and cannot change after creation; `description` is required (1 to 1024 chars). Source: `CreateAgentRequest` and `ResourceName` in the OpenAPI spec; `/create-agent/overview.md`.

`AgentSpec` (OpenAPI schema `AgentSpec`; TS interface in `dist/esm/api/types/AgentSpec.d.mts`). Wire format is `snake_case`; the TS SDK exposes `camelCase` (`mcpServers`, `requireApprovalForTools`, `iterationLimit`).

| Field | Shape | Notes |
| - | - | - |
| `model` (required) | `{ name: "provider/model", params? }` | `name` is an FQN of a configured provider + model, e.g. `anthropic/claude-sonnet-4-6`. `params`: `max_tokens`, `temperature`, `top_p`, `top_k`, `parallel_tool_calls`, `reasoning_effort`, plus arbitrary extra keys forwarded to the provider. |
| `instructions` | string | System prompt. The harness appends its own guidance for enabled capabilities. |
| `mcp_servers[]` | `{ name, enable_tools, disable_tools, preload, preload_tools, require_approval_for_tools }` | Attaches a configured MCP server by name. Defaults: `enable_tools ["@all"]`, `disable_tools []`, `preload false`, `preload_tools []`, `require_approval_for_tools ["@write","@destructive"]`. Selectors: `@all`, `@read-only` for enable/disable; `@all`, `@write`, `@destructive` for approval; or literal tool names. `@write`/`@destructive` only match tools the MCP server annotated, so unannotated tools run without approval. A non-empty `preload_tools` implies `preload: false`. |
| `skills[]` | `{ name, preload? }` (max 50) | Name-only reference to a configured skill. `preload` (inline SKILL.md into the prompt) is in the OpenAPI schema but not in the docs prose. Requires `config.sandbox.enabled`. |
| `config.sandbox` | `{ enabled, environment_name?, file_downloads }` | `enabled` default `false`. `environment_name` must name an existing sandbox environment; it appears in OpenAPI and the SDK but not in the docs table. |
| `config.dynamic_sub_agents` | `{ enabled }` (default true) | The only subagent setting. See [Subagents](#subagents). |
| `config.generative_ui`, `config.ask_user_questions` | `{ enabled }` (default true) | |
| `config.web_search` | `{ enabled }` (default false) | In OpenAPI/SDK, not in the docs table. Needs a configured web-search provider. |
| `config.context_management` | `{ compaction: { enabled, trigger: { type: "input_tokens", value } }, large_tool_response: { enabled } }` | Compaction trigger defaults to 80% of model context, or 50,000 tokens if unknown. |
| `config.iteration_limit` | int 1 to 1024 | OpenAPI default 512. The docs prose says "default 100" in one place and 512 in the table; trust OpenAPI and set it explicitly. |
| `response_format` | `{type: "text"}`, `{type: "json_object"}`, or `{type: "json_schema", json_schema}` | |
| `messages[]` | `[{ type: "user.message", content }]` | Seed messages injected at the start of every new session. |

### Mapping the map's list to the spec

- **Model:** `model.name` plus `model.params`.
- **Instructions:** `instructions`.
- **MCP servers:** `mcp_servers[]`, including per-server tool allow/deny lists.
- **Skills:** `skills[]` (names only; the skill itself is registered separately, see [Dependencies](#dependencies-the-agent-references-by-name)).
- **Sandbox:** `config.sandbox`.
- **Approval policy:** only per MCP server, via `require_approval_for_tools`. There is no agent-wide approval setting. A second mechanism exists at runtime: a `user.tool_approval_policy` turn event with an `allow_session` action, which lets a client grant "approve once for this session" (OpenAPI `UserToolApprovalPolicyEvent`). That is session state, not agent config. The roadmap lists "Approve once" as planned, so check whether it overlaps.
- **Subagents:** see below.
- **Deferred tools:** `mcp_servers[].preload` (all tools upfront) and `preload_tools` (selected tools eager, rest deferred). Default is deferred discovery.
- **Code mode:** no flag of its own. See below.

### Subagents

Only one knob exists: `config.dynamic_sub_agents.enabled`. Subagents are spawned dynamically by the harness at runtime ("lightweight, isolated agent runs", `/key-features/subagents.md`). The spec has no place to declare named subagents with their own model, instructions or tools. If Paper Scout needs a specialised "reader" subagent, it can only be steered through the root `instructions`.

### Sandbox and code mode

Code Mode is "available whenever the agent's sandbox is enabled" (`/key-features/code-mode.md`); the agent decides at runtime whether to write a script. Approval policies still apply to tool calls made from a script. Skills also require the sandbox.

The only sandbox provider today is Daytona (`SandboxProviderManifest.type` is the enum `["daytona"]`; `/sandbox.md`: "Daytona is the only sandbox provider supported today"). It needs a Daytona API key with `write:sandboxes`, `write:snapshots`, `manage:secrets`. The roadmap lists "Local sandbox execution" as planned, not shipped. Consequence: a purely local TrueForge run cannot use code mode or skills without a Daytona account. This needs its own ticket (see [New tickets](#suggested-new-tickets-and-effects-on-other-tickets)).

## UI-only vs API-only

Source: `/create-agent/overview.md`.

- **API only:** `model.params`, `response_format`, `messages` (seed messages), `mcp_servers[].enable_tools`/`disable_tools`/`preload_tools`, `config.context_management` (compaction trigger, large-tool-response toggle), `config.iteration_limit` and `sandbox.file_downloads` per the per-field "Set via" columns. The prose in the same page contradicts itself here (the UI section says iteration limit and compaction are in Runtime Config; the field tables say API). Treat these as "API always works".
- **UI and API:** model choice, instructions, MCP server attach, approval, `preload`, skills, sandbox on/off, subagents/generative UI/ask-questions toggles.
- **UI-only:** none found. The docs state that the API exposes "every option" and the roadmap item "More flexible agent saving" aims to expose more options in the UI, not the API. `sandbox.environment_name` and `web_search` appear in OpenAPI/SDK but not in docs; whether the UI surfaces them is unknown.
- **Not part of an agent at all (Settings, no UI needed):** provider credentials, MCP connector URLs and auth, skill git sources, sandbox provider and environments. All have REST/SDK endpoints.

So the "some options only settable through the API" note in the ticket is correct (model params, response format, seed messages, tool allow/deny lists, context management), and it works in our favour: a file-based approach is a superset of the UI.

## Idempotent upsert

| Resource | Upsert by name? | Endpoint / SDK | Notes |
| - | - | - | |
| Agent | **No** | `POST /api/v1/agents` (409 on duplicate name); `PUT /api/v1/agents/{agent_id}` by immutable id. SDK `agents.create/get/update/delete/list`. | `list` takes `agent_name` (documented as substring filter), so the script must match the exact name client-side. `PUT` replaces the whole manifest; `description` is optional on update. Create-vs-update race can still yield 409 (fine for a local single-user setup). |
| Model provider | **Yes** | `PUT /api/v1/settings/model-providers`, SDK `settings.modelProviders.createOrUpdate` | Body `{ manifest: { type: "anthropic", auth: { api_key }, models: [{ name, model_id, properties }], base_url? } }`. Well-known types use `type` as the name (one each). Whole-resource replace, models included. `api_key` redacted value keeps the stored key. |
| MCP server | **Yes** | `PUT /api/v1/settings/mcp-servers`, SDK `settings.mcpServers.createOrUpdate` | Body `{ manifest: { type: "remote", name, url, description, auth? } }`, `auth` is `{type:"header", headers}` or `{type:"dcr"}` or omitted. Redacted header value keeps the stored secret (400 if none stored). DCR registration runs on create and can return 424. |
| Skill | **Yes** | `PUT /api/v1/settings/skills`, SDK `settings.skills.createOrUpdate` | Body `{ manifest: { type: "git", name, url, ref, path?, description } }` (HTTPS GitHub or GitLab only), or a `truefoundry` registry skill. `ref` is required, so pin a SHA. |
| Sandbox environment | **Yes** | `PUT /api/v1/sandbox-environments`, SDK `sandboxEnvironments.createOrUpdate` | Keyed by `manifest.name`; needs a configured sandbox provider; the name `default` is reserved. |
| Sandbox provider | Singleton upsert | `PUT /api/v1/settings/sandbox-providers` | Daytona only. |
| Web search provider | Singleton upsert | `PUT /api/v1/settings/web-search-providers` | |
| Schedule | No | `POST/PUT /schedules`, by id | Optional ticket scope; references agent by name. |

Deleting is guarded: an MCP server, skill, model or sandbox environment cannot be deleted while any agent references it. That also means the apply order matters on teardown.

### Dependencies the agent references by name

`model.name` = `<provider name>/<model name>` (the ConfiguredModel `name`, not its upstream `model_id`), `mcp_servers[].name`, `skills[].name` and `sandbox.environment_name` must already exist when the agent is saved. **(unverified)** whether `POST/PUT /agents` validates these at save time or only at session start; the delete guard suggests the server tracks references, so expect save-time validation.

## Inline specs on sessions

Yes. `POST /api/v1/sessions` takes `agent` as either `{ name }` (reference to a saved agent) or `{ spec: AgentSpec }` (inline, nothing saved) (OpenAPI `CreateSessionAgent`; `/create-agent/overview.md`; `/api/use-agent.md`). Details:

- A named session "snapshots the agent name at create and resolves the live agent on each turn", so editing the saved agent changes behaviour for existing sessions on their next turn. An inline session stores the spec in the session (response `{ type: "inline", spec }`).
- `PATCH /api/v1/sessions/{id}` can replace an inline session's spec (`agent: { spec }`); named sessions reject agent updates.
- `POST /api/v1/sessions` also takes `metadata` (string values, max 128 chars each) for caller-owned tags such as a spec file hash.
- The inline spec still references models, MCP servers, skills and environments by name, so those must be configured first.

Implication: the repo file could be loaded and sent inline with every session, which skips agent upsert entirely. Trade-off: the UI's Agents library and the `<TrueForgeUI>` fixed-agent / agent-library modes work best with a saved, named agent, and the Sessions inspection view shows an inline agent less conveniently (**unverified**). For a chat app that embeds the UI package, saved-by-name is the safer default.

## Sketch: config as code

Layout (names are suggestions):

```
agents/
  paper-scout.agent.json      # { name, description, manifest }  (AgentSpec, snake_case = wire format)
  paper-scout.instructions.md # long prompt, inlined by the apply script
infra/
  trueforge.resources.ts      # model provider, MCP servers, skills, sandbox env as typed objects
scripts/
  apply.ts                    # bun run apply
```

Secrets stay out of the repo: the resource file references `process.env.ANTHROPIC_API_KEY` (and the MCP server's header token, Daytona key). The spec files hold no secrets because agents only reference resources by name.

Apply order and idempotency:

1. `settings.modelProviders.createOrUpdate` (Anthropic, with models).
2. `settings.mcpServers.createOrUpdate` for our Paper Scout MCP server (`type: "remote"`, `url` = our server's address; header auth if needed). If it is OAuth/DCR, the user must still click Connect once in the UI.
3. `settings.skills.createOrUpdate` (optional; pin a commit SHA).
4. `settings.sandboxProviders.createOrUpdate` and `sandboxEnvironments.createOrUpdate` (only if code mode is wanted).
5. Agent upsert: `agents.list({ agentName })`, filter for exact `name`, `agents.update(id, { description, manifest })` if found, else `agents.create({ name, description, manifest })`.
6. For drift detection (optional), `agents.get` and diff against the file (the API returns the stored manifest with defaults filled in, so normalise before diffing).

Sketch of step 5 with the SDK (camelCase TS surface):

```ts
import { TrueForge } from "@truefoundry/trueforge-sdk";

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790" });

export async function upsertAgent(name: string, description: string, manifest: TrueForge.AgentSpec) {
  for await (const a of await client.agents.list({ agentName: name })) {
    if (a.name === name) {
      return (await client.agents.update(a.id, { description, manifest })).data;
    }
  }
  return (await client.agents.create({ name, description, manifest })).data;
}
```

This is illustrative only and was not executed. Points to check when implementing: whether `list` returns `Page` items directly and whether `create`/`update` return `{ data }` (the docs example destructures `{ data: agent }` for `create`); whether camelCase keys inside `model.params` extras are converted (`[key: string]: any` passes through, but known keys like `maxTokens` are mapped).

Typing: `TrueForge.AgentSpec` and friends are exported from the SDK, so `satisfies TrueForge.AgentSpec` on a TS object gives compile-time checks. A JSON file would need runtime validation (the OpenAPI spec could feed a JSON-schema validator, or keep specs as `.ts` modules and skip JSON). For a TS learner, `.ts` spec modules exporting typed objects are probably the lowest-friction choice. The SDK also exports a `serialization` subpath (`./serialization`) with schemas, which may offer runtime validation **(unverified)**.

Alternative: skip agent upsert, store only resources as code, and pass the spec inline per session. Simpler apply, but loses the saved agent in the UI library, and each session carries its own copy of the spec.

## Gaps and risks

- No official declarative format (no YAML manifest, no `trueforge apply`). The roadmap's only agent-authoring items are UI exposure and AI-assisted authoring, so this is a gap we fill with our own script.
- Server is `0.x`, spec version `0.0.0`, and `trueforge-core` explicitly has no compatibility guarantees. Pin the server and SDK versions in the repo.
- Update is full replace: a field missing from the file reverts to its default on apply (good for "file is truth", bad if someone tweaks in the UI).
- Agents are visible to everyone on the instance and carry no secrets; keep it that way. In local mode this does not matter.
- Local mode: default `http://localhost:8790`, no auth, SQLite. `PUBLIC_BASE_URL` matters only for MCP OAuth (`/mcp-servers.md`).

## Suggested new tickets and effects on other tickets

- **Correct the SDK package name** in the map's Stack line: `@truefoundry/trueforge-sdk`, not `-core`.
- **New research/decision ticket: sandbox for local runs.** Daytona is the only provider and needs an account and API key. Decide whether Paper Scout's code mode and skills are in scope (demands a Daytona key) or deferred until local sandbox ships.
- **New ticket: declare subagent behaviour.** The spec can't define named subagents; decide how the instructions steer dynamic subagents, and how to inspect them in sessions.
- Affects the "Agent instructions and skills" and "Local dev workflow" items on the map: the apply script becomes part of the one-command bring-up (after the TrueForge server and our MCP server are up, before the web app).
- Affects the approval design: approval is per-MCP-tool via `require_approval_for_tools`, and relies on tool annotations (read/write/destructive) that **our own MCP server must set**, or the tools must be listed by name.

## Sources

- https://trueforge.dev/llms.txt
- https://trueforge.dev/create-agent/overview.md
- https://trueforge.dev/agent-library.md
- https://trueforge.dev/api/quickstart.md, https://trueforge.dev/api/overview.md, https://trueforge.dev/api/use-agent.md
- https://trueforge.dev/skills.md, /sandbox.md, /models.md, /mcp-servers.md, /harness/initial-setup.md, /key-features/code-mode.md, /key-features/subagents.md, /roadmap.md, /quickstart.md
- https://trueforge.dev/openapi.json (schemas `AgentSpec`, `CreateAgentRequest`, `UpdateAgentRequest`, `MCPServer`, `Skill`, `RuntimeConfig`, `SandboxConfig`, `CreateSessionAgent`, `UpdateSessionRequest`, `SkillManifest`, `GitSkill`, `RemoteMCPServerManifest`, `ModelProviderManifest`, `SandboxProviderManifest`; paths under `/api/v1/agents`, `/settings/*`, `/sandbox-environments`, `/sessions`)
- npm: `@truefoundry/trueforge-sdk@0.179.0` (README, `reference.md`, `dist/esm/api/types/*.d.mts`), `@truefoundry/trueforge-core@0.179.0` (README, package.json)
