// Tests for check-release-age.ts, offline: the registry lookup is a stub that
// answers with the real publish times and integrities (taken 2026-11-01).
//
//   bun test scripts/check-release-age.test.ts

import { describe, expect, test } from "bun:test";
import { type AcceptedYoung, checkLock, type Packument } from "./check-release-age";

const WEEK = 604800;

const FORGE_140 = "sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ==";
const FORGE_142 = "sha512-rRtAR5XLJ8gCKd9du4qrKAsgCG1ObGP4gLeNJMa4vYSeq4bmBMOJk5IHkrviBV0q7uoAJlVd8HEQYQSVUb4FGQ==";
const REDIRECTS_1161 =
  "sha512-FNvFGzoMLWmE6Yj9spb/zjd7yiNCHiAW9/Tg9CXrQ8wuu32HtlJOwWO11OJafl5FfY3DxTdQ0vj42zU1kvv5jg==";
const REDIRECTS_1162 =
  "sha512-/kVP2U8z596Ia0gwFrwyIeo74ta5aVmSeU1FfAUMAmcEP5EP7zydmag3SLiN64NaRKef3lxsq7i/g7ltJQDGow==";

// Two of bun.lock's entries as main has them, and as #62 rewrites them. The
// trailing commas are bun.lock's own (JSONC).
function lock(forge: string, redirects: string): string {
  return `{
  "lockfileVersion": 2,
  "packages": {
    "@forge-lab/lib": ["@forge-lab/lib@workspace:lib"],
    "follow-redirects": ["follow-redirects@${redirects}", "", { "peerDependencies": { "debug": "*" } }, "${
      redirects === "1.16.1" ? REDIRECTS_1161 : REDIRECTS_1162
    }"],
    "node-forge": ["node-forge@${forge}", "", {}, "${forge === "1.4.0" ? FORGE_140 : FORGE_142}"],
  },
}`;
}
const MAIN = lock("1.4.0", "1.16.1");
const PR_62 = lock("1.4.2", "1.16.2");

const REGISTRY: Record<string, Packument> = {
  "node-forge": {
    time: { "1.4.2": "2026-10-27T14:09:15.471Z" },
    versions: { "1.4.2": { dist: { integrity: FORGE_142 } } },
  },
  "follow-redirects": {
    time: { "1.16.2": "2026-10-25T21:32:25.963Z" },
    versions: { "1.16.2": { dist: { integrity: REDIRECTS_1162 } } },
  },
};

// Records which names were looked up, so a test can assert "no network".
function stub(): { lookup: (name: string) => Promise<Packument>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    // `async` makes the arrow return a Promise, matching the real fetch-based lookup.
    lookup: async (name) => {
      asked.push(name);
      return REGISTRY[name] ?? {};
    },
  };
}

const FORGE_EXCEPTION: AcceptedYoung = {
  pkg: "node-forge",
  version: "1.4.2",
  integrity: FORGE_142,
  reviewBy: "2026-11-03",
  reason: "reviewed the 1.4.2 tarball",
};

function run(head: string, now: string, accepted: AcceptedYoung[] = [], base = MAIN) {
  const { lookup, asked } = stub();
  return { asked, result: checkLock({ base, head, now: new Date(now), minAgeSeconds: WEEK, accepted, lookup }) };
}

describe("check-release-age", () => {
  test("an unchanged bun.lock passes without any registry lookup", async () => {
    const { result, asked } = run(MAIN, "2026-11-01T12:00:00Z");
    expect((await result).problems).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("#62's node-forge 1.4.2 fails a minute before it clears the age", async () => {
    const { problems } = await run(PR_62, "2026-11-03T14:08:00Z").result;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("node-forge@1.4.2: published 2026-10-27T14:09:15.471Z, 6.9 days old");
    expect(problems[0]).toEndWith("allowed from 2026-11-03T14:09:15.471Z (not accepted)");
  });

  test("#62 passes once node-forge 1.4.2 is 7 days old", async () => {
    const { problems } = await run(PR_62, "2026-11-03T14:10:00Z").result;
    expect(problems).toEqual([]);
  });

  test("on 2026-11-01 both of #62's versions are too young", async () => {
    const { result, asked } = run(PR_62, "2026-11-01T12:00:00Z");
    expect((await result).problems).toHaveLength(2);
    expect(asked.sort()).toEqual(["follow-redirects", "node-forge"]);
  });

  test("an exception for that version and tarball lets it in", async () => {
    const { problems, notes } = await run(PR_62, "2026-11-03T14:08:00Z", [FORGE_EXCEPTION]).result;
    expect(problems).toEqual([]);
    expect(notes[0]).toEndWith("(accepted until 2026-11-03: reviewed the 1.4.2 tarball)");
  });

  test("an exception past its date fails", async () => {
    const expired = { ...FORGE_EXCEPTION, reviewBy: "2026-11-02" };
    const { problems } = await run(PR_62, "2026-11-03T14:08:00Z", [expired]).result;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toEndWith("(accepted until 2026-11-02; expired)");
  });

  test("an exception for another tarball of the same version fails", async () => {
    const other = { ...FORGE_EXCEPTION, integrity: FORGE_140 };
    const { problems } = await run(PR_62, "2026-11-03T14:08:00Z", [other]).result;
    expect(problems[0]).toEndWith("(accepted for a different tarball)");
  });

  test("an exception for another version doesn't cover it", async () => {
    const other = { ...FORGE_EXCEPTION, version: "1.4.1" };
    const { problems } = await run(PR_62, "2026-11-03T14:08:00Z", [other]).result;
    expect(problems[0]).toEndWith("(not accepted)");
  });

  test("an exception no longer needed is reported for removal", async () => {
    const { problems, notes } = await run(PR_62, "2026-11-03T14:10:00Z", [FORGE_EXCEPTION]).result;
    expect(problems).toEqual([]);
    expect(notes).toEqual(["node-forge@1.4.2: old enough now; remove its exception"]);
  });

  test("a lock integrity that differs from the registry's fails", async () => {
    const tampered = PR_62.replace(FORGE_142, FORGE_140);
    const { problems } = await run(tampered, "2026-11-10T00:00:00Z").result;
    expect(problems).toEqual(["node-forge@1.4.2: bun.lock's integrity doesn't match the registry's"]);
  });

  test("a changed integrity under an existing id fails", async () => {
    const tampered = MAIN.replace(FORGE_140, FORGE_142);
    const { problems } = await run(tampered, "2026-11-10T00:00:00Z").result;
    expect(problems).toEqual(["node-forge@1.4.0: integrity changed in bun.lock"]);
  });

  test("a new non-registry entry fails", async () => {
    const git = MAIN.replace(
      `"node-forge": [`,
      `"evil": ["evil@github:someone/evil#abc123", {}, "someone-evil-abc123"],\n    "node-forge": [`,
    );
    const { problems } = await run(git, "2026-11-10T00:00:00Z").result;
    expect(problems).toEqual([
      "evil@github:someone/evil#abc123: not from the npm registry, so its release age can't be checked",
    ]);
  });
});
