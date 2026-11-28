import { describe, expect, test } from "bun:test";
import { parseSse, readSse, type SseMessage } from "./sse";

describe("parseSse", () => {
  test("splits complete messages and keeps the unfinished tail", () => {
    const { messages, rest } = parseSse('id: 1\ndata: {"a":1}\n\nid: 2\ndata: {"b"');
    expect(messages).toEqual([{ id: "1", event: undefined, data: '{"a":1}' }]);
    expect(rest).toBe('id: 2\ndata: {"b"');
  });

  test("joins multi-line data, skips comments and accepts \\r\\n", () => {
    const { messages } = parseSse(": keep-alive\r\n\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\n");
    expect(messages).toEqual([{ id: undefined, event: "x", data: "a\nb" }]);
  });
});

describe("readSse", () => {
  test("reassembles messages and characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('id: 1\ndata: "é"\n\nid: 2\ndata: "z"');
    // Cut inside the two-byte "é" and inside the second message.
    const cuts = [0, 14, 20, bytes.length];
    // A ReadableStream built by hand stands in for a network response body.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 1; i < cuts.length; i++) controller.enqueue(bytes.slice(cuts[i - 1], cuts[i]));
        controller.close();
      },
    });
    const got: SseMessage[] = [];
    await readSse(body, (m) => got.push(m));
    expect(got.map((m) => [m.id, m.data])).toEqual([
      ["1", '"é"'],
      ["2", '"z"'],
    ]);
  });
});
