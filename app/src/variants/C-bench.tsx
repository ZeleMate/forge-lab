// PROTOTYPE (#10) variant C: the lab bench. Sessions come first: a list with
// Experiment Sessions marked, the selected Session's Turn tree (forks show as
// branches via previous_turn_id) and one Turn's trace. Chat is secondary, a dock
// you pop open. The question: is Cartographer an inspector with a chat attached,
// rather than a chat with an inspector attached?
import { TrueForgeUI } from "@truefoundry/trueforge-ui";
import { useState } from "react";
import { getTurnEvents, getTurns, listSessions, type Session, type Turn, usePoll } from "../api";
import { StatusBadge, TraceList } from "../TraceList";

export function VariantC() {
  const [onlyExperiments, setOnlyExperiments] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const sessions = usePoll(() => listSessions(), 3000, "sessions");
  const shown = (sessions.value ?? []).filter((s) => !onlyExperiments || s.metadata?.experiment);

  return (
    <div className="grid h-dvh min-h-0 grid-cols-[280px_1fr] bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <nav className="flex min-h-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
        <header className="space-y-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
          <h1 className="font-semibold">Cartographer · bench</h1>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={onlyExperiments} onChange={(e) => setOnlyExperiments(e.target.checked)} />
            Experiment Sessions only
          </label>
        </header>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {shown.map((s) => (
            <SessionRow key={s.id} s={s} active={s.id === selected} onSelect={() => setSelected(s.id)} />
          ))}
          {sessions.error ? <li className="p-3 text-rose-600 text-xs">{sessions.error}</li> : null}
        </ul>
      </nav>
      <main className="min-h-0 overflow-y-auto p-4">
        {selected ? <SessionBench sessionId={selected} /> : <p className="text-sm text-zinc-500">Pick a Session.</p>}
      </main>
      {/* The chat as a dock: no router, it floats over the bench. */}
      <TrueForgeUI
        server={{ type: "trueforge" }}
        layout="dock"
        agentConfig={{ mode: "SingleAgent", name: "cartographer" }}
        theme={{ preset: "trueforge", brand: { mode: "icon-title", name: "Cartographer" } }}
        onError={(e) => console.error("[TrueForgeUI]", e)}
      />
    </div>
  );
}

function SessionRow({ s, active, onSelect }: { s: Session; active: boolean; onSelect: () => void }) {
  const exp = s.metadata?.experiment;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full border-b border-zinc-100 p-3 text-left text-sm dark:border-zinc-900 ${active ? "bg-sky-50 dark:bg-sky-950" : ""}`}
      >
        <div className="truncate">{s.title || s.id}</div>
        <div className="flex gap-2 font-mono text-[10px] text-zinc-500">
          {exp ? <span className="rounded bg-violet-600 px-1 text-white">exp: {exp}</span> : <span>chat</span>}
          <span>{new Date(s.updated_at).toLocaleString()}</span>
        </div>
      </button>
    </li>
  );
}

// Lay the Turns out as a tree: each Turn hangs under the Turn it continues from.
function children(turns: Turn[], parent: string | null) {
  return turns.filter((t) => t.previous_turn_id === parent);
}

function SessionBench({ sessionId }: { sessionId: string }) {
  const turns = usePoll(() => getTurns(sessionId), 2000, sessionId);
  const [turnId, setTurnId] = useState<string | null>(null);
  const all = turns.value ?? [];
  const current = turnId ?? all.at(-1)?.id ?? null;
  const events = usePoll(current ? () => getTurnEvents(sessionId, current) : null, 2000, `${sessionId}|${current}`);

  // A recursive component: renders a Turn, then its children indented.
  const Node = ({ t, depth }: { t: Turn; depth: number }) => (
    <>
      <button
        type="button"
        onClick={() => setTurnId(t.id)}
        style={{ marginLeft: depth * 16 }}
        className={`flex items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs ${t.id === current ? "bg-sky-100 dark:bg-sky-900" : ""}`}
      >
        <StatusBadge status={t.state.status} />
        {t.id.slice(0, 12)}
        <span className="text-zinc-500">{new Date(t.created_at).toLocaleTimeString()}</span>
        {children(all, t.id).length > 1 ? <span className="text-violet-600">⑂ fork</span> : null}
      </button>
      {children(all, t.id).map((c) => (
        <Node key={c.id} t={c} depth={depth + 1} />
      ))}
    </>
  );

  return (
    <div className="grid grid-cols-[minmax(240px,1fr)_2fr] gap-4">
      <section>
        <h2 className="mb-2 font-semibold text-sm">Turn tree</h2>
        <div className="flex flex-col gap-0.5">
          {children(all, null).map((t) => (
            <Node key={t.id} t={t} depth={0} />
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-semibold text-sm">Trace {current ? current.slice(0, 12) : ""}</h2>
        {events.value ? <TraceList events={events.value} /> : <p className="text-xs text-zinc-500">loading…</p>}
      </section>
    </div>
  );
}
