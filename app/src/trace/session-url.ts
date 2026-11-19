// The SDK's router keeps the open Session in the URL and has no change callback, so
// the path is the only way a host page can learn which Session is open.

// `?.[1]` reads the capture group only if the regex matched; `??` turns a miss into null.
export function sessionIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/sessions\/([\w-]+)\/?$/)?.[1] ?? null;
}
