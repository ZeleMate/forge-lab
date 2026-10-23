// Sandbox check for ticket #11: does TrueForge's local sandbox work, does code
// mode work, and what does the sandbox actually isolate?
//
//   bun run sandbox-check
//
// Uses the cheap GLM model. The isolation probe prints only ALLOWED/BLOCKED,
// never file contents, so nothing private reaches the model provider.

import {
  allEvents,
  ensureDeepWiki,
  openExperimentSession,
  runTurn,
  saveResults,
  serverVersion,
  summarise,
  upsertAgent,
} from "@forge-lab/lib/trueforge";

import { homedir } from "node:os";
import { resolve } from "node:path";

const REAL_HOME = homedir();
const REPO_ENV = resolve(import.meta.dir, "../../.env"); // the repo-root .env holding the OpenRouter key

console.log(`TrueForge ${await serverVersion()}\n`);
await ensureDeepWiki();

const agent = await upsertAgent("sandbox-check-glm", "Sandbox and code-mode check on GLM", {
  model: { name: "openrouter/glm-5-3-flash", params: { max_tokens: 16_384 } },
  instructions:
    "You are testing a sandbox. Run exactly what you're asked to run, then report the literal output. Don't improvise extra commands.",
  mcp_servers: [{ name: "deepwiki" }],
  config: { iteration_limit: 20, sandbox: { enabled: true } },
});
const session = await openExperimentSession(agent, "sandbox-check");

const prompts = {
  exec: "In the sandbox, run a Python script that prints sys.version, platform.platform() and sum(range(1_000_001)). Report the three lines exactly.",
  codeMode:
    "Using code mode, write and run ONE script that calls the deepwiki tools twice on the repo truefoundry/trueforge: first ask how context compaction is triggered, then ask how tool approvals pause a turn. Print the first 200 characters of each answer. Report what the script printed.",
  // Absolute host paths: inside the sandbox $HOME is remapped to a private
  // `.home` folder, so "$HOME/..." would only probe the sandbox itself.
  isolation: [
    "In the sandbox, run this exact shell snippet and report its output verbatim:",
    "curl -s -o /dev/null -m 8 https://example.com && echo 'net example.com: ALLOWED' || echo 'net example.com: BLOCKED';",
    "curl -s -o /dev/null -m 8 https://pypi.org && echo 'net pypi.org: ALLOWED' || echo 'net pypi.org: BLOCKED';",
    `test -r '${REAL_HOME}/.zshrc' && echo 'read real ~/.zshrc: ALLOWED' || echo 'read real ~/.zshrc: BLOCKED';`,
    `test -r '${REPO_ENV}' && echo 'read repo .env: ALLOWED' || echo 'read repo .env: BLOCKED';`,
    `touch '${REAL_HOME}/tf-sandbox-write-probe' 2>/dev/null && echo 'write real ~/: ALLOWED' || echo 'write real ~/: BLOCKED';`,
    "touch /tmp/tf-sandbox-write-probe 2>/dev/null && echo 'write /tmp: ALLOWED' || echo 'write /tmp: BLOCKED';",
    'echo "sandbox HOME: $HOME"',
  ].join("\n"),
};

const results: Record<string, unknown> = { session };
let previous: string | undefined;
for (const [name, prompt] of Object.entries(prompts)) {
  const turn = await runTurn(session, prompt, previous, 300_000);
  previous = turn.id;
  const events = await allEvents(session, turn.id);
  // The final assistant text: the last model.message's content.
  const last = [...events].reverse().find((e) => e.type === "model.message");
  results[name] = { ...summarise(turn, events), answer: String(last?.content ?? "").slice(0, 1_500) };
  console.log(`== ${name}\n${JSON.stringify(results[name], null, 2)}\n`);
}

console.log(`Saved to ${await saveResults(`${import.meta.dir}/../sandbox-results`, results)}`);
