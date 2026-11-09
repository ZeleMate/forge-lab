// Works around a TrueForge UI bug: in SingleAgent mode it filters the Chat History with
// `agent_id=<the agent's name>`, but the server matches ids, so the list is always empty
// (ShellModeContext.tsx sets `agentId: config.name`). The SDK takes a custom `fetch`, so
// this corrects that one query. Delete it once an upstream release fixes the filter.

const SESSIONS_PATH = "/api/v1/sessions";
// Only used to split a relative URL; it never reaches the output.
const PARSE_BASE = "http://relative.invalid";

// Just the call signature: Bun's global types add a `preconnect` member to `typeof fetch`.
export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function historyFetch(
  agentName: string,
  findAgentId: (name: string) => Promise<string | undefined>,
  // A default parameter, read at call time: `fetch` must be called unbound in the browser.
  inner: Fetch = (input, init) => fetch(input, init),
): Fetch {
  // Remembers the lookup itself, so concurrent lists share it. Cleared if it fails.
  let agentId: Promise<string | undefined> | undefined;

  const resolveId = async () => {
    agentId ??= findAgentId(agentName);
    try {
      return await agentId;
    } catch {
      agentId = undefined;
      return undefined; // history stays empty this time; the chat itself is unaffected
    }
  };

  return async (input, init) => {
    // A `Request` object carries its own body, so it passes through; the SDK sends URLs.
    if (input instanceof Request) return inner(input, init);
    const original = String(input);
    const url = new URL(original, PARSE_BASE);
    if (url.pathname !== SESSIONS_PATH || url.searchParams.get("agent_id") !== agentName) return inner(input, init);

    const id = await resolveId();
    if (!id) return inner(input, init);
    url.searchParams.set("agent_id", id);
    // A relative URL stays relative, so the request still goes through Vite's proxy.
    const fixed = original.startsWith("/") ? `${url.pathname}${url.search}` : url.href;
    return inner(fixed, init);
  };
}
