# Sandbox providers for a local TrueForge

Resolves forge-lab#3. Researched 2026-10-18 against primary sources (TrueForge docs/OpenAPI/source, Daytona's own pricing and limits pages). TrueForge npm latest at time of research: 0.179.2.

## Answer

**Daytona is the only sandbox provider TrueForge ships a preset for.** No Docker, local-process, E2B, Modal, etc. provider exists in the public catalog or API. Daytona is a hosted cloud service, so even a fully local TrueForge (`npx @truefoundry/trueforge`) needs a Daytona account and API key to use the sandbox. There is no documented way to run the sandbox locally on the Mac.

Code mode and large-tool-response offloading both require an enabled sandbox, so both depend on Daytona.

## Evidence

- Docs: "Daytona is the only sandbox provider supported today. Support for additional providers is planned." Preset is picked under Settings -> Sandbox providers and takes a pasted API key. (https://trueforge.dev/sandbox.md)
- Shipped catalog `sandbox-catalog.yaml` has exactly one entry, `type: daytona` (exec timeout 60 s, auto-stop 5 min, auto-archive 60 min, auto-delete 7200 min). (https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/catalog/sandbox-catalog.yaml)
- OpenAPI: `CatalogSandboxProvider.type` and `SandboxProviderManifest.type` are enums with the single value `daytona`; auth is `DaytonaSandboxProviderAuth { api_key }`. Only one provider is configured per tenant. (https://trueforge.dev/openapi.json)
- Code mode "is available whenever the agent's sandbox is enabled" (https://trueforge.dev/key-features/code-mode.md). Large-response offloading is on by default but "requires the agent's sandbox to be enabled"; default threshold 6,000 tokens, preview first/last 100 chars (https://trueforge.dev/key-features/large-tool-responses.md). Sandbox is off by default per agent (`config.sandbox.enabled`).
- Local mode needs no other services (SQLite, `npx`); only the sandbox is external. (https://trueforge.dev/quickstart.md, README)

## Setup cost for Daytona

- Account: yes, on app.daytona.io. Daytona's pricing page advertises "$200 in free compute included", no credit card for the free trial; pay-as-you-go after. (https://www.daytona.io/pricing)
- API key must have scopes `write:sandboxes`, `write:snapshots`, `manage:secrets`; saving the provider fails otherwise. (sandbox.md)
- Docker: not needed on the Mac for the sandbox itself (it runs in Daytona's cloud). Docker is only relevant if you run TrueForge via Compose instead of `npx`.
- Defaults: the `default` environment is 1 CPU / 1 GB / 3 GB disk. Custom environments take a build script baked into a Daytona snapshot.
- Rates (per second billing): vCPU $0.0504/h, memory $0.0162/GiB-h, storage $0.000108/GiB-h beyond 5 GiB free. A default sandbox is roughly $0.07/h of running time; with 5-minute auto-stop, learning use should be a few cents per session against the $200 credit. (pricing page; the arithmetic is mine)
- Tier 1 limits (email-verified, no card): pool of 10 vCPU / 10 GiB RAM / 30 GiB storage, 300 sandbox creations/min. Plenty for one agent. The limits page itself lists 20 GiB memory in one table, so treat the memory figure as uncertain. Tier 2 needs a card plus $25 top-up. (https://www.daytona.io/docs/en/limits/)
- Egress: unrestricted by default in TrueForge; per-environment domain allow list or block-all available. Daytona applies tier-based network limits (not detailed on the limits page).

## Local / self-hosted options (none usable today)

- Self-hosting Daytona: the open-source repo `daytonaio/daytona` is archived; its README says core development moved to a private codebase as of June 2026 and the repo gets no further updates. Last push 2026-07-24.
- TrueForge's Daytona wiring has no configurable API URL: the provider class accepts `apiUrl` internally (default `https://app.daytona.io/api`), but the factory builds `new Daytona({ apiKey })` and the manifest has only `api_key`. So pointing at a self-hosted Daytona is not supported through settings.
- Unreleased signal: server source on `main` has a `TFYSandboxProvider` and a `truefoundry` provider type (`server_url`, `nats_bridge_url`) in `providerUtils.ts`. It is absent from the catalog, docs and OpenAPI, so it is internal to TrueFoundry's hosted platform and not a user option. Worth rechecking if a later release exposes it, since a server-URL-based provider could in principle point at something local.
- The sandbox image is built from `packages/trueforge-core/scripts/sandbox/sandbox.Dockerfile` with a NATS bridge (code mode transport), so a custom provider would need that too. Writing one means forking TrueForge (MIT licensed).

## Recommendation for this local learning setup

1. Use Daytona with a free-tier account. It is the only supported path, and the free credit comfortably covers a Paper Scout learning project.
2. Keep the `default` environment (1 CPU / 1 GB) and add a custom environment only if Paper Scout needs libraries (e.g. `pip install httpx pypdf` in the build script).
3. Set a domain allow list for the Paper Scout environment (e.g. arxiv.org and whichever APIs it uses) rather than leaving egress open.
4. Keep the sandbox off for agents that only need MCP calls and chat; this avoids spend and Daytona dependency until code mode or offloading is actually wanted.
5. Do not plan around a fully offline setup; sandbox features are the one part of local TrueForge that needs the internet and a third-party account.

## Open questions

- Does Daytona's free credit expire, and is a card ever demanded at Tier 1 when creating snapshots? (Pricing page says no card for trial; not verified by signing up, which was out of scope.)
- Is the `truefoundry` provider type going to be released, and can it target a user-run server?
- Is there a roadmap for additional providers (docs only say "planned")? Check the TrueForge repo issues/changelog before relying on it.
- Latency impact of a cloud sandbox for code mode (each call bridges back to the local harness via NATS WebSocket and a preview URL). The harness must be reachable from Daytona's sandboxes; unverified whether a laptop-local server behind NAT works for the code-mode bridge. Treat as a risk to test early.
