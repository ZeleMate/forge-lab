// The panel's two React hooks: which Session is open, and "keep this value fresh".

import { useEffect, useEffectEvent, useState } from "react";
import { sessionIdFromPath } from "./session-url";

const URL_CHECK_MS = 400;

// Polled, because the SDK's router uses pushState, which fires no event a host can hear.
export function useOpenSessionId(): string | null {
  // Passing a function to useState runs it once, for the first render only.
  const [id, setId] = useState(() => sessionIdFromPath(window.location.pathname));
  useEffect(() => {
    const timer = setInterval(() => setId(sessionIdFromPath(window.location.pathname)), URL_CHECK_MS);
    return () => clearInterval(timer);
  }, []);
  return id;
}

export type Polled<T> = { value: T | null; error: string | null };

// Reads now, then every `intervalMs` (null: read once). A new `restartKey` reads again
// straight away. The last good value stays on screen through a failed read, and `load:
// null` holds off reading at all. The next read is scheduled only after the last one
// ends, so a slow server can't pile reads up, and cleanup aborts one still in flight.
export function usePolling<T>(
  load: ((signal: AbortSignal) => Promise<T>) | null,
  intervalMs: number | null,
  restartKey: string,
): Polled<T> {
  const [polled, setPolled] = useState<Polled<T>>({ value: null, error: null });
  // An Effect Event always sees the newest `load` without being an Effect dependency,
  // so a new inline function on each render doesn't restart the polling.
  const read = useEffectEvent((signal: AbortSignal) => load?.(signal));
  const enabled = load !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: restartKey is the caller's signal to read again
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const value = await read(signal);
        if (signal.aborted) return;
        // `undefined` only means nothing to show; the next read is still scheduled below.
        if (value !== undefined) setPolled({ value, error: null });
      } catch (error) {
        if (signal.aborted) return;
        setPolled((previous) => ({ value: previous.value, error: String(error) }));
      }
      if (intervalMs !== null) timer = setTimeout(tick, intervalMs);
    };
    void tick(); // `void` marks a promise we deliberately don't await

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, intervalMs, restartKey]);

  return polled;
}
