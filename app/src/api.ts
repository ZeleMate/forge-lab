import { useEffect, useRef, useState } from "react";

// PROTOTYPE (#10): the few REST reads the trace and bench variants need.
// Same-origin `/api/v1`, which Vite proxies to TrueForge. Read-only: no writes here.

export type Envelope<T> = { data: T; pagination?: { next_page_token?: string | null } };

async function get<T>(path: string): Promise<Envelope<T>> {
  const res = await fetch(`/api/v1${path}`);
  if (!res.ok) throw new Error(`${res.status} on GET ${path}`);
  return (await res.json()) as Envelope<T>;
}

// Loose shapes on purpose: the prototype only reads a few fields of each.
export type TfEvent = {
  type: string;
  id?: string;
  created_at?: string;
  thread_id?: string;
  [k: string]: unknown; // an index signature: any other field is allowed, typed unknown
};
export type Turn = {
  id: string;
  previous_turn_id: string | null;
  created_at: string;
  state: { status: string; reason?: string; message?: string };
};
export type Session = {
  id: string;
  title?: string | null;
  metadata?: Record<string, string>;
  created_at: string;
  updated_at: string;
};

export const getTurns = (sid: string) => get<Turn[]>(`/sessions/${sid}/turns?limit=25`).then((r) => r.data);

export const getTurnEvents = (sid: string, tid: string) =>
  get<TfEvent[]>(`/sessions/${sid}/turns/${tid}/events?limit=100&order=asc`).then((r) => r.data);

export const listSessions = (query = "") => get<Session[]>(`/sessions?limit=25&order=desc${query}`).then((r) => r.data);

export const getSession = (sid: string) => get<Session>(`/sessions/${sid}`).then((r) => r.data);

// The SDK's router puts the open Session in the URL (`/sessions/:id`). It has no
// onSessionChange prop, so the host reads the path. Polled: the router uses
// pushState, which fires no event a host can listen to.
const readSessionId = () => location.pathname.match(/^\/sessions\/([^/]+)$/)?.[1] ?? null;

export function useUrlSessionId(): string | null {
  const [id, setId] = useState(readSessionId);
  useEffect(() => {
    const t = setInterval(() => setId(readSessionId()), 400);
    return () => clearInterval(t);
  }, []);
  return id;
}

// Re-run `load` every `ms` while mounted, restarting whenever `key` changes.
// Returns the latest value and error. `load: null` means "don't poll".
export function usePoll<T>(load: (() => Promise<T>) | null, ms: number, key: string) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A ref holds the newest `load` without restarting the effect on every render.
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabled = load !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the caller's restart signal
  useEffect(() => {
    setValue(null);
    if (!enabled) return;
    let alive = true;
    const tick = async () => {
      try {
        const v = await loadRef.current?.();
        if (alive && v !== undefined) {
          setValue(v);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void tick();
    const t = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key, ms, enabled]);
  return { value, error };
}
