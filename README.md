# forge-lab

A learning project: a **Paper Scout** agent that finds, scores and tracks research papers, built on the [TrueForge](https://trueforge.dev) agent harness. The goal is to learn how a third-party harness works compared with a custom one, and to learn TypeScript, React and Bun along the way.

## Status

Planning. The way to a build-ready spec is charted on the [wayfinder map](https://github.com/ZeleMate/forge-lab/issues/1): each decision is a sub-issue, and closed ones are indexed under "Decisions so far".

## Stack (planned)

- **Harness:** TrueForge, run locally and bound to loopback
- **Agent model:** small open-weight models via OpenRouter
- **Cheap triage:** OpenAI Decisions API, called from our MCP server
- **Code:** TypeScript on Bun: a React 19 + Vite chat app, our own MCP server, and glue scripts

## Where things are

- [`CONTEXT.md`](CONTEXT.md): the domain glossary
- `research/*` branches: findings behind each closed research ticket
- [`.github/copilot-instructions.md`](.github/copilot-instructions.md): what the automatic PR review checks
