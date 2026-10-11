---
name: solomap-cross-agent-handoff
description: Use SoloMap handoff evidence and execution history to take over work from another Agent CLI without repeating the previous run.
---

# SoloMap Cross-Agent Handoff

Use this skill when a task is continuing, reviewing, repairing, or coordinating work that may have been touched by another Agent CLI.

## Start Here

Use the handoff command in the current task prompt. It includes the tool location and the data root for this run. Keep its `--project` and `--global` arguments when changing the subcommand or adding filters.

For a project using the default data root, run from the project root:

```bash
node resources/tools/solomap-experience.cjs handoff --project . --limit 3
```

If the current task belongs to a known roadmap node, filter by node:

```bash
node resources/tools/solomap-experience.cjs handoff --project . --node <node-id> --limit 3
```

## Drill Down

Use these commands only when the handoff pack is not enough:

```bash
node resources/tools/solomap-experience.cjs summary --project .
node resources/tools/solomap-experience.cjs failures --project . --limit 5
node resources/tools/solomap-experience.cjs latest-changes --project . --limit 20
node resources/tools/solomap-experience.cjs search --project . --query "<file-or-topic>" --limit 5
node resources/tools/solomap-experience.cjs history --project . --node <node-id> --limit 5
```

Add `--json` when you need structured output. Add `--full` only when summarized signals are insufficient; raw execution logs can be long and should not be pasted into the final user response.

Each record includes a `sourceRef`. Read its complete source with `solomap_read({ref: sourceRef.objectId, revision: sourceRef.revision})`; for large content, use `view="content"` and follow every cursor until it is null. The command reads through the same SoloMap data tools as the task, and does not require opening a database or keeping old history files.

## Rules

- Treat the latest user request, current files, tests, and command output as higher priority than historical handoff data.
- Use handoff signals to avoid repeating already failed paths and to find the first files or commands worth checking.
- Do not assume a previous "Completed" run fully satisfies the current request. Verify against the current goal.
- Do not expose raw execution logs, prompt text, or internal run mechanics to ordinary users. Summarize only the useful outcome, changes, verification, and risks.
