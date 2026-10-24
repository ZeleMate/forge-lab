// `bun run dev`: the whole local stack in one visible terminal tab (#32, #35).
//
//   snapshot ensure  ∥  TrueForge (8790)
//   -> /healthz answers (30 s) -> its version must equal snapshot.json's
//   -> MCP server (8791) -> apply the MCP servers and Agent -> Vite (5173) -> URLs
//
// Children that don't exist yet are skipped (`mcp/`, `app/`), so this runs with
// TrueForge and the snapshot alone. Each child gets an allowlisted env: PATH,
// HOME and its own variables, never this process's env. Ctrl-C stops the
// children in reverse order (SIGINT, then SIGKILL after 5 s); if any child exits
// on its own, everything stops. Everything binds to 127.0.0.1.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOST, PORTS, TRUEFORGE_ORIGIN } from "@forge-lab/lib/ports";
import { checkServerVersion, REPO_ROOT } from "@forge-lab/lib/snapshot";
import { serverVersion } from "@forge-lab/lib/trueforge";
import { apply } from "./apply";

const BUN = process.execPath; // the bun binary running this script
const STOP_GRACE_MS = 5_000;

// The base of every child's env. TrueForge never sees the MCP server's key:
// only the MCP child reads mcp/.env, and dev.ts itself never loads it.
const baseEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" };

// Repeats harness/package.json's `start` (a package.json script can't import
// TypeScript); keep the two in sync. The port comes from PORTS.
const trueforgeEnv = {
  HOST,
  PORT: String(PORTS.trueforge),
  DO_NOT_TRACK: "1",
  SENTRY_ENABLED: "false",
  OUTBOUND_URL_ALLOWED_HOSTS: JSON.stringify([HOST]), // lets TrueForge reach our MCP server on loopback
};

// ---------- children ----------

type Child = { name: string; proc: Bun.Subprocess; expectExit: boolean };
const children: Child[] = [];
let stopping = false;

// Prefixes every line of a child's output, e.g. `[tf] listening`.
async function prefixLines(stream: ReadableStream<Uint8Array>, prefix: string, out: NodeJS.WriteStream) {
  let rest = "";
  // `stream: true` keeps a multi-byte character split across two chunks intact.
  const decoder = new TextDecoder();
  // `for await` reads a stream chunk by chunk, waiting for each one.
  for await (const chunk of stream) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? ""; // the last piece has no newline yet; keep it for the next chunk
    for (const line of lines) out.write(`${prefix} ${line}\n`);
  }
  if (rest) out.write(`${prefix} ${rest}\n`);
}

// `expectExit`: a one-shot task (the snapshot fetch), not a server, so its exit
// is awaited by the caller instead of stopping the stack.
function start(name: string, cmd: string[], opts: { cwd: string; env: Record<string, string>; expectExit?: boolean }) {
  const prefix = `[${name}]`;
  console.log(`${prefix} $ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Its own process group: the terminal's Ctrl-C reaches only dev.ts, which
    // then stops the children in reverse order itself.
    detached: true,
  });
  // `void` marks a promise we deliberately don't await.
  void prefixLines(proc.stdout, prefix, process.stdout);
  void prefixLines(proc.stderr, prefix, process.stderr);
  const child: Child = { name, proc, expectExit: opts.expectExit ?? false };
  children.push(child);
  void proc.exited.then((code) => {
    if (stopping || child.expectExit) return;
    console.error(`${prefix} exited on its own (code ${code}); stopping everything`);
    void shutdown(1);
  });
  return proc;
}

async function stopChild({ name, proc }: Child) {
  if (proc.exitCode !== null || proc.signalCode !== null) return; // already gone
  proc.kill("SIGINT");
  const timeout = Bun.sleep(STOP_GRACE_MS).then(() => "timeout" as const);
  if ((await Promise.race([proc.exited, timeout])) === "timeout") {
    console.error(`[${name}] still running after ${STOP_GRACE_MS / 1000} s; sending SIGKILL`);
    proc.kill("SIGKILL");
    await proc.exited;
  }
  console.log(`[${name}] stopped`);
}

// Reverse start order: the app first, TrueForge last. Later calls get the same
// promise: Ctrl-C under `bun run dev` arrives twice (the terminal signals the
// whole foreground group, and `bun run` forwards it too), and exiting on the
// second one would SIGKILL the children mid-shutdown.
let stopped: Promise<never> | undefined;
function shutdown(code: number): Promise<never> {
  // `??=` assigns only when `stopped` is still undefined.
  stopped ??= (async () => {
    stopping = true;
    for (const child of [...children].reverse()) await stopChild(child);
    process.exit(code);
  })();
  return stopped;
}

function fail(message: string): Promise<never> {
  console.error(`dev: ${message}`);
  return shutdown(1);
}

process.on("SIGINT", () => {
  if (!stopping) console.log("\ndev: Ctrl-C, stopping");
  void shutdown(0);
});
process.on("SIGTERM", () => void shutdown(0));
// Last resort if dev.ts dies some other way: detached children would outlive it.
process.on("exit", () => {
  for (const { proc } of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
});

// ---------- waiting ----------

async function portOpen(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: HOST, port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

// Polls `ready` every 250 ms until it's true; false once `timeoutMs` has passed.
async function waitFor(ready: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopping) return false;
    if (await ready()) return true;
    await Bun.sleep(250);
  }
  return false;
}

// ---------- the stack ----------

// Refuse before starting anything if one of our ports is taken, e.g. by a
// TrueForge started some other way (or of another version).
async function checkPortsFree(withMcp: boolean, withApp: boolean) {
  if (await portOpen(PORTS.trueforge)) {
    const { server, pinned } = await checkServerVersion();
    const what = server === "unreachable" ? "something that isn't TrueForge" : `TrueForge ${server}`;
    const note = server === pinned ? "" : ` (snapshot.json pins ${pinned})`;
    return fail(`port ${PORTS.trueforge} is taken by ${what}${note}. Stop it first; dev starts its own.`);
  }
  if (withMcp && (await portOpen(PORTS.mcp))) return fail(`port ${PORTS.mcp} (MCP server) is already taken`);
  if (withApp && (await portOpen(PORTS.vite))) return fail(`port ${PORTS.vite} (Vite) is already taken`);
}

const mcpEntry = join(REPO_ROOT, "mcp/server.ts");
const appDir = join(REPO_ROOT, "app");
const withMcp = existsSync(mcpEntry);
const withApp = existsSync(join(appDir, "package.json"));

await checkPortsFree(withMcp, withApp);

// 1. The snapshot fetch and TrueForge, in parallel. The snapshot runs as a
// child, not an import: `ensure()` calls process.exit(1) on failure.
const snapshotEnv: Record<string, string> = { ...baseEnv };
if (process.env.SOURCE_SNAPSHOT_DIR) snapshotEnv.SOURCE_SNAPSHOT_DIR = process.env.SOURCE_SNAPSHOT_DIR;
const snapshot = start("snap", [BUN, "scripts/snapshot.ts", "ensure"], {
  cwd: REPO_ROOT,
  env: snapshotEnv,
  expectExit: true,
});
start("tf", ["node_modules/.bin/trueforge"], { cwd: join(REPO_ROOT, "harness"), env: { ...baseEnv, ...trueforgeEnv } });

// 2. /healthz, then the version check against the pin.
if (!(await waitFor(async () => (await serverVersion()) !== "unreachable", 30_000))) {
  await fail(`TrueForge didn't answer ${TRUEFORGE_ORIGIN}/healthz within 30 s`);
}
const version = await checkServerVersion();
if (!version.ok) await fail(`TrueForge reports ${version.server}, but snapshot.json pins ${version.pinned}`);
console.log(`dev: TrueForge ${version.server} is up and matches the pin`);

// The MCP server reads the snapshot, so it has to be complete first.
const snapshotCode = await snapshot.exited;
if (snapshotCode !== 0) await fail(`the Source Snapshot fetch failed (exit ${snapshotCode})`);

// 3. The MCP server, started from the repo root so no folder's .env loads
// implicitly; mcp/.env is its only way in.
if (withMcp) {
  start("mcp", [BUN, "--env-file=mcp/.env", mcpEntry], { cwd: REPO_ROOT, env: baseEnv });
  if (!(await waitFor(() => portOpen(PORTS.mcp), 60_000))) await fail(`the MCP server didn't open port ${PORTS.mcp}`);
} else {
  console.log("dev: no mcp/server.ts yet, skipping the MCP server");
}

// 4. Register the MCP servers and the Agent (the repo wins).
try {
  await apply();
} catch (error) {
  await fail(`apply failed: ${error instanceof Error ? error.message : String(error)}`);
}

// 5. Vite, on Node (its default), with `strictPort` so it fails instead of moving.
if (withApp) {
  const vite = ["node_modules/.bin/vite", "--host", HOST, "--port", String(PORTS.vite), "--strictPort"];
  start("app", vite, { cwd: appDir, env: baseEnv });
  if (!(await waitFor(() => portOpen(PORTS.vite), 30_000))) await fail(`Vite didn't open port ${PORTS.vite}`);
} else {
  console.log("dev: no app/ yet, skipping Vite");
}

console.log("\ndev: the stack is up. Ctrl-C stops it.");
console.log(`  TrueForge  ${TRUEFORGE_ORIGIN}`);
if (withMcp) console.log(`  MCP        http://${HOST}:${PORTS.mcp}/mcp/{source,sessions,triage}`);
if (withApp) console.log(`  App        http://${HOST}:${PORTS.vite}`);
