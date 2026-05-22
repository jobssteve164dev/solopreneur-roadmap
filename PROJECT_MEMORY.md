# Solopreneur Roadmap Project Memory

## Project Identity

- VS Code extension for local-first solopreneur project roadmaps and agent orchestration.
- Main extension entry: `src/extension.ts`.
- Sidebar webview provider: `src/sidebarProvider.ts`.
- Local project data directory created inside the opened workspace: `.solopreneur/`.

## Stable Runtime Facts

- Roadmap nodes are stored in `.solopreneur/roadmap.csv`.
- Execution logs are stored in `.solopreneur/project_journal.db` through `sql.js`.
- Agent completion is detected through `.agent_status.json` in the opened workspace root.
- The sidebar and full roadmap panel share the same `SyncEngine` instance and both receive node updates through `sendNodesToWebview()`.

## CLI Orchestration Contract

- User-facing setting `solopreneur.cliPath` controls the local agent executable.
- `codex` and `codex-cli` must be invoked through `codex exec -C <workspace> <prompt>`.
- `antigravity-cli` currently keeps the existing `run --task <prompt>` invocation shape.
- Agent commands run in the opened workspace root, and the sentinel file is written with an absolute path so sidebar-only usage can still complete.

## Regression Tests

- `npm test` compiles the extension and runs Node tests from `test/*.test.js`.
- `test/webview-regression.test.js` verifies the final generated Webview scripts parse, the settings gear opens the settings panel, and CLI command construction keeps Codex and Antigravity paths distinct.

## Packaging And Local Install

- `vsce package --no-dependencies` builds `solopreneur-roadmap-<version>.vsix`.
- `.vscodeignore` intentionally excludes source, docs, tests, env files, and project memory from the shipped extension.
