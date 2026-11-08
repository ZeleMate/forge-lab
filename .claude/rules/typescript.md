---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript rules

- `strict` TypeScript. No `any`, no non-null assertions (`!`) without a comment explaining why.
- ES modules only. Bun is the package manager and runtime: `bun add --exact` / `bun add --dev --exact` at the right workspace; never npm, pnpm or yarn.
- Validate external data (HTTP, env, model output) at the boundary with a schema before using it.
- Tests use `bun test`, next to the code as `*.test.ts`.
- Biome formats and lints (`bun run format`, `bun run check`); there is no Prettier or ESLint.
