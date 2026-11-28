// Reads the two machine-readable parts of an `<name>.expected.md` file (#12):
// the ids of its expectations and its Approval decision list. Everything else in
// the file is prose for the reader.
//
//   ## Expectations
//   - **E1** Persisted events start with turn.created ...
//
//   ## Approvals
//   - `fork_turn`: allow
//   - `cancel_session`: deny
//
// An Approvals section with no list items means "no Turn should pause"; a
// pause then stops the Experiment instead of being guessed at.

export type Decision = "allow" | "deny";

export type ExpectedFile = {
  expectationIds: string[];
  // Map: a key-value collection with any string keys and a typed value.
  approvals: Map<string, Decision>;
};

const EXPECTATION = /^- \*\*(E\d+)\*\*/;
const APPROVAL = /^- `([a-z][a-z0-9_]*)`: (allow|deny)\s*$/;

// The file is ours, but a typo in it would silently change what a script
// approves, so anything malformed throws instead of being skipped.
export function parseExpected(markdown: string): ExpectedFile {
  const expectationIds: string[] = [];
  const approvals = new Map<string, Decision>();
  const seen = new Set<string>();
  let section = "";
  let sawApprovals = false;

  for (const [index, line] of markdown.split("\n").entries()) {
    const where = `line ${index + 1}`;
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      if (section === "Approvals") sawApprovals = true;
      continue;
    }
    if (section === "Expectations") {
      const id = EXPECTATION.exec(line)?.[1];
      if (id === undefined) continue; // prose and continuation lines
      if (seen.has(id)) throw new Error(`${where}: expectation ${id} appears twice`);
      seen.add(id);
      expectationIds.push(id);
    } else if (section === "Approvals" && line.startsWith("- ")) {
      // Destructuring skips the whole match ([0]) with a leading comma.
      const [, tool, decision] = APPROVAL.exec(line) ?? [];
      if (tool === undefined || (decision !== "allow" && decision !== "deny"))
        throw new Error(`${where}: an Approval item must read "- \`tool_name\`: allow" or "deny"`);
      if (approvals.has(tool)) throw new Error(`${where}: ${tool} has two decisions`);
      approvals.set(tool, decision);
    }
  }
  if (expectationIds.length === 0) throw new Error("no expectations: add a `## Expectations` list of **E1** items");
  if (!sawApprovals) throw new Error("no `## Approvals` section: write one, even if no Turn should pause");
  return { expectationIds, approvals };
}
