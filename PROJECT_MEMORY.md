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
- Agent run output is captured under `.solopreneur/agent-runs/<nodeId>/output.log`.
- Git workspace change summaries are captured under `.solopreneur/agent-runs/<nodeId>/changes.txt`.
- The sidebar and full roadmap panel share the same `SyncEngine` instance and both receive node updates through `sendNodesToWebview()`.
- The sidebar provider must be registered before storage initialization starts. Storage initialization runs in the background so SQLite or workspace setup cannot leave the contributed view stuck on VS Code's Loading state.
- User settings are stored in `ExtensionContext.globalState` first, then mirrored to VS Code configuration. Do not rely only on `workspace.getConfiguration().update()` because code-server/global settings can be unavailable or stale across window reloads.
- Project folders are tracked in `ExtensionContext.globalState` under the Solopreneur project list. The active `SyncEngine` follows the selected project path, not necessarily the first VS Code workspace folder.
- The sidebar and full roadmap panel both expose a project dropdown plus an add-folder action so users can switch between multiple local projects.

## CLI Orchestration Contract

- User-facing setting `solopreneur.cliPath` controls the local agent executable.
- `codex` and `codex-cli` must be invoked through `codex exec -C <workspace> <prompt>`.
- `antigravity-cli` currently keeps the existing `run --task <prompt>` invocation shape.
- Agent commands run in the opened workspace root, and the sentinel file is written with an absolute path so sidebar-only usage can still complete.
- If the configured/default CLI is unavailable, runtime discovery falls back to installed candidates such as `codex` before failing.
- Task dependencies are enforced before running a node: dependent tasks must be `Completed`.
- Agent execution uses `bash -lc` plus `tee` so users see terminal output while the extension also captures it for the execution log.
- AI roadmap generation falls back to a local starter roadmap if the configured AI provider is unavailable or missing credentials, so the user can still continue the flow.

## Regression Tests

- `npm test` compiles the extension and runs Node tests from `test/*.test.js`.
- `test/webview-regression.test.js` verifies the final generated Webview scripts parse, the settings gear opens the settings panel, CLI command construction keeps Codex and Antigravity paths distinct, runner scripts capture output/changes, and local roadmap fallback keeps dependency order.

## Packaging And Local Install

- Local or Marketplace VSIX builds must include runtime dependencies. Use `vsce package` / `vsce publish`, not `--no-dependencies`, because the extension imports `papaparse` and `sql.js` at activation time.
- `.vscodeignore` intentionally excludes source, docs, tests, env files, and project memory from the shipped extension.
