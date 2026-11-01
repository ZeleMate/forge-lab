// Event types a Turn can emit. Long enough to test cutting a read to max_chars.
export const EVENT_TYPES = [
  "turn.created", // emitted when the turn created step happens in the loop
  "turn.started", // emitted when the turn started step happens in the loop
  "model.message", // emitted when the model message step happens in the loop
  "tool.call", // emitted when the tool call step happens in the loop
  "tool.response", // emitted when the tool response step happens in the loop
  "approval.required", // emitted when the approval required step happens in the loop
  "approval.granted", // emitted when the approval granted step happens in the loop
  "approval.denied", // emitted when the approval denied step happens in the loop
  "subagent.created", // emitted when the subagent created step happens in the loop
  "subagent.finished", // emitted when the subagent finished step happens in the loop
  "compaction.started", // emitted when the compaction started step happens in the loop
  "compaction.finished", // emitted when the compaction finished step happens in the loop
  "sandbox.exec", // emitted when the sandbox exec step happens in the loop
  "sandbox.output", // emitted when the sandbox output step happens in the loop
  "mcp.initialize", // emitted when the mcp initialize step happens in the loop
  "mcp.tools_listed", // emitted when the mcp tools_listed step happens in the loop
  "turn.cancelled", // emitted when the turn cancelled step happens in the loop
  "turn.error", // emitted when the turn error step happens in the loop
  "turn.done", // emitted when the turn done step happens in the loop
  "user.message", // emitted when the user message step happens in the loop
] as const;
