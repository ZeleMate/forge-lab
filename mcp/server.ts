// Cartographer's MCP server: `bun run dev` starts it with
// `bun --env-file=mcp/.env mcp/server.ts` from the repo root (#35).
//
// The Source Snapshot and its ts-morph index are built before the listener opens
// (#23: about 0.3 s warm, a few seconds on a cold disk), so no tool call ever
// waits on a half-built index. A missing snapshot stops the server.

import { HOST, PORTS } from "@forge-lab/lib/ports";
import { createApp, ENDPOINTS } from "./src/app";
import { openSourceSnapshot } from "./src/source/snapshot";

const started = performance.now();
const source = openSourceSnapshot();
const files = source.project.getSourceFiles().length;
console.log(`source: ${source.version} @ ${source.sha.slice(0, 7)}, ${files} files indexed`);

const app = createApp({ source });
// Bun closes a connection that sends nothing for `idleTimeout` seconds (10 by
// default). A tool reply is one JSON body at the end, so a slow call (#56's
// wait_turn polls for up to 90 s) needs more; MCP requests time out at 120 s.
Bun.serve({ hostname: HOST, port: PORTS.mcp, fetch: app.fetch, idleTimeout: 120 });

const ms = Math.round(performance.now() - started);
console.log(`listening on http://${HOST}:${PORTS.mcp}/mcp/{${ENDPOINTS.join(",")}} (ready in ${ms} ms)`);
