// The local stack's ports (#32). Everything binds to 127.0.0.1, never the network.
// harness/package.json's `start` script repeats TRUEFORGE as `PORT=8790`,
// because a package.json script can't import TypeScript; keep the two in sync.

export const HOST = "127.0.0.1";

// `as const` freezes the literal types, so `PORTS.mcp` has type 8791, not number.
export const PORTS = {
  trueforge: 8790,
  mcp: 8791, // the Cartographer MCP server
  vite: 5173, // the chat app, with `strictPort` so it fails instead of moving
  probe: 8799, // throwaway MCP servers in Experiments (scripts/lib/probe-mcp.ts)
} as const;

export const TRUEFORGE_ORIGIN = `http://${HOST}:${PORTS.trueforge}`;

// True when `url` is on the local stack, so callers can refuse anything off loopback.
export function isLoopbackUrl(url: string): boolean {
  return url.startsWith(`http://${HOST}`);
}
