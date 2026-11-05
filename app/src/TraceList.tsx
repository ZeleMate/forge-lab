// PROTOTYPE (#10): one Turn's persisted events, flattened into rows a learner can scan.
// Shared by variants B and C; it's a list renderer, not a layout.
import type { TfEvent } from "./api";

type Row = { t: string; tone: string; label: string; detail?: string };

// Tailwind classes per kind of row. `as const` keeps them as literal strings.
const TONE = {
  user: "border-sky-500",
  model: "border-zinc-400",
  tool: "border-emerald-500",
  approval: "border-amber-500 bg-amber-500/10",
  sub: "border-violet-500",
  compaction: "border-rose-500 bg-rose-500/10",
  turn: "border-zinc-700",
  other: "border-zinc-300",
} as const;

const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString() : "");

// Narrow `unknown` to a record before reading fields from it.
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function toRow(e: TfEvent): Row {
  const t = time(e.created_at);
  switch (e.type) {
    case "user.message":
      return { t, tone: TONE.user, label: "user.message" };
    case "model.message": {
      const msg = rec(e.message ?? e);
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const names = calls.map((c) => String(rec(rec(c).function).name ?? rec(c).name ?? "?"));
      const usage = rec(msg.usage ?? e.usage);
      const tokens = usage.total_tokens ? `${usage.total_tokens} tok` : "";
      return {
        t,
        tone: TONE.model,
        label: names.length ? `model → ${names.join(", ")}` : "model.message (text)",
        detail: tokens,
      };
    }
    case "tool.response":
      return { t, tone: TONE.tool, label: `tool.response ${String(e.name ?? e.tool_call_id ?? "")}` };
    case "tool.approval_required":
      return { t, tone: TONE.approval, label: "⏸ approval required", detail: "Turn ends here and waits" };
    case "user.tool_approval":
      return { t, tone: TONE.approval, label: `approval: ${String(e.decision ?? e.approved ?? "?")}` };
    case "thread.created":
      return { t, tone: TONE.sub, label: `subagent started ${String(e.thread_id ?? "")}` };
    case "thread.done":
      return { t, tone: TONE.sub, label: `subagent done ${String(e.thread_id ?? "")}` };
    case "agent.context.overwrite":
      return { t, tone: TONE.compaction, label: "♻ context overwritten", detail: String(e.reason ?? "") };
    case "turn.created":
    case "turn.done":
      return { t, tone: TONE.turn, label: e.type };
    default:
      return { t, tone: TONE.other, label: e.type };
  }
}

export function TraceList({ events }: { events: TfEvent[] }) {
  return (
    <ol className="space-y-1">
      {events.map((e, i) => {
        const r = toRow(e);
        return (
          <li key={e.id ?? i} className={`border-l-4 py-0.5 pl-2 font-mono text-xs ${r.tone}`}>
            <span className="text-zinc-500">{r.t}</span> {r.label}
            {r.detail ? <span className="text-zinc-500"> · {r.detail}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const color =
    status === "running"
      ? "bg-sky-600"
      : status === "paused"
        ? "bg-amber-600"
        : status === "error"
          ? "bg-rose-600"
          : status === "cancelled"
            ? "bg-zinc-500"
            : "bg-emerald-600";
  return <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] text-white ${color}`}>{status}</span>;
}
