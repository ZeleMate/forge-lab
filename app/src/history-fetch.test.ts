import { describe, expect, mock, test } from "bun:test";
import { historyFetch } from "./history-fetch";

const AGENT_ID = "01m5qgk696xctxwj523gp5jygj";
const LIST = "http://127.0.0.1:5173/api/v1/sessions?limit=20&agent_id=cartographer&created_by_me=true";

function setup(findAgentId: (name: string) => Promise<string | undefined> = async () => AGENT_ID) {
  const inner = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));
  const find = mock(findAgentId);
  return { inner, find, fetcher: historyFetch("cartographer", find, inner) };
}

const sentUrl = (inner: ReturnType<typeof setup>["inner"]) => String(inner.mock.calls[0]?.[0]);

describe("historyFetch", () => {
  test("swaps the agent's name for its id in the Session list filter, keeping the rest", async () => {
    const { fetcher, inner } = setup();
    await fetcher(LIST);
    expect(sentUrl(inner)).toBe(
      `http://127.0.0.1:5173/api/v1/sessions?limit=20&agent_id=${AGENT_ID}&created_by_me=true`,
    );
  });

  test("looks the id up once, not on every list", async () => {
    const { fetcher, find } = setup();
    await fetcher(LIST);
    await fetcher(LIST);
    expect(find).toHaveBeenCalledTimes(1);
  });

  test("a failed lookup is retried next time, and the request still goes out", async () => {
    let attempts = 0;
    const { fetcher, inner } = setup(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("server down");
      return AGENT_ID;
    });
    await fetcher(LIST);
    expect(sentUrl(inner)).toBe(LIST);
    await fetcher(LIST);
    expect(String(inner.mock.calls[1]?.[0])).toContain(`agent_id=${AGENT_ID}`);
  });

  test.each([
    "http://127.0.0.1:5173/api/v1/sessions/abc/turns?limit=25",
    "http://127.0.0.1:5173/api/v1/sessions?limit=20",
    `http://127.0.0.1:5173/api/v1/sessions?agent_id=${AGENT_ID}`,
    "http://127.0.0.1:5173/api/v1/sessions?agent_id=other",
    "http://127.0.0.1:5173/api/v1/agents?agent_id=cartographer",
  ])("leaves %s alone, without a lookup", async (url) => {
    const { fetcher, inner, find } = setup();
    await fetcher(url);
    expect(sentUrl(inner)).toBe(url);
    expect(find).not.toHaveBeenCalled();
  });

  test("passes init through, so a write's method and body survive", async () => {
    const { fetcher, inner } = setup();
    const init = { method: "POST", body: "{}" };
    await fetcher("http://127.0.0.1:5173/api/v1/sessions", init);
    expect(inner.mock.calls[0]?.[1]).toBe(init);
  });

  test("handles a URL object and a relative path", async () => {
    const { fetcher, inner } = setup();
    await fetcher(new URL(LIST));
    expect(sentUrl(inner)).toContain(`agent_id=${AGENT_ID}`);
    await fetcher("/api/v1/sessions?agent_id=cartographer");
    expect(String(inner.mock.calls[1]?.[0])).toBe(`/api/v1/sessions?agent_id=${AGENT_ID}`);
  });
});
