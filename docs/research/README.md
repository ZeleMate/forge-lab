# Research

Findings behind the closed research tickets on the [wayfinder map](https://github.com/ZeleMate/forge-lab/issues/1). Each doc was written from docs and source at TrueForge 0.179.2 unless it says otherwise. Claims marked "inferred" were not observed on a running server.

| Doc | Ticket | Status |
|---|---|---|
| [agent-loop.md](agent-loop.md) | [#2](https://github.com/ZeleMate/forge-lab/issues/2) | Current. The core of how a turn runs; seed for the Harness Notes |
| [sandbox-providers.md](sandbox-providers.md) | [#3](https://github.com/ZeleMate/forge-lab/issues/3) | **Superseded**: the local sandbox works ([#11](https://github.com/ZeleMate/forge-lab/issues/11)), so no Daytona is needed |
| [ui-sdk-embedding.md](ui-sdk-embedding.md) | [#4](https://github.com/ZeleMate/forge-lab/issues/4) | Current |
| [paper-sources-mcp.md](paper-sources-mcp.md) | [#5](https://github.com/ZeleMate/forge-lab/issues/5) | **Superseded**: the paper sources are moot (Cartographer replaced Paper Scout); the MCP transport and SDK findings still hold |
| [agents-as-code.md](agents-as-code.md) | [#6](https://github.com/ZeleMate/forge-lab/issues/6) | Current. The client package is `@truefoundry/trueforge-sdk` |
| [security-review.md](security-review.md) | [#13](https://github.com/ZeleMate/forge-lab/issues/13) | Current. **The hardening rules every change follows** |
| [openrouter-models.md](openrouter-models.md) | [#14](https://github.com/ZeleMate/forge-lab/issues/14) | Partly superseded: Opus 5.5 is now the main model; these open-weight models are the cheaper alternatives |
| [decisions-api.md](decisions-api.md) | [#15](https://github.com/ZeleMate/forge-lab/issues/15) | Current. Examples use papers; Cartographer applies it to source files |
| [pr-review.md](pr-review.md) | [#16](https://github.com/ZeleMate/forge-lab/issues/16) | Out of scope: automatic PR review was dropped ([#18](https://github.com/ZeleMate/forge-lab/issues/18)) |
| [session-api.md](session-api.md) | [#21](https://github.com/ZeleMate/forge-lab/issues/21) | Current. Shapes for Cartographer's session tools |
| [source-snapshot.md](source-snapshot.md) | [#22](https://github.com/ZeleMate/forge-lab/issues/22) | Current. Shapes for Cartographer's source tools. Its timing and memory **estimates are replaced** by measurements in [harness/ts-morph-results](../../harness/ts-morph-results/README.md) ([#23](https://github.com/ZeleMate/forge-lab/issues/23)) |
| [prompting-opus.md](prompting-opus.md) | [#27](https://github.com/ZeleMate/forge-lab/issues/27) | Current. First-party prompting guidance for Opus 5.5, the harness prompt Cartographer sits under, and a revised `instructions` |
