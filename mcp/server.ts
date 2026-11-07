// Cartographer's MCP server: `bun run dev` starts it with
// `bun --env-file=mcp/.env mcp/server.ts` from the repo root (#35).
//
// The Source Snapshot and its ts-morph index are built before the listener opens
// (#23: about 0.3 s warm, a few seconds on a cold disk), so no tool call ever
// waits on a half-built index. A missing snapshot or ripgrep stops the server.

import { homedir } from "node:os";
import { join } from "node:path";
import { HOST, PORTS, TRUEFORGE_ORIGIN } from "@forge-lab/lib/ports";
import { createApp, ENDPOINTS } from "./src/app";
import { systemClock } from "./src/clock";
import { sdkSessionsApi } from "./src/sessions/api";
import { RG } from "./src/source/ripgrep";
import { openSourceSnapshot } from "./src/source/snapshot";
import { Budget } from "./src/triage/budget";
import { decideFromEnv } from "./src/triage/decide";

const started = performance.now();
if (!RG) throw new Error("ripgrep (rg) isn't on PATH; install it with `brew install ripgrep`");
const source = openSourceSnapshot();
const files = source.project.getSourceFiles().length;
console.log(`source: ${source.version} @ ${source.sha.slice(0, 7)}, ${files} files indexed`);

// #8's cap. The counter sits next to the Source Snapshot cache, outside the repo.
const TRIAGE_BUDGET_USD = 0.5;
const budget = new Budget({
  file: join(homedir(), "Library/Caches/forge-lab/triage-budget.json"),
  capUsd: TRIAGE_BUDGET_USD,
  clock: systemClock,
});
const decide = decideFromEnv(process.env);
// Which backend runs, never the key itself.
console.log(`triage: ${decide?.backend ?? "no backend (set OPENAI_API_KEY in mcp/.env)"}, $${TRIAGE_BUDGET_USD}/day`);

const app = createApp({
  source,
  sessions: { api: sdkSessionsApi(TRUEFORGE_ORIGIN), clock: systemClock },
  triage: { decide, budget },
});
// Bun closes a connection that sends nothing for `idleTimeout` seconds (10 by
// default). A tool reply is one JSON body at the end, so a slow call (#56's
// wait_turn polls for up to 90 s) needs more; MCP requests time out at 120 s.
Bun.serve({ hostname: HOST, port: PORTS.mcp, fetch: app.fetch, idleTimeout: 120 });

const ms = Math.round(performance.now() - started);
console.log(`listening on http://${HOST}:${PORTS.mcp}/mcp/{${ENDPOINTS.join(",")}} (ready in ${ms} ms)`);
