# forge-lab

A learning project: a paper-scout agent running on the TrueForge harness, used to understand how a third-party harness works compared with a custom one.

## Language

**Harness**:
The runtime around a model that turns it into a long-running agent: plans turns, routes tools, manages context, enforces approvals, persists sessions.
_Avoid_: framework, platform

**Paper Scout**:
The agent this repo builds. Finds, summarises and tracks research papers on the user's behalf.

**Agent**:
A saved, named configuration on the harness: model, instructions, tools, skills and sandbox it may use.
_Avoid_: bot, assistant

**Session**:
One conversation with an Agent, made of Turns, that persists across reconnects.
_Avoid_: chat, thread

**Turn**:
One user message and everything the Agent does in response, up to its final reply.

**Approval**:
A pause in a Turn where a human must allow or deny a sensitive tool call before it runs.

**Subagent**:
A child agent the Agent delegates a subtask to, so the subtask's detail stays out of the parent's context.

**Paper**:
A research publication identified by a stable source id (e.g. an arXiv id).

**Reading List**:
The user's saved set of Papers the Paper Scout is tracking.

**Harness Notes**:
The written comparison between TrueForge's design and the user's own custom harness.
