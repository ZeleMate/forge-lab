// Smoke test for the local TrueForge + OpenRouter setup (ticket #7).
//
//   bun run smoke                  # all models
//   bun run smoke glm-5-3-flash    # just one
//
// For each model it: registers the DeepWiki MCP server, upserts a `smoke-<model>`
// agent, opens an Experiment Session tagged experiment=smoke, runs a tool-using
// Turn plus a short follow-up (cache check), and, on GLM, a Subagent Turn.
// It never touches provider keys: TrueForge already holds them.

import {
  ALL_MODELS,
  allEvents,
  ensureDeepWiki,
  type ModelName, // `type` imports are erased at runtime; they exist only for the compiler
  openExperimentSession,
  runTurn,
  saveResults,
  serverVersion,
  summarise,
  upsertAgent,
} from "@forge-lab/lib/trueforge";

const requested = Bun.argv.slice(2) as ModelName[];
const models = requested.length ? requested : [...ALL_MODELS];
console.log(`TrueForge ${await serverVersion()}; models: ${models.join(", ")}\n`);

await ensureDeepWiki();
const results: Record<string, unknown> = {};

for (const model of models) {
  const withSubagents = model === "glm-5-3-flash";
  const agent = await upsertAgent(`smoke-${model}`, `Smoke-test agent on ${model}`, {
    // No reasoning_effort: TrueForge rejects it unless the provider manifest
    // declares `reasoning_efforts` for the model (HTTP 422 otherwise).
    model: { name: `openrouter/${model}`, params: { max_tokens: 16_384 } },
    instructions:
      "You answer questions about the truefoundry/trueforge GitHub repository. Use the deepwiki tools; don't guess.",
    mcp_servers: [{ name: "deepwiki" }], // deferred by default: the model must discover the tools
    config: { iteration_limit: 20, dynamic_sub_agents: { enabled: withSubagents } },
  });
  const session = await openExperimentSession(agent, "smoke");

  const t1 = await runTurn(
    session,
    "In truefoundry/trueforge, how does the agent loop decide when to compact the context? Answer in 3 short bullets.",
  );
  const t2 = await runTurn(session, "Now say that in one sentence.", t1.id);
  const r: Record<string, unknown> = {
    session,
    toolTurn: summarise(t1, await allEvents(session, t1.id)),
    followUp: summarise(t2, await allEvents(session, t2.id)),
  };

  if (withSubagents) {
    const t3 = await runTurn(
      session,
      "Use two subagents in parallel: one finds how approvals pause a turn, the other how subagents are created. Then combine their findings in 4 bullets.",
      t2.id,
    );
    r.subagentTurn = summarise(t3, await allEvents(session, t3.id));
  }

  results[model] = r;
  console.log(`== ${model}`);
  console.log(JSON.stringify(r, null, 2), "\n");
}

console.log(`Saved to ${await saveResults(`${import.meta.dir}/../smoke-results`, results)}`);
