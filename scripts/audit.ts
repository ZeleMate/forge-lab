// `bun audit` with an accept list (#31):
//
//   bun run audit
//
// Fails on any high or critical advisory that isn't accepted below, or whose
// acceptance has passed its review date. Moderate and low ones are counted but
// don't fail: Dependabot alerts cover them. Needs the npm registry (network).

type Severity = "low" | "moderate" | "high" | "critical";
type Advisory = { url: string; title: string; severity: Severity; vulnerable_versions: string };
// What `bun audit --json` prints: package name -> its advisories.
type AuditReport = Record<string, Advisory[]>;

type Accepted = { ghsa: string; pkg: string; reviewBy: string; reason: string };

// All three come in through TrueForge itself (@truefoundry/trueforge's own
// dependencies), so only a TrueForge bump can fix them. (undici is forced to
// 7.30.1 by the root `overrides` instead, which fixed its entry.) Re-check this list on
// every bump, and by `reviewBy` at the latest; after that date the entry stops
// applying and the job fails until someone looks again.
const ACCEPTED: Accepted[] = [
  {
    ghsa: "GHSA-86w9-cpqp-85rv",
    pkg: "node-forge",
    reviewBy: "2027-01-24",
    reason: "sandbox-runtime uses it for its local proxy certificates, not to verify third-party signatures",
  },
  {
    ghsa: "GHSA-27r3-jxmh-p828",
    pkg: "body-parser",
    reviewBy: "2027-01-24",
    reason: "DoS on compressed request bodies; the server listens on 127.0.0.1 only, and only while working",
  },
  {
    ghsa: "GHSA-mrhx-c7xc-m3w5",
    pkg: "zod",
    reviewBy: "2027-01-24",
    reason: "memory exhaustion on oversized input from zod 3.x in the MCP SDK; only loopback clients reach it",
  },
];

const FAILING: ReadonlySet<Severity> = new Set(["high", "critical"]);
const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

function fail(message: string): never {
  console.error(`audit: ${message}`);
  process.exit(1);
}

// `process.execPath` is the Bun binary running this script, so no PATH lookup.
const proc = Bun.spawnSync([process.execPath, "audit", "--json"], { stdout: "pipe", stderr: "pipe" });
// `bun audit` exits 1 whenever it finds anything, so the JSON decides, not the exit code.
let report: AuditReport;
try {
  report = JSON.parse(proc.stdout.toString()) as AuditReport;
} catch {
  fail(`bun audit printed no JSON (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`);
}

// ISO dates compare correctly as strings: "2027-01-24" < "2027-02-01".
const today = new Date().toISOString().slice(0, 10);
const active = new Map(ACCEPTED.filter((a) => a.reviewBy >= today).map((a) => [a.ghsa, a]));
const seen = new Set<string>();
const problems: string[] = [];
let below = 0;

for (const [pkg, advisories] of Object.entries(report)) {
  for (const advisory of advisories) {
    if (!FAILING.has(advisory.severity)) {
      below++;
      continue;
    }
    // `?.[0]` reads the first match only if there was one; `??` falls back to the URL.
    const id = advisory.url.match(GHSA)?.[0] ?? advisory.url;
    seen.add(id);
    if (active.has(id)) continue;
    const expired = ACCEPTED.find((a) => a.ghsa === id);
    const why = expired ? `accepted until ${expired.reviewBy}; re-review it` : "not accepted";
    problems.push(
      `${pkg} ${advisory.vulnerable_versions}: ${advisory.severity} ${id} (${why})\n      ${advisory.title}`,
    );
  }
}

for (const accepted of ACCEPTED) {
  if (!seen.has(accepted.ghsa))
    console.warn(`audit: ${accepted.ghsa} (${accepted.pkg}) is no longer reported; remove it`);
}
console.log(`audit: ${seen.size} high/critical (${active.size} accepted), ${below} moderate/low not gating`);
if (problems.length > 0)
  fail(`${problems.length} unaccepted advisory(ies)\n${problems.map((p) => `  - ${p}`).join("\n")}`);
