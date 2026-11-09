// The live trace: the open Session's Turns and their persisted events, as the harness
// stored them rather than as the chat renders them. Read-only.

import { useState } from "react";
import { listTurnEvents, listTurns, type Turn } from "./client";
import { type RowKind, type TraceRow, traceRows } from "./event-rows";
import { useOpenSessionId, usePolling } from "./hooks";
import { continuedTurnIds, eventsPollMs, POLL_MS, pendingActions, type TurnPhase, turnPhase } from "./turn-view";

// `Record<RowKind, string>` makes the compiler insist on an entry for every kind.
const ROW_STYLE: Record<RowKind, string> = {
  turn: "border-zinc-400 dark:border-zinc-600",
  model: "border-sky-500",
  tool: "border-emerald-500",
  approval: "border-amber-500 bg-amber-500/10",
  subagent: "border-violet-500 bg-violet-500/10",
  context: "border-rose-500 bg-rose-500/10",
  other: "border-zinc-200 text-zinc-500 dark:border-zinc-800",
};

const PHASE_STYLE: Record<TurnPhase, string> = {
  running: "bg-sky-600",
  waiting: "bg-amber-600",
  done: "bg-emerald-700",
  error: "bg-rose-600",
  cancelled: "bg-zinc-500",
  unknown: "bg-zinc-500",
};

const shortId = (id: string) => id.slice(-8);
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString();

export function TracePanel() {
  const sessionId = useOpenSessionId();
  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-zinc-200 border-l bg-zinc-50 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-zinc-200 border-b p-3 dark:border-zinc-800">
        <h2 className="font-semibold text-sm">Live trace</h2>
        <p className="font-mono text-[11px] text-zinc-500">{sessionId ?? "Open or start a Session"}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* `key` gives each Session fresh state, so one's Turns never show under another. */}
        {sessionId ? <SessionTrace key={sessionId} sessionId={sessionId} /> : null}
      </div>
    </aside>
  );
}

function SessionTrace({ sessionId }: { sessionId: string }) {
  // Always polled: a new Turn can start at any time, including while none is live.
  const turns = usePolling((signal) => listTurns(sessionId, signal), POLL_MS, sessionId);
  const list = turns.value;
  const continued = continuedTurnIds(list ?? []);
  return (
    <div className="space-y-3">
      {turns.error ? <p className="text-rose-600 text-xs">Can't read Turns: {turns.error}</p> : null}
      {list === null && !turns.error ? <p className="text-xs text-zinc-500">Loading…</p> : null}
      {list?.length === 0 ? <p className="text-xs text-zinc-500">No Turns yet</p> : null}
      {list?.map((turn, index) => (
        <TurnBlock
          key={turn.id}
          sessionId={sessionId}
          turn={turn}
          position={index + 1}
          continued={continued.has(turn.id)}
          startOpen={index === list.length - 1}
        />
      ))}
    </div>
  );
}

function TurnBlock({
  sessionId,
  turn,
  position,
  continued,
  startOpen,
}: {
  sessionId: string;
  turn: Turn;
  position: number;
  continued: boolean;
  startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const phase = turnPhase(turn.state, continued);
  const pending = pendingActions(turn.state);
  const previousTurnId = turn.previousTurnId;
  // The status in the key forces one last read when a running Turn ends, because its
  // final events land after the previous poll. After that a finished Turn isn't re-read.
  const events = usePolling(
    open ? (signal) => listTurnEvents(sessionId, turn.id, signal) : null,
    eventsPollMs(turn.state),
    turn.state.status,
  );
  // Read once for tool names: a Turn can only continue from one that has finished.
  const previous = usePolling(
    open && previousTurnId ? (signal) => listTurnEvents(sessionId, previousTurnId, signal) : null,
    null,
    previousTurnId ?? "",
  );

  return (
    <section className="rounded border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className="font-semibold text-xs">Turn {position}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] text-white ${PHASE_STYLE[phase]}`}>{phase}</span>
        <span className="font-mono text-[10px] text-zinc-500">{shortId(turn.id)}</span>
        {turn.previousTurnId ? (
          <span className="font-mono text-[10px] text-zinc-500">continues from {shortId(turn.previousTurnId)}</span>
        ) : null}
      </button>
      {phase === "waiting" ? (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
          Waiting on {pending} {pending === 1 ? "action" : "actions"}. The answer starts a new Turn.
        </p>
      ) : null}
      {turn.state.status === "error" ? <p className="mt-1 text-[11px] text-rose-600">{turn.state.message}</p> : null}
      {open ? (
        <div className="mt-2">
          {events.error ? <p className="text-rose-600 text-xs">Can't read events: {events.error}</p> : null}
          {events.value ? <EventList rows={traceRows(events.value, previous.value ?? [])} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function EventList({ rows }: { rows: TraceRow[] }) {
  return (
    <ol className="space-y-1">
      {rows.map((row) => (
        <li key={row.id} className={`break-words border-l-4 py-0.5 pl-2 font-mono text-xs ${ROW_STYLE[row.kind]}`}>
          <span className="text-zinc-500">{timeOf(row.createdAt)}</span> {row.label}
          {row.detail ? <span className="text-zinc-500"> · {row.detail}</span> : null}
          {row.thread ? <span className="text-zinc-500"> · thread {shortId(row.thread)}</span> : null}
        </li>
      ))}
    </ol>
  );
}
