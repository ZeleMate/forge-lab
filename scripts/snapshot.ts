// The Source Snapshot lifecycle (#32, #34): a pinned, read-only copy of
// TrueForge's source for Cartographer to read.
//
//   bun run snapshot             ensure: fetch and generate the pinned snapshot if it's missing
//   bun run snapshot:pin         write snapshot.json for the installed TrueForge (only when bumping it)
//   bun run snapshot:pin -- --sha <commit>    pin by hand when there is no attestation
//   bun scripts/snapshot.ts check-pin       snapshot.json's version = harness/package.json's pin (#30's hook)
//   bun scripts/snapshot.ts check-server    snapshot.json's version = the running server's /healthz
//
// The snapshot is untrusted data. It is fetched outside the repo, its
// dependencies are never installed, and none of its code runs: the 7 `*.gen.ts`
// files its 3 generator scripts would write are written by `generate` below instead.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// `parseArgs` is Node's built-in command-line parser; Bun ships it too.
import { parseArgs } from "node:util";
import {
  cacheRoot,
  checkServerVersion,
  harnessPinVersion,
  isComplete,
  isSha,
  MANIFEST_NAME,
  PACKAGE,
  PIN_FILE,
  REPO_ROOT,
  readManifest,
  readPin,
  type SnapshotManifest,
  type SnapshotPin,
  snapshotDir,
} from "@forge-lab/lib/snapshot";

const DEFAULT_REPO = "https://github.com/truefoundry/trueforge";
const GITHUB_REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
const SLSA_V1 = "https://slsa.dev/provenance/v1";

// Spawn tools by absolute path, never by a name looked up in whatever PATH is set.
const GIT = "/usr/bin/git";
const CHMOD = "/bin/chmod";

function fail(message: string): never {
  // `never` as a return type tells the compiler this function doesn't return,
  // so code after `fail(...)` knows the failing case is gone.
  console.error(`snapshot: ${message}`);
  process.exit(1);
}

// Runs a tool with a small, explicit environment and returns its trimmed stdout.
function run(cmd: string[], cwd?: string): string {
  const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0" };
  const proc = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) fail(`${cmd.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

// Git, with the fetched repository's hooks and fsmonitor switched off.
function git(dir: string, ...args: string[]): string {
  return run([GIT, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", dir, ...args]);
}

// ---------- pin ----------

// bun.lock records the tarball's integrity as `sha512-<base64>`; the attestation
// gives the same digest as hex.
function lockfileDigest(version: string): string {
  // bun.lock is JSON with trailing commas, which `JSON.parse` rejects; Bun.JSONC accepts it.
  const lock = Bun.JSONC.parse(readFileSync(join(REPO_ROOT, "bun.lock"), "utf8")) as {
    packages: Record<string, unknown[]>;
  };
  const entry = lock.packages[PACKAGE];
  // A lockfile package entry is a tuple: [id, registry, metadata, integrity].
  const [id, , , integrity] = entry ?? [];
  if (id !== `${PACKAGE}@${version}`) fail(`bun.lock has ${String(id)}, not ${PACKAGE}@${version}`);
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) fail(`bun.lock has no sha512 for ${id}`);
  return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
}

function installedVersion(): string {
  const file = join(REPO_ROOT, "harness/node_modules", PACKAGE, "package.json");
  if (!existsSync(file)) fail(`${PACKAGE} is not installed; run \`bun install\` at the repo root`);
  const { version } = JSON.parse(readFileSync(file, "utf8")) as { version: string };
  const pinned = harnessPinVersion();
  if (version !== pinned) fail(`installed ${PACKAGE} is ${version} but harness/package.json pins ${pinned}`);
  return version;
}

// Only the parts of an in-toto statement (the decoded DSSE payload) we read.
type Statement = {
  subject: { name: string; digest: { sha512?: string } }[];
  predicate?: {
    buildDefinition?: {
      externalParameters?: { workflow?: { repository?: string } };
      resolvedDependencies?: { uri?: string; digest?: { gitCommit?: string } }[];
    };
  };
};

async function attestedBuild(version: string): Promise<{ sha: string; repo: string; subjectDigest: string }> {
  // `encodeURIComponent` turns the scope's `/` into `%2F`, as the registry expects.
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(PACKAGE)}@${version}`;
  const res = await fetch(url);
  if (res.status === 404) fail(`no attestation for ${PACKAGE}@${version}; pin by hand with --sha <commit>`);
  if (!res.ok) fail(`GET ${url} -> HTTP ${res.status}`);
  const body = (await res.json()) as {
    attestations: { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }[];
  };
  const slsa = body.attestations.find((a) => a.predicateType === SLSA_V1);
  if (!slsa) fail(`${url} has no ${SLSA_V1} attestation`);
  // The payload is base64 JSON. Its signature is not checked (#32: no Sigstore);
  // the cross-check against bun.lock is what ties it to the tarball we run.
  const statement = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, "base64").toString("utf8")) as Statement;

  const subjectName = `pkg:npm/${encodeURIComponent("@")}${PACKAGE.slice(1)}@${version}`;
  const subjectDigest = statement.subject.find((s) => s.name === subjectName)?.digest.sha512;
  if (!subjectDigest) fail(`the attestation has no sha512 subject ${subjectName}`);
  const locked = lockfileDigest(version);
  if (subjectDigest !== locked) {
    fail(`attested sha512 ${subjectDigest.slice(0, 16)}… != bun.lock's ${locked.slice(0, 16)}…; refusing to pin`);
  }

  const build = statement.predicate?.buildDefinition;
  const sha = build?.resolvedDependencies?.[0]?.digest?.gitCommit ?? "";
  const repo = build?.externalParameters?.workflow?.repository ?? "";
  if (!isSha(sha)) fail(`the attestation names no git commit (got "${sha}")`);
  if (!GITHUB_REPO.test(repo)) fail(`the attestation's repository "${repo}" is not a GitHub https URL`);
  return { sha, repo, subjectDigest };
}

// The `v<version>` tag, which upstream moves past the attested commit (source-snapshot.md).
function tagSha(repo: string, version: string): string | null {
  const tag = `refs/tags/v${version}`;
  const lines = run([GIT, "ls-remote", repo, tag, `${tag}^{}`])
    .split("\n")
    .filter(Boolean);
  // An annotated tag lists twice; the `^{}` line is the commit it points at.
  const line = lines.find((l) => l.endsWith("^{}")) ?? lines[0];
  return line?.split("\t")[0] ?? null;
}

async function pin(shaOverride: string | undefined): Promise<void> {
  const version = installedVersion();
  let pinned: SnapshotPin;
  if (shaOverride) {
    if (!isSha(shaOverride)) fail(`--sha must be a full 40-character commit, got ${shaOverride}`);
    console.warn(`snapshot: pinning ${version} to ${shaOverride} by hand; no attestation was checked`);
    pinned = {
      version,
      sha: shaOverride,
      tagSha: tagSha(DEFAULT_REPO, version),
      repo: DEFAULT_REPO,
      subjectDigest: null,
    };
  } else {
    const { sha, repo, subjectDigest } = await attestedBuild(version);
    pinned = { version, sha, tagSha: tagSha(repo, version), repo, subjectDigest };
  }
  writeFileSync(PIN_FILE, `${JSON.stringify(pinned, null, 2)}\n`);
  console.log(`snapshot: pinned ${PACKAGE}@${version} to ${pinned.sha} (tag v${version} = ${pinned.tagSha ?? "none"})`);
}

// ---------- generate ----------

// Our own rewrite of upstream's 3 `build:gen` scripts at 198a2ead. Each reads
// files from the snapshot and wraps their text in a `JSON.stringify` string
// constant; the output matches theirs byte for byte, header line included.
type GenFile = { out: string; script: string; body: (read: (path: string) => string) => string };

const CATALOGS = [
  ["model-catalog.yaml", "shippedModelCatalogYaml", "modelCatalog.gen.ts"],
  ["mcp-catalog.yaml", "shippedMcpCatalogYaml", "mcpCatalog.gen.ts"],
  ["skill-catalog.yaml", "shippedSkillCatalogYaml", "skillCatalog.gen.ts"],
  ["sandbox-catalog.yaml", "shippedSandboxCatalogYaml", "sandboxCatalog.gen.ts"],
  ["web-search-catalog.yaml", "shippedWebSearchCatalogYaml", "webSearchCatalog.gen.ts"],
] as const;

const S = JSON.stringify; // short alias: the generated files are mostly `S(read(...))`

const GEN_FILES: GenFile[] = [
  // packages/trueforge-core/scripts/generate-sandbox-scripts.mjs
  {
    out: "packages/trueforge-core/src/core/sandbox/sandboxScripts.gen.ts",
    script: "generate-sandbox-scripts.mjs",
    body: (read) => {
      const dir = "packages/trueforge-core/src/core/sandbox/scripts";
      return `export const sandboxScripts = {
  mcpClient: ${S(read(`${dir}/mcp_client.py`))},
  skillDownloader: ${S(read(`${dir}/skill_downloader.py`))},
} as const;
`;
    },
  },
  // packages/trueforge/scripts/generate-local-sandbox-scripts.mjs
  {
    out: "packages/trueforge/src/sandbox/local/sandboxScripts.gen.ts",
    script: "generate-local-sandbox-scripts.mjs",
    body: (read) => `export const sandboxScripts = {
  mcpClientLocal: ${S(read("packages/trueforge/src/sandbox/local/scripts/mcp_client_local.py"))},
} as const;
`,
  },
  // packages/trueforge/scripts/generate-catalog.mjs: one file per catalog YAML
  ...CATALOGS.map(([yaml, exportName, outName]) => ({
    out: `packages/trueforge/src/catalog/${outName}`,
    script: "generate-catalog.mjs",
    body: (read: (path: string) => string) =>
      `export const ${exportName} = ${S(read(`packages/trueforge/catalog/${yaml}`))} as const;\n`,
  })),
];

function generate(dir: string): string[] {
  const read = (path: string) => readFileSync(join(dir, path), "utf8");
  for (const file of GEN_FILES) {
    const header = `// AUTO-GENERATED by scripts/${file.script} — do not edit.\n`;
    writeFileSync(join(dir, file.out), header + file.body(read));
  }
  return GEN_FILES.map((f) => f.out);
}

// ---------- ensure ----------

// A read-only tree can't be deleted until it's writable again.
function remove(dir: string): void {
  run([CHMOD, "-R", "u+w", dir]);
  rmSync(dir, { recursive: true, force: true });
}

function ensure(): void {
  const pinned = readPin();
  const dir = snapshotDir(pinned.sha);
  if (isComplete(readManifest(dir), pinned)) {
    console.log(`snapshot: ${pinned.version} (${pinned.sha.slice(0, 8)}) is ready at ${dir}`);
    return;
  }
  if (existsSync(dir)) {
    console.log(`snapshot: ${dir} is incomplete; fetching it again`);
    remove(dir);
  }

  // Fetch into a side folder and rename it into place at the end, so `<sha>/`
  // only ever exists complete. `{ recursive: true }` also makes the parents.
  const root = cacheRoot();
  mkdirSync(root, { recursive: true });
  const partial = `${dir}.partial`;
  if (existsSync(partial)) remove(partial);
  mkdirSync(partial);

  const started = performance.now();
  console.log(`snapshot: fetching ${pinned.repo} at ${pinned.sha} into ${partial}`);
  git(partial, "init", "--quiet");
  git(partial, "remote", "add", "origin", pinned.repo);
  git(partial, "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", pinned.sha);
  git(partial, "-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD");
  const head = git(partial, "rev-parse", "HEAD");
  if (head !== pinned.sha) fail(`fetched HEAD is ${head}, expected ${pinned.sha}`);

  const generated = generate(partial);
  // `satisfies` checks the object against the type without widening it.
  const manifest = { ...pinned, fetchedAt: new Date().toISOString(), generated } satisfies SnapshotManifest;
  writeFileSync(join(partial, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  run([CHMOD, "-R", "a-w", partial]);
  // The rename needs write access to `root`, not to the read-only tree itself.
  renameSync(partial, dir);
  console.log(`snapshot: ${pinned.version} ready at ${dir} (${Math.round(performance.now() - started)} ms)`);

  // Only after a successful fetch: drop every other snapshot (#32).
  for (const name of readdirSync(root)) {
    const sha = name.replace(/\.partial$/, "");
    if (isSha(sha) && name !== pinned.sha) {
      console.log(`snapshot: removing old snapshot ${name}`);
      remove(join(root, name));
    }
  }
}

// ---------- checks ----------

function checkPin(): void {
  const [pinned, harness] = [readPin().version, harnessPinVersion()];
  if (pinned !== harness)
    fail(`snapshot.json pins ${pinned} but harness/package.json pins ${harness}; run \`bun run snapshot:pin\``);
  console.log(`snapshot: snapshot.json and harness/package.json both pin ${pinned}`);
}

async function checkServer(): Promise<void> {
  const { ok, server, pinned } = await checkServerVersion();
  if (!ok) fail(`the server on /healthz is ${server}, but snapshot.json pins ${pinned}; refusing`);
  console.log(`snapshot: the server and snapshot.json are both ${pinned}`);
}

// ---------- main ----------

const { positionals, values } = parseArgs({
  args: process.argv.slice(2), // argv[0] is bun, argv[1] this file
  options: { sha: { type: "string" } },
  allowPositionals: true,
});

switch (positionals[0] ?? "ensure") {
  case "ensure":
    ensure();
    break;
  case "pin":
    await pin(values.sha); // top-level `await` works in ES modules
    break;
  case "check-pin":
    checkPin();
    break;
  case "check-server":
    await checkServer();
    break;
  default:
    fail(`unknown command ${positionals[0]}; use ensure, pin, check-pin or check-server`);
}
