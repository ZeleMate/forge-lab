// The background replay's own bookkeeping, run directly against the fake
// TrueForge: what its `replay` tag says when writing that tag goes wrong.
import { expect, test } from "bun:test";
import { replayRunner } from "../src/sessions/replay";
import { fakeClock } from "./helpers";
import { FakeSessionsApi } from "./sessions-fake";

const TAGS = { experiment: "x", depth: "1", origin: "chat:c1", replay: "running" };
const ONE_TURN = [[{ type: "user.message" as const, content: "how does compaction fire?" }]];

test("a Turn's failure is still what the tag records when the first write of it fails", async () => {
  const fake = new FakeSessionsApi();
  fake.addSession("new", { metadata: TAGS, inline: true });
  fake.finishCreatedTurnsAs = "error";
  // Wraps the fake's own method so its first call throws, as an HTTP 503 would.
  const update = fake.updateSession.bind(fake);
  let failures = 1;
  fake.updateSession = async (...args) => {
    if (failures-- > 0) throw new Error("HTTP 503: unavailable");
    return update(...args);
  };

  const replay = replayRunner(fake, fakeClock())("new", TAGS, ONE_TURN);

  // The write's error still surfaces, so the caller hears that something broke.
  await expect(replay).rejects.toThrow("HTTP 503: unavailable");
  expect(fake.session("new").metadata.replay).toBe("failed:turn 1 ended error");
});
