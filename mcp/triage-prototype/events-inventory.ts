// PROTOTYPE (#17). Read-only inventory of the persisted events in Experiment
// Sessions (`metadata.experiment` set) on the local server: which event types
// exist and how many. The user's own chat Sessions are skipped, so none of their
// content can reach a third-party API in events.ts.
//
//   bun events-inventory.ts        (needs `bun run dev`)

import { allEvents, api, type Event } from "@forge-lab/lib/trueforge";

type SessionRow = { id: string; metadata?: Record<string, unknown> | null };
type TurnRow = { id: string; status?: string };

// Like lib's `listAll`, but with a page size the endpoint accepts (sessions and turns cap `limit` at 25).
async function listAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let token: string | null | undefined;
  do {
    const q = new URLSearchParams({ limit: "25", ...(token ? { page_token: token } : {}) });
    const page = await api<T[]>("GET", `${path}?${q}`);
    out.push(...page.data);
    token = page.pagination?.next_page_token;
  } while (token);
  return out;
}

export async function experimentEvents(): Promise<{ sessionId: string; turnId: string; event: Event }[]> {
  const sessions = await listAll<SessionRow>("/sessions");
  const experiments = sessions.filter((s) => s.metadata?.experiment !== undefined);
  console.log(`${sessions.length} Sessions, ${experiments.length} tagged as Experiment Sessions`);
  const out: { sessionId: string; turnId: string; event: Event }[] = [];
  for (const s of experiments) {
    for (const t of await listAll<TurnRow>(`/sessions/${s.id}/turns`)) {
      for (const event of await allEvents(s.id, t.id)) out.push({ sessionId: s.id, turnId: t.id, event });
    }
  }
  return out;
}

// `import.meta.main` is true only when this file is run directly, not imported.
if (import.meta.main) {
  const rows = await experimentEvents();
  const byType = new Map<string, number>();
  for (const { event } of rows) byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
  console.log(`${rows.length} events`);
  for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)} ${type}`);
}
