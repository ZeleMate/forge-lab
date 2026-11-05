// PROTOTYPE (#10) variant B: chat on the left, a live trace of the open Session on
// the right. The trace reads the persisted events over REST every 1.5 s, so it
// shows what the harness stored (turn boundaries, approval pauses, subagent
// threads, context overwrites), not what the chat renders.
import { TrueForgeUI } from "@truefoundry/trueforge-ui";
import { useState } from "react";
import { getTurnEvents, getTurns, type Turn, usePoll, useUrlSessionId } from "../api";
import { StatusBadge, TraceList } from "../TraceList";

export function VariantB() {
  const sessionId = useUrlSessionId();
  return (
    <div className="flex h-dvh min-h-0 w-full">
      <div className="min-h-0 min-w-0 flex-1">
        <TrueForgeUI
          server={{ type: "trueforge" }}
          layout="sidebar"
          agentConfig={{ mode: "SingleAgent", name: "cartographer" }}
          theme={{ preset: "trueforge", brand: { mode: "icon-title", name: "Cartographer" } }}
          withRouter
          className="h-full min-h-0"
          onError={(e) => console.error("[TrueForgeUI]", e)}
        />
      </div>
      <aside className="flex w-[420px] shrink-0 flex-col border-l border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
        <header className="border-b border-zinc-200 p-3 dark:border-zinc-800">
          <h2 className="font-semibold text-sm">Live trace</h2>
          <p className="font-mono text-[11px] text-zinc-500">{sessionId ?? "open or start a Session"}</p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {sessionId ? <SessionTrace sessionId={sessionId} /> : null}
        </div>
      </aside>
    </div>
  );
}

function SessionTrace({ sessionId }: { sessionId: string }) {
  const turns = usePoll(() => getTurns(sessionId), 1500, sessionId);
  if (turns.error) return <p className="text-rose-600 text-xs">{turns.error}</p>;
  if (!turns.value) return <p className="text-xs text-zinc-500">loading…</p>;
  return (
    <div className="space-y-3">
      {turns.value.map((t, i) => (
        <TurnBlock key={t.id} turn={t} n={i + 1} sessionId={sessionId} open={i === turns.value!.length - 1} />
      ))}
    </div>
  );
}

function TurnBlock({ turn, n, sessionId, open }: { turn: Turn; n: number; sessionId: string; open: boolean }) {
  const [expanded, setExpanded] = useState(open);
  // Only poll events for the expanded Turn; finished Turns never change.
  const live = turn.state.status === "running" || turn.state.status === "paused";
  const events = usePoll(expanded ? () => getTurnEvents(sessionId, turn.id) : null, live ? 1500 : 60_000, `${turn.id}|${live}`);
  return (
    <section className="rounded border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setExpanded(!expanded)}>
        <span className="font-semibold text-xs">Turn {n}</span>
        <StatusBadge status={turn.state.status} />
        <span className="font-mono text-[10px] text-zinc-500">{turn.id.slice(0, 12)}</span>
        {turn.previous_turn_id ? (
          <span className="font-mono text-[10px] text-zinc-400">← {turn.previous_turn_id.slice(0, 12)}</span>
        ) : null}
      </button>
      {expanded && events.value ? (
        <div className="mt-2">
          <TraceList events={events.value} />
        </div>
      ) : null}
    </section>
  );
}
