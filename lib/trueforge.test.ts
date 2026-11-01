// lib changes made for #55 come with a test (#54). `fetch` is replaced for the
// call, so no TrueForge server is needed.
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { TRUEFORGE_ORIGIN } from "./ports";
import { openInlineExperimentSession } from "./trueforge";

// `spyOn` swaps in a fake that records every call. `mockReset` clears it between
// tests; `mockRestore` puts the real fetch back, since every test file shares one process.
const fetchSpy = spyOn(globalThis, "fetch");
afterEach(() => fetchSpy.mockReset());
afterAll(() => fetchSpy.mockRestore());

test("openInlineExperimentSession posts the spec inline, tagged as an Experiment Session", async () => {
  fetchSpy.mockResolvedValue(Response.json({ data: { id: "sess_1" } }, { status: 201 }));
  const spec = { model: { name: "openrouter/glm-5-3-flash" }, instructions: "x" };

  const id = await openInlineExperimentSession(spec, "smoke-mcp-source");

  expect(id).toBe("sess_1");
  const [url, init] = fetchSpy.mock.calls[0] ?? [];
  expect(url).toBe(`${TRUEFORGE_ORIGIN}/api/v1/sessions`);
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({
    agent: { spec },
    metadata: { experiment: "smoke-mcp-source", depth: "0" },
  });
});

test("an HTTP error throws instead of returning an id", async () => {
  fetchSpy.mockResolvedValue(new Response("bad spec", { status: 400 }));
  await expect(openInlineExperimentSession({}, "x")).rejects.toThrow("HTTP 400");
});
