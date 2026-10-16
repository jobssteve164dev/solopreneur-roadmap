---
name: solomap-cross-agent-handoff
description: Use SoloMap handoff evidence and execution history to take over work from another Agent CLI without repeating the previous run.
---

# SoloMap Cross-Agent Handoff

Use this skill when a task is continuing, reviewing, repairing, or coordinating work that may have been touched by another Agent CLI.

## Start Here

Use the formal `solomap_experience` MCP call in the current task prompt. The MCP session is already bound to the current project; do not provide or infer a database path.

Start with:

```json
{"action":"handoff","limit":3}
```

If the current task belongs to a known roadmap node, filter by node:

```json
{"action":"handoff","node":"<node-id>","limit":3}
```

## Drill Down

Call `solomap_experience` with these inputs only when the handoff pack is not enough:

```json
{"action":"summary"}
{"action":"failures","limit":5}
{"action":"latest-changes","limit":20}
{"action":"search","query":"<file-or-topic>","limit":5}
{"action":"history","node":"<node-id>","limit":5}
```

Each record includes a `sourceRef`. Read its complete source with `solomap_read({ref: sourceRef.objectId, revision: sourceRef.revision})`; for large content, use `view="content"` and follow every cursor until it is null. The command reads through the same SoloMap data tools as the task, and does not require opening a database or keeping old history files.

## Rules

- Treat the latest user request, current files, tests, and command output as higher priority than historical handoff data.
- Use handoff signals to avoid repeating already failed paths and to find the first files or commands worth checking.
- Do not assume a previous "Completed" run fully satisfies the current request. Verify against the current goal.
- Do not expose raw execution logs, prompt text, or internal run mechanics to ordinary users. Summarize only the useful outcome, changes, verification, and risks.
