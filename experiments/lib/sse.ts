// A minimal reader for the Server-Sent Events stream that `POST .../turns`
// returns with `stream: true`. TrueForge sends each event as one SSE message
// whose `id` is the per-Turn sequence number and whose `data` is the event JSON
// (`turnEventSsePayload`, packages/trueforge/src/apis/turns.ts:387@235518c).

export type SseMessage = {
  id: string | undefined;
  event: string | undefined;
  data: string;
};

// Splits a growing text buffer into complete SSE messages. Returns the messages
// and whatever is left over: a message can arrive split across network chunks,
// so the tail waits for the next chunk.
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  // The SSE format allows \r\n, \r or \n line ends; normalise to \n first.
  const text = buffer.replace(/\r\n?/g, "\n");
  const blocks = text.split("\n\n");
  const rest = blocks.pop() ?? ""; // the last block has no blank line after it yet
  const messages: SseMessage[] = [];
  for (const block of blocks) {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue; // a line starting with ":" is a comment (keep-alive)
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      // One optional space after the colon belongs to the syntax, not the value.
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) messages.push({ id, event, data: data.join("\n") });
  }
  return { messages, rest };
}

// Reads a whole SSE response body, calling `onMessage` as each message lands.
// `for await` over an async iterable pulls chunks as the network delivers them.
export async function readSse(body: ReadableStream<Uint8Array>, onMessage: (m: SseMessage) => void): Promise<void> {
  // `stream: true` keeps a multi-byte character that spans two chunks intact.
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const { messages, rest } = parseSse(buffer);
    buffer = rest;
    for (const m of messages) onMessage(m);
  }
  // A stream that ends without the final blank line still delivers its last message.
  const { messages } = parseSse(`${buffer + decoder.decode()}\n\n`);
  for (const m of messages) onMessage(m);
}
