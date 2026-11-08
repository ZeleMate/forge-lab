// Registers the repo's specs on the local TrueForge (#32, #35): the MCP servers
// `source`, `sessions` and `triage`, then the `cartographer` Agent.
//
//   bun run apply              show what differs from the server, then overwrite it
//   bun run apply -- --dry-run show the differences only, write nothing
//
// The repo wins. The diff lists only the fields the repo sets (the server fills
// in defaults for the rest), but each write replaces the whole server copy.
// `bun run dev` calls `apply()` on every start. The OpenRouter provider is the
// user's own `apply:provider` (it carries the key); this script only checks that
// it's there, reads no key and sends none.

import { parseArgs } from "node:util";
import { cartographer, mcpServers } from "@forge-lab/agents/cartographer";
import { api, findAgent, listAll, request, serverVersion } from "@forge-lab/lib/trueforge";
import { serialization } from "@truefoundry/trueforge-sdk";

// The SDK's schemas turn our camelCase specs into the snake_case wire format.
// "fail" rejects any key the schema doesn't know, so a typo in a spec stops here.
const strict = { unrecognizedObjectKeys: "fail" } as const;

type Json = unknown;
type Change = { path: string; server: string; repo: string };

// ---------- diff ----------

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// One value, short enough for one line of output.
function show(value: Json): string {
  if (value === undefined) return "(unset)";
  if (typeof value === "string" && value.length > 60) return `${value.length} chars`;
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// For long strings (the instructions), say where they start to differ.
function stringChange(path: string, server: string, repo: string): Change {
  const a = server.split("\n");
  const b = repo.split("\n");
  const line = a.findIndex((l, i) => l !== b[i]);
  const at = line === -1 ? b.length : line; // -1: every server line matches, so the repo only adds lines
  return { path, server: `${server.length} chars`, repo: `${repo.length} chars, first difference at line ${at + 1}` };
}

// An array element's label: its `name` when it has one, else its index.
function label(item: Json, index: number): string {
  return isObject(item) && typeof item.name === "string" ? item.name : String(index);
}

// Walks only what the repo sets. Objects and arrays of objects recurse, so
// server-filled defaults inside them (`preload: false`, `disable_tools: []`)
// don't count as drift. Arrays of plain values compare whole.
function diff(repo: Json, server: Json, path = ""): Change[] {
  if (isObject(repo)) {
    if (!isObject(server)) return [{ path, server: show(server), repo: "{...}" }];
    // `flatMap` maps each key to a list of changes and joins the lists into one.
    return Object.entries(repo).flatMap(([key, value]) => diff(value, server[key], path ? `${path}.${key}` : key));
  }
  if (Array.isArray(repo) && repo.some(isObject)) {
    const names = repo.map((item, index) => label(item, index));
    const serverNames = Array.isArray(server) ? server.map((item, index) => label(item, index)) : [];
    if (names.join() !== serverNames.join()) {
      return [{ path, server: `[${serverNames.join(", ")}]`, repo: `[${names.join(", ")}]` }];
    }
    return repo.flatMap((item, i) => diff(item, (server as Json[])[i], `${path}[${names[i]}]`));
  }
  if (JSON.stringify(repo) === JSON.stringify(server)) return [];
  if (typeof repo === "string" && typeof server === "string" && repo.length > 60) {
    return [stringChange(path, server, repo)];
  }
  return [{ path, server: show(server), repo: show(repo) }];
}

// ---------- apply ----------

type Outcome = "new" | "changed" | "unchanged";

function report(kind: string, name: string, outcome: Outcome, changes: Change[], dryRun: boolean) {
  const verb = { new: dryRun ? "would create" : "created", changed: dryRun ? "would overwrite" : "overwrote" };
  if (outcome === "unchanged") return console.log(`= ${kind} ${name}: matches the repo`);
  const mark = outcome === "new" ? "+" : "~";
  console.log(`${mark} ${kind} ${name}: ${verb[outcome]}`);
  for (const c of changes) console.log(`    ${c.path}: ${c.server} -> ${c.repo}`);
}

async function requireProvider(modelName: string) {
  // The listing includes the provider's auth block: read names only, never print it.
  const providers = await listAll<{ name: string; manifest?: { models?: { name: string }[] } }>(
    "/settings/model-providers",
  );
  // Destructuring with a default: `model` is "" when the name has no "/".
  const [providerName, model = ""] = modelName.split("/");
  const provider = providers.find((p) => p.name === providerName);
  if (!provider) throw new Error(`no "${providerName}" model provider; run \`bun run apply:provider\` in harness/`);
  if (!provider.manifest?.models?.some((m) => m.name === model)) {
    throw new Error(`provider "${providerName}" has no model "${model}"; update it with \`bun run apply:provider\``);
  }
}

async function applyMcpServer(manifest: (typeof mcpServers)[number], dryRun: boolean) {
  const wire = serialization.RemoteMcpServerManifest.jsonOrThrow(manifest, strict);
  const res = await request("GET", `/settings/mcp-servers/${manifest.name}`);
  if (res.status !== 404 && res.status >= 400) throw new Error(`GET mcp-server ${manifest.name}: HTTP ${res.status}`);
  // `?.` stops at the first missing link and yields undefined instead of throwing.
  const current = res.status === 404 ? undefined : (res.json as { data?: { manifest?: Json } })?.data?.manifest;
  const changes = current === undefined ? [] : diff(wire, current);
  const outcome: Outcome = current === undefined ? "new" : changes.length ? "changed" : "unchanged";
  // PUT is an upsert by name.
  if (outcome !== "unchanged" && !dryRun) await api("PUT", "/settings/mcp-servers", { manifest: wire });
  report("MCP server", manifest.name, outcome, changes, dryRun);
}

async function applyAgent(dryRun: boolean) {
  const { name, description, manifest } = cartographer;
  const wire = serialization.AgentSpec.jsonOrThrow(manifest, strict);
  await requireProvider(manifest.model.name);
  const existing = await findAgent(name);
  const changes = existing ? diff({ description, manifest: wire }, existing) : [];
  const outcome: Outcome = !existing ? "new" : changes.length ? "changed" : "unchanged";
  if (!dryRun) {
    // Updates omit `name`: it's immutable, and PUT rejects it.
    if (outcome === "new") await api("POST", "/agents", { name, description, manifest: wire });
    if (outcome === "changed" && existing) await api("PUT", `/agents/${existing.id}`, { description, manifest: wire });
  }
  report("Agent", name, outcome, changes, dryRun);
}

// Throws on any failure, so `dev.ts` can stop the stack instead of exiting mid-shutdown.
export async function apply({ dryRun = false } = {}) {
  if ((await serverVersion()) === "unreachable") throw new Error("TrueForge isn't answering on 127.0.0.1:8790");
  // Servers first: the Agent attaches them by name.
  for (const server of mcpServers) await applyMcpServer(server, dryRun);
  await applyAgent(dryRun);
}

// `import.meta.main` is true only when this file is run directly, not imported by dev.ts.
if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { "dry-run": { type: "boolean" } } });
  try {
    await apply({ dryRun: values["dry-run"] ?? false });
  } catch (error) {
    console.error(`apply: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
