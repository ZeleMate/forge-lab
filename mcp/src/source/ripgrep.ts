// Text search over the snapshot with ripgrep: strings, config keys, docs, YAML,
// tests, anything outside the ts-morph index (#22: ripgrep first, ts-morph for meaning).

export type Hit = { path: string; line: number; text: string; before: string[]; after: string[] };
export type SearchOptions = {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  globs: string[];
  context: number;
};
export type SearchResult = { ok: true; hits: Hit[]; limitReached: boolean } | { ok: false; reason: string };

const MAX_LINE = 200; // characters kept per line; minified files have huge ones

// Resolved from PATH once, at import: `bun run dev` passes the shell's PATH on,
// CI installs a pinned ripgrep into /usr/local/bin. server.ts refuses to start
// without it (#32: no degraded mode); the check in `search` covers other callers.
export const RG = Bun.which("rg");

// What `rg --json` prints, one object per line; only the fields read here.
type RgLine = {
  type: "begin" | "match" | "context" | "end" | "summary";
  data: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
};

export async function search(root: string, opts: SearchOptions, limit: number): Promise<SearchResult> {
  if (!RG) return { ok: false, reason: "ripgrep (rg) isn't installed on the MCP server's PATH" };
  const args = [
    "--json",
    "--no-config", // ignore any RIPGREP_CONFIG_PATH the environment might set
    "--no-ignore", // the snapshot's .gitignore lists the generated *.gen.ts files
    "--sort=path", // single-threaded but deterministic, so citations and tests are stable
    "--max-columns=1000",
    `--context=${opts.context}`,
    ...(opts.regex ? [] : ["--fixed-strings"]), // regex is ripgrep's default
    ...(opts.caseSensitive ? [] : ["--ignore-case"]),
    // Each glob is its own argument, never pasted into a shell string.
    ...opts.globs.flatMap((g) => ["--glob", g]),
  ];
  // `--` ends the options, so a pattern that starts with `-` isn't read as a flag.
  const argv = [RG, ...args, "--", opts.pattern];
  const proc = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe", env: {} });

  const hits: Hit[] = [];
  let pending: string[] = []; // context lines seen since the last match
  let limitReached = false;
  // Bun gives the output as a web ReadableStream; read it as text, line by line,
  // and stop early once there are enough matches.
  let buffer = "";
  const decoder = new TextDecoder();
  // `for await` pulls chunks as ripgrep writes them.
  outer: for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const msg = JSON.parse(line) as RgLine;
      const path = msg.data.path?.text;
      const text = (msg.data.lines?.text ?? "").replace(/\r?\n$/, "").slice(0, MAX_LINE);
      if (msg.type === "begin") pending = [];
      else if (msg.type === "context") {
        const last = hits.at(-1); // `.at(-1)` is the last element, or undefined
        if (last && last.path === path && (msg.data.line_number ?? 0) > last.line && last.after.length < opts.context)
          last.after.push(text);
        else pending.push(text);
      } else if (msg.type === "match" && path) {
        if (hits.length === limit) {
          limitReached = true;
          proc.kill();
          break outer; // a label lets `break` leave both loops at once
        }
        hits.push({ path, line: msg.data.line_number ?? 0, text, before: pending.slice(-opts.context), after: [] });
        pending = [];
      }
    }
  }
  const code = await proc.exited;
  // ripgrep exits 0 with matches, 1 with none, 2 on errors such as a bad regex.
  if (!limitReached && code === 2) {
    const stderr = (await new Response(proc.stderr).text()).trim().split("\n").slice(0, 3).join(" ");
    return { ok: false, reason: `ripgrep failed: ${stderr}` };
  }
  return { ok: true, hits, limitReached };
}
