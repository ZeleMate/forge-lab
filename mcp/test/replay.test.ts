// The background replay's own bookkeeping, run directly against the fake
// TrueForge: what its `replay` tag says when writing that tag goes wrong.
import { expect, test } from "bun:test";
import { replayRunner } from "../src/sessions/replay";
import { fakeClock } from "./helpers";
import { FakeSessionsApi } from "./sessions-fake";

const TAGS = { experiment: "x", depth: "1", origin: "chat:c1", replay: "running" };
const ONE_TURN = [[{ type: "user.message" as const, content: "how does compaction fire?" }]];

// A fake whose replayed Turn ends in error, and whose first `failingWrites`
// `updateSession` calls throw, the way an HTTP 503 would. `attempts` is the
// `replay` tag each call tried to write, thrown or not (the fake's own call
// log only sees the calls that get through).
function failingFake(failingWrites: number) {
  const fake = new FakeSessionsApi();
  fake.addSession("new", { metadata: TAGS, inline: true });
  fake.finishCreatedTurnsAs = "error";
  const attempts: (string | undefined)[] = [];
  // `bind` keeps `this` pointing at the fake when the wrapper calls the original.
  const update = fake.updateSession.bind(fake);
  let failures = failingWrites;
  fake.updateSession = async (sessionId, body) => {
    attempts.push(body.metadata?.replay);
    if (failures-- > 0) throw new Error(`HTTP 503: unavailable (${failingWrites - failures})`);
    return update(sessionId, body);
  };
  return { fake, attempts };
}

test("a Turn's failure is still what the tag records when the first write of it fails", async () => {
  const { fake } = failingFake(1);

  const replay = replayRunner(fake, fakeClock())("new", TAGS, ONE_TURN);

  // The write's error still surfaces, so the caller hears that something broke.
  await expect(replay).rejects.toThrow("HTTP 503: unavailable (1)");
  expect(fake.session("new").metadata.replay).toBe("failed:turn 1 ended error");
});

test("when the retry fails too, the first write's error surfaces and the tag is left alone", async () => {
  const { fake, attempts } = failingFake(2);

  const replay = replayRunner(fake, fakeClock())("new", TAGS, ONE_TURN);

  // The retry's error is swallowed: the one rethrown is the error that started it.
  await expect(replay).rejects.toThrow("HTTP 503: unavailable (1)");
  // Both attempts carried the Turn's reason, never an HTTP error's message.
  expect(attempts).toEqual(["failed:turn 1 ended error", "failed:turn 1 ended error"]);
  expect(fake.session("new").metadata.replay).toBe("running");
});
