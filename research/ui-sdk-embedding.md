# Embedding `@truefoundry/trueforge-ui` in Vite + React 19 + Bun

Ticket: ZeleMate/forge-lab#4. Researched 2026-10-18 against package version **0.179.0** (published 2026-10-14; the package is `0.x`, so APIs may change).

## Short answer

- Render `<TrueForgeUI server={{ type: "trueforge", baseUrl }} layout="sidebar" agentConfig={{ mode: "SingleAgent", name: "paper-scout" }} />` inside a parent with a real height.
- Use a **Vite dev proxy** for `/api` to `http://localhost:8790` and leave `baseUrl` at its default `/`. The TrueForge server has no CORS code, so a direct cross-origin call from `localhost:5173` is not supported by anything in the docs or source. No separate backend is needed.
- Agent mode: **`SingleAgent`** with the saved agent's name.
- React 19 is a supported peer (`^18 || ^19`). Add the Vite `resolve.dedupe` list from the official troubleshooting page.
- Tailwind v4: compatible by design (the SDK ships its own layered CSS without preflight). Import `styles.css` explicitly.
- Bun: nothing in the docs mentions it. Package `engines` is `node >=22`. Treat Bun as an untested package manager and runner; see Caveats.

## 1. Minimal embedding

Install (the quickstart installs the SDK client explicitly because the adapter loads it):

```bash
bun add @truefoundry/trueforge-ui @truefoundry/trueforge-sdk
```

Source: [Quickstart](https://trueforge.dev/ui-sdk/get-started/quickstart.md).

```tsx
// App.tsx
import { TrueForgeUI } from "@truefoundry/trueforge-ui";

export default function App() {
  return (
    <div className="flex h-dvh min-h-0 w-full flex-col">
      <TrueForgeUI
        server={{ type: "trueforge" }}            // baseUrl defaults to '/'
        layout="sidebar"
        agentConfig={{ mode: "SingleAgent", name: "paper-scout" }}
        className="h-full min-h-0"
      />
    </div>
  );
}
```

Props are from the [TrueForgeUI reference](https://trueforge.dev/ui-sdk/reference/trueforge-ui.md): `server` and `layout` are required; `layout` is `"sidebar" | "drawer" | "dock" | "widget"` or a custom component; `agentConfig` defaults to `AgentLibraryWithComposer`.

Gotchas stated in [Troubleshooting](https://trueforge.dev/ui-sdk/guides/troubleshooting.md):

- The SDK fills its parent and sets no height. A parent without a resolved height renders a blank UI ("the single most common cause").
- The package is ESM-only and client-only. Fine for a Vite SPA.
- An error alert on mount means the built-in server failed to resolve: check `@truefoundry/trueforge-sdk` is installed, `baseUrl` is reachable, and attach `onError` to see the cause.
- A `screenType=mcp-auth` query parameter makes `TrueForgeUI` render only the MCP OAuth completion screen. Only matters if we use OAuth MCP servers; our own local MCP server will not.
- The built-in layouts show a Settings button only when the server exposes a `catalog`. The `type: "trueforge"` adapter composes default settings catalogs (npm README), so Settings should appear. Not verified in a running app.

## 2. Browser to server: direct or proxy?

Facts:

- The adapter runs in the browser. `baseUrl` is the "harness API root", default `/` for same-origin ([Quickstart](https://trueforge.dev/ui-sdk/get-started/quickstart.md), [TrueForgeUI ref](https://trueforge.dev/ui-sdk/reference/trueforge-ui.md)). Relative values are resolved against `window.location.origin` (`resolveTrueForgeBaseUrl` in `packages/trueforge-ui/src/plugins/trueforge-agent-server-adapter/client.ts`).
- Local server: `npx @truefoundry/trueforge@latest`, default `http://localhost:8790`, SQLite, **no login by default**, so no `token` is needed ([Quickstart](https://trueforge.dev/quickstart.md), [Setup Login](https://trueforge.dev/authentication/overview.md)). Port via `--port` or `PORT`.
- The docs quickstart for the UI SDK shows `baseUrl: "http://localhost:8790"` directly, i.e. a cross-origin call from a dev server, but it never mentions CORS.
- **No CORS handling exists in the server.** A case-insensitive grep for `cors` and `access-control` over all of `packages/` at commit `0a42995` of `truefoundry/trueforge` returns nothing. So cross-origin requests from `http://localhost:5173` depend on browser behaviour: JSON POSTs with `Content-Type: application/json` trigger a preflight, and with no CORS headers they would fail. This is inferred from source, not tested.
- TrueForge's own frontend (`packages/frontend/vite.config.ts`) avoids the issue with a Vite proxy: `server.proxy: { '/api': { target: 'http://localhost:8790', changeOrigin: true } }`, plus a `proxyRes` hook that sets `cache-control: no-cache` and `x-accel-buffering: no` on `text/event-stream` responses so SSE streams are not buffered.

Recommendation: copy that pattern.

```ts
// vite.config.ts
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom", "@assistant-ui/core", "@assistant-ui/react", "@assistant-ui/store"],
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.TRUEFORGE_URL ?? "http://localhost:8790",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyRes", (res) => {
            if (res.headers["content-type"]?.includes("text/event-stream")) {
              res.headers["cache-control"] = "no-cache";
              res.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
});
```

The proxy is dev-only. For this local learning repo that is enough; a production build would need the same `/api` routing from a reverse proxy, which is out of scope. Fallback if a proxy is unwanted: `baseUrl: "http://localhost:8790"` and test whether the browser blocks it.

The proxy path list is `/api` only: the server's API lives under `/api/v1` (`/api/v1/auth/callback` appears in the auth docs) and TrueForge's own proxy also covers `/api/internal`.

## 3. Agent mode for one fixed agent

`agentConfig={{ mode: "SingleAgent", name: "<agent name>" }}` ([Agent modes](https://trueforge.dev/ui-sdk/guides/agent-modes.md)). Every conversation uses that named agent; selection controls are hidden, so users cannot switch agents or open the composer; New chat stays enabled.

Implications:

- The agent must **exist on the server first** (created via the bundled UI at `:8790`, the REST API, or `@truefoundry/trueforge-core` glue scripts). Agent names are immutable once created ([Create an agent API](https://trueforge.dev/api-reference/agents/create-an-agent.md)).
- `defaultAgentSpec` is ignored in `SingleAgent` mode ([Troubleshooting](https://trueforge.dev/ui-sdk/guides/troubleshooting.md)), so instructions, model, MCP tools and sandbox settings live in the saved agent, not in React props.
- Model, MCP servers and API keys are configured on the server (Settings), not in the embedded app. The embedded UI is a client of that config.
- The other three modes are `AgentLibrary` (pick saved agents, New chat disabled), `AgentComposer`, and `AgentLibraryWithComposer` (default). Composer drafts default to `openai-main/gpt-4.1` unless `defaultAgentSpec` is given, which would fail without an OpenAI provider; irrelevant for `SingleAgent`.

## 4. Peer dependencies and React 19

From the npm registry (`registry.npmjs.org/@truefoundry/trueforge-ui`, `latest` = 0.179.0; dist-tags also include `rc` = 0.179.0-rc.3):

| Item | Value |
| - | - |
| Required peers | `react`, `react-dom` `^18 \|\| ^19` |
| Optional peers | `@types/react`, `@assistant-ui/core ^0.2.22`, `@assistant-ui/react ^0.14.24` |
| Bundled dependencies | `@assistant-ui/core 0.2.22`, `@assistant-ui/react 0.14.27`, `@truefoundry/trueforge-sdk 0.179.0`, `@truefoundry/trueforge-assistant-ui-runtime 0.179.0`, `zod ^4`, `react-router-dom ^6 \|\| ^7`, `monaco-editor ^0.57`, `chart.js`, `react-markdown`, `lucide-react`, `@openuidev/*` and others |
| `engines` | `node >=22` |
| Module format | ESM only, `type: module`; exports `.`, `./styles.css`, `./assistant-ui`, `./plugins/trueforge-agent-server-adapter` |

- React 19 is explicitly supported. TrueForge's own frontend uses the package too.
- The package lists `react-router-dom ^6 || ^7` as a regular dependency, so we do not need to add a router ourselves, but it will be installed.
- Singletons that must resolve to a single copy: `react`, `react-dom`, `@assistant-ui/core`, `@assistant-ui/react`, `@assistant-ui/store` (see `docs/compatibility.md` in the repo). Duplicates give "requires an AuiProvider". Fix with the `resolve.dedupe` above; for transitive duplicates use `overrides` in package.json (Bun supports `overrides` and `resolutions`). Only add `@assistant-ui/*` as direct deps if we import their primitives, and then within the ranges above.
- The package is 0.x. Pin an exact version in the repo.

## 5. CSS and Tailwind v4

Primary sources disagree slightly, so both are quoted:

- npm README: the host app "must have Tailwind CSS set up (v4 recommended)" and use `@import 'tailwindcss';`. SDK styles "load automatically when `TrueForgeUI` / `ThemeProvider` mounts" so no stylesheet import is needed for client-only apps. Optional explicit load order for SSR: `@import 'tailwindcss'; @import '@truefoundry/trueforge-ui/styles.css';`.
- Docs Troubleshooting: `@import "@truefoundry/trueforge-ui/styles.css";` is "the entire styling setup", the stylesheet is self-contained, and Tailwind is not needed in the host app for the SDK to look right.
- Source (`packages/trueforge-ui/src/build-styles.css`): the SDK builds against `tailwindcss/theme` and `tailwindcss/utilities` placed in named layers (`tfy-agent-ui-theme`, `tfy-agent-ui-utilities`) and **deliberately omits preflight**, so it does not reset host styles. SDK base rules sit in `@layer tfy-agent-ui-base`. The stylesheet also registers its tokens through Tailwind v4 `@theme inline`.
- Docs: if you add `@import "tailwindcss";` to the host, that does ship preflight and resets host styles by design. That is normal Tailwind behaviour and what we want for our own app chrome.

Recommended `index.css` (we use Tailwind v4 for our own chrome anyway):

```css
@import "tailwindcss";
@import "@truefoundry/trueforge-ui/styles.css";
```

Notes:

- With Tailwind v4's Vite plugin there is no `tailwind.config.js`. The SDK's CSS is prebuilt, so no `@source` entry for `node_modules` should be needed. Not verified; if SDK utility classes look unstyled, add `@source "../node_modules/@truefoundry/trueforge-ui/dist"`.
- Dark mode: the provider toggles the `dark` class on `document.documentElement`. Pass a controlled `theme.mode` if our app has its own toggle. Presets for Claude, ChatGPT, Gemini and TrueFoundry themes exist ([UI SDK overview](https://trueforge.dev/chat-ui.md)).
- Layer order risk: both the SDK and our Tailwind import declare layers. Import order above (Tailwind first) is the documented SSR order.

## 6. Bun caveats

Nothing in the TrueForge docs or the package mentions Bun, and `bun`/`node` were not available in this research environment, so **none of this was run**. What the sources do tell us:

- `engines.node >=22` on the UI package; the server needs Node 22.14+ (`npx @truefoundry/trueforge`). The server is started with Node/npx, not Bun, in this plan.
- TrueForge's own repo uses pnpm workspaces (`workspace:*`), and ships its `.d.ts` and CSS pre-built, so consuming from Bun should be an ordinary registry install.
- Vite runs on Node by default even when launched via `bun run dev`, because the `vite` bin has a Node shebang. `bunx --bun vite` forces the Bun runtime. Prefer the default (Node) for Vite to avoid runtime differences, and use Bun as package manager and script runner. This is general Bun/Vite behaviour, not from TrueForge docs.
- Bun workspaces hoist dependencies into the root `node_modules`; combined with the singleton requirement that is helpful, but verify with `bun pm ls react @assistant-ui/core @assistant-ui/react` that each resolves to one version.

## Open questions

1. Does `localhost:5173` to `localhost:8790` work without the proxy? Source says no CORS support, so expect not; a 2-minute browser test would confirm.
2. Does an embedded app with `SingleAgent` still show the Settings panel (needs `catalog`) and how do approvals and sandbox download links render? Needs a prototype.
3. Verify the single-copy check under Bun workspaces and that `bun install` produces no peer warnings.
4. Is `@source` needed for SDK utilities when the host uses Tailwind v4's Vite plugin? Probably not.
5. Is an unauthenticated local server reachable from any web page on the machine (no CORS plus no auth)? Related security hygiene; the docs only say "keep it on localhost".

## Sources

- https://trueforge.dev/chat-ui.md
- https://trueforge.dev/ui-sdk/get-started/quickstart.md
- https://trueforge.dev/ui-sdk/guides/agent-modes.md
- https://trueforge.dev/ui-sdk/guides/troubleshooting.md
- https://trueforge.dev/ui-sdk/reference/trueforge-ui.md
- https://trueforge.dev/quickstart.md, https://trueforge.dev/authentication/overview.md
- https://registry.npmjs.org/@truefoundry/trueforge-ui (v0.179.0 metadata and README)
- https://github.com/truefoundry/trueforge at commit `0a42995`: `packages/frontend/vite.config.ts`, `packages/trueforge-ui/docs/compatibility.md`, `packages/trueforge-ui/src/build-styles.css`, `packages/trueforge-ui/src/plugins/trueforge-agent-server-adapter/client.ts`
