# forge-lab

A personal learning project: build an agent on the TrueForge harness to learn, in depth, how TrueForge works inside and the TypeScript it's written in.

## Language

**Harness**:
The runtime around a model that turns it into a long-running agent: plans turns, routes tools, manages context, enforces approvals, persists sessions.
_Avoid_: framework, platform

**Paper Scout**:
Candidate agent for this repo (the use case is being reconsidered). Finds, summarises and tracks research papers on the user's behalf.

**Agent**:
A saved, named configuration on the harness: model, instructions, tools, skills and sandbox it may use.
_Avoid_: bot, assistant

**Session**:
One conversation with an Agent, made of Turns, that persists across reconnects.
_Avoid_: chat, thread

**Turn**:
One user message and everything the Agent does in response, up to its final reply.

**Approval**:
A human's allow or deny decision on a sensitive tool call. The Turn ends while it waits, and the next Turn carries the decision.
_Avoid_: confirmation, permission prompt

**Subagent**:
A child agent the Agent delegates a subtask to, so the subtask's detail stays out of the parent's context.

**Paper**:
A research publication identified by a stable source id (e.g. an arXiv id).

**Reading List**:
The user's saved set of Papers the Paper Scout is tracking.

**Harness Notes**:
The user's own deep-dive notes on how TrueForge works inside, written while building on it. Not a comparison with other harnesses.
