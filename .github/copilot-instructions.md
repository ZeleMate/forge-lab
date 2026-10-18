# Review instructions for forge-lab

forge-lab builds a **Paper Scout** agent on the TrueForge harness: a TypeScript monorepo on Bun with a React 19 + Vite chat app, our own MCP server, and glue scripts that apply the agent spec. The author is an experienced Python and agent-harness engineer who is new to TypeScript and React.

## How to review

- Comment only on things that matter: bugs, security issues, and deviations from the rules below. Skip style nits that Biome already enforces.
- When you flag a TypeScript or React issue, add one sentence on the idiomatic way and why, because the author is learning the language.
- Prefer one clear comment per problem over many small ones.

## Vocabulary

Use the terms defined in `CONTEXT.md` exactly (Harness, Agent, Session, Turn, Approval, Subagent, Paper, Reading List, Harness Notes). Flag code, names or docs that use the listed _avoid_ synonyms or blur two terms together.

## Security checklist

Flag any change that:

- commits a secret, API key or `.env` file, or logs one
- binds a server to anything other than `127.0.0.1` (never `0.0.0.0`)
- adds an MCP tool that writes or deletes without an Approval gate (`require_approval_for_tools`, or `destructiveHint`/`readOnlyHint` annotations missing)
- removes the Host/Origin validation on the MCP server
- adds a dependency without an exact version pin, or adds a package to Bun's `trustedDependencies`
- disables TrueForge's outbound URL guard instead of allow-listing a specific host
- passes untrusted paper or web content into tool arguments or prompts without treating it as data
