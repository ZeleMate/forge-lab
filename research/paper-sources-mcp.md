# Paper sources and MCP servers for the Paper Scout

Resolves forge-lab#5. Researched 2026-10-18 from primary sources (official docs, SDK repo, TrueForge docs and shipped catalog, live requests to the APIs).

## Summary

- Use **arXiv API** (no auth, 1 request per 3 s) for discovery and **Hugging Face Papers** (no auth, rate limited per IP) for "trending/daily" signal. **Semantic Scholar** is useful for enrichment (abstract, TLDR, citations) but its unauthenticated pool is shared and returned HTTP 429 on our first request, so treat a free API key (1 RPS) as required.
- **TrueForge's shipped MCP catalog has no paper/arXiv/Scholar server.** It has generic web search (exa, tavily, parallel-web, you, bright-data) and deepwiki. The HF MCP server is not in the catalog but can be added via **Add MCP Server** (anonymous works).
- Our own server must serve **Streamable HTTP** (the spec's only HTTP transport; HTTP+SSE is deprecated). TrueForge accepts both `streamable-http` and `sse`.
- The official TS SDK is now **v2** (`@modelcontextprotocol/server` 2.3.1, 2026-10-05), explicitly supports Bun, and mounts on Bun with `export default handler`. v1 (`@modelcontextprotocol/sdk` 1.32.1) is in maintenance.

## (a) Paper sources

| Source | Auth | Rate limit | Notes |
|---|---|---|---|
| arXiv API `export.arxiv.org/api/query` | none | max 1 request / 3 s, single connection, across all your machines ([ToU](https://info.arxiv.org/help/api/tou.html)) | Atom XML. Params `search_query`, `id_list`, `start`, `max_results` (slices of at most 2000, total cap 30000), `sortBy` (`relevance`, `lastUpdatedDate`, `submittedDate`). Results change at most daily; manual advises caching and not repeating a query more than once a day ([user manual](https://info.arxiv.org/help/api/user-manual.html)). Must not imply arXiv endorsement. Live check: 200. |
| Hugging Face Hub API (papers) | none for reads; `HF_TOKEN` raises limits | Hub API bucket, 5-minute fixed windows: anonymous 500 / IP, free user 1,000, PRO 2,500 ([rate limits](https://huggingface.co/docs/hub/en/rate-limits)) | Live check (unauthenticated, 200): `GET /api/papers/search?q=...&limit=n` and `GET /api/daily_papers?limit=n` return JSON. These routes are undocumented in the docs page we could read (Hub docs defer to the OpenAPI spec at `huggingface.co/.well-known/openapi.md`, whose paper-search section we did not reach); treat the shape as unstable. |
| Semantic Scholar Academic Graph API | optional key | unauthenticated: 1000 req/s shared by all anonymous users, with extra throttling in spikes; key: introductory 1 RPS on all endpoints ([product page](https://www.semanticscholar.org/product/api)) | Key is requested via a form and emailed. Live check: first unauthenticated request got 429 with a message pointing to the key form. Requesting a key is a signup, so left to the user. |

Not verified in this ticket: OpenAlex, Crossref, Papers with Code, and community arXiv MCP servers (no primary source read).

## (b) Existing remote MCP servers

- **Hugging Face official MCP**: `https://huggingface.co/mcp`. A live `initialize` without any token succeeded (protocol 2025-06-18, server `huggingface.co/mcp` 0.4.30, returns an `mcp-session-id`); the server instructions say it runs anonymously with rate limits and tells users to set `HF_TOKEN` for more ([docs](https://huggingface.co/docs/hub/en/hf-mcp-server)). Paper access goes through the `hf_fs` tool: `ls hf://papers/trending`, `ls hf://papers/daily/latest`, `search hf://models QUERY` style search that covers papers. It is a general Hub server, so tool output is Hub-shaped rather than a purpose-built "paper" schema. Token goes in a header (TrueForge header auth) or can be omitted.
- **TrueForge catalog** ([`mcp-catalog.yaml`](https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/catalog/mcp-catalog.yaml), read via GitHub API): linear, notion, sentry, deepwiki, exa, parallel-web, github, tavily, bright-data, supabase, stripe, confluence, jira, posthog, you. Entry schema (`CatalogMCPServer` in `openapi.json`): `type: remote`, `name`, `url`, `description`, optional `auth` of `header` or `dcr` (OAuth Dynamic Client Registration), optional `logo`. **No paper-specific entry.** exa, tavily and parallel-web are general search and could surface papers but give no structured arXiv/Scholar data.
- Self-hosters can swap the catalog with `MCP_CATALOG_PATH` ([initial setup](https://trueforge.dev/harness/initial-setup.md)); any URL can also be added in Settings, Connectors, Add MCP Server ([mcp-servers](https://trueforge.dev/mcp-servers.md)).
- Semantic Scholar and arXiv: no first-party remote MCP server found in primary sources read here. Wrapping them is the job of our own server.

## (c) Transport and reaching a local server

- Spec (2025-06-18): two standard transports, stdio and **Streamable HTTP**; Streamable HTTP "replaces" HTTP+SSE of 2024-11-05. A server exposes one MCP endpoint path (e.g. `/mcp`) handling POST and GET, optionally replying with SSE streams, optional `Mcp-Session-Id`. Servers MUST validate `Origin`, SHOULD bind to 127.0.0.1 when local ([spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)).
- TrueForge only does remote servers by URL (`type: remote`), and its `MCPServerInitInfo.transport_type` enum is `streamable-http` or `sse` (`openapi.json`). So serve Streamable HTTP; no SSE needed.
- Auth for our server: TrueForge supports none, static headers, or OAuth DCR. For a local-only server on 127.0.0.1, "no auth" is allowed for "public or network-trusted servers"; a static header (bearer) is the cheap hardening.
- Local reachability: the docs say `PUBLIC_BASE_URL` defaults to `http://localhost:<port>` "which is fine on your own machine", and deployment options are `npx`, Docker Compose, Helm. They do not say how a TrueForge **server process** reaches a URL on the host. If TrueForge runs via `npx` on the same machine, `http://127.0.0.1:<port>/mcp` should work. If it runs in Docker, `127.0.0.1` points at the container (host would need e.g. `host.docker.internal`). Not tested; see open questions.

## (d) Official TypeScript SDK on Bun

Source: [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk), GitHub releases and repo docs.

- `main` is **v2**, "stable", implementing MCP spec **2026-07-28**. Latest release `@modelcontextprotocol/server` **2.3.1** (2026-10-05). Packages: `@modelcontextprotocol/server`, `/client`, optional `/node`, `/express`, `/fastify`, `/hono`. v1 is `@modelcontextprotocol/sdk` 1.32.1 on branch `v1.x`, bug and security fixes for at least six months after 2026-07-27.
- README: "runs on Node.js, Bun, and Deno"; install `bun add @modelcontextprotocol/server`. Server package `engines.node >= 20`.
- Streamable HTTP: `createMcpHandler(factory)` returns `{ fetch }`; on Bun, `export default handler` is the whole mount, then `bun run server.ts` ([web-standard guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md)). Factory runs per request, so the endpoint is stateless by default.
- The handler does **no** Host/Origin/token validation. On Bun wrap it with `hostHeaderValidationResponse` / `originValidationResponse` (use `localhostAllowedHostnames()` / `localhostAllowedOrigins()` for localhost-only) to defend against DNS rebinding. Open issue #2844 flags this as a footgun.
- Legacy clients: by default the handler serves 2025-era clients (`initialize` first) statelessly from the same factory; `legacy: 'reject'` makes it modern-only (would reject a 2025-era client with 400). The standalone GET SSE stream and DELETE answer 405 in the default posture.
- Bun history: issue #1269 "Non-Node environment support (Bun, Deno, React Native)" closed 2026-03-16; older Bun compile and stdio issues (#709, #91) are closed. No open Bun-specific issue found; open items seen: #2011 (zod in both dependencies and peerDependencies), #2701 (Deno type resolution).
- Tools use zod v4 (`import * as z from 'zod/v4'`).

## Open questions

1. Which MCP protocol revision does TrueForge's client speak (2025-era or 2026-07-28)? We rely on the default `legacy: 'stateless'` posture working; verify with a real TrueForge connection (a small spike).
2. How does a locally running TrueForge reach `http://127.0.0.1:<port>/mcp` (npx vs Docker)? Needs a hands-on test.
3. Should the Paper Scout use the HF MCP directly for trending papers, or only our own server (single schema, our caching and rate limiting)?
4. Semantic Scholar key: worth the signup (user action) or skip enrichment initially?
5. HF `api/papers/search` and `api/daily_papers` are live but not documented where we looked; confirm in the OpenAPI spec before depending on them.
