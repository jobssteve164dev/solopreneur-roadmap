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
- Full roadmap node cards are collapsed by default. Expanding a node reads that node's SQLite `execution_logs` and presents each agent run as a conversation-like history item with command/output details, so users manage agent work from the roadmap step instead of treating each step as a one-shot dispatch.
- Expanded roadmap node cards include a per-run Agent selector next to the send button. This lets the user choose which local Agent CLI joins this conversation without changing the node's default Agent setting.
- Display language is a persisted user setting (`solopreneur.language`, `zh` or `en`) and must be applied consistently in both the sidebar and full roadmap webviews.
- Project switcher areas should stay focused on project switching and adding folders. Do not reintroduce sidebar-level or full-header roadmap generation prompts; task-specific agent input belongs inside expanded roadmap node cards.
- Agent execution closure uses both the `.agent_status.json` watcher and a polling fallback. This prevents completed CLI runs from leaving node cards stuck in `Running` when VS Code misses a file watcher event.
- Agent run prompts are wrapped with Solopreneur task context, the user's per-run supplement, and explicit closure instructions so the CLI knows to deliver a small verifiable result and exit cleanly.
- Each Agent run should appear as one conversation. The extension creates one SQLite execution log when the run starts and updates that same row when the sentinel finishes; old launch-only `Running` rows are hidden once a later finished row exists for the same step.
- After selecting a new project folder, Solopreneur asks for an optional project idea. If provided, AI roadmap generation uses a fixed four-stage framework (`商业规划` / `品牌与设置` / `产品与 MVP` / `营销与增长`) while customizing node titles, descriptions, dependencies, and agent prompts to the user's idea. Empty input keeps the default roadmap.
- Roadmap step completion is no longer equivalent to one successful Agent run. Successful CLI exit moves the step to `In Progress` unless the Agent writes the agreed completion decision JSON. Users can always close the loop manually through the step card's complete button.
- Each roadmap step keeps a project-local JSON handoff file at `.solopreneur/step-memory/<nodeId>.json`. After each Agent run, the extension appends a structured handoff entry with file changes, useful output signals, and completion judgment, keeping the latest 10 real entries. Agent prompts should tell the CLI to read this file and `.solopreneur/agent-runs/<nodeId>/` before working instead of injecting the handoff JSON body into the prompt.
- Each roadmap step also keeps per-Agent native session IDs in `.solopreneur/step-sessions/<nodeId>.json`, but Solopreneur should not force native resume anymore. New runs always start a fresh CLI invocation; the latest same-Agent session ID is exposed inside the prompt as an optional reference so the Agent can decide whether to inspect the previous conversation details.
- Saved session IDs are still updated after each run because they remain useful as optional references and for debugging native CLI behavior.
- Step handoff files must contain only real run entries. The parser/writer must dedupe entries by content and migrate old `.md` handoff files by stripping nested `# 环节交接总结` blocks so previous summaries cannot recursively copy themselves into future prompts.
- Webview node state and conversation history caches must be scoped by selected project path. Project switching must clear expanded node state and cached conversations because different projects often reuse the same roadmap node IDs.
- Solopreneur intentionally keeps project data inside the project folder under `.solopreneur/` so Git can manage it and the user can move between machines/IDEs without a Solopreneur backend. The extension must generate `.solopreneur/README.md` explaining the directory contents and deletion risk.
- Local Agent CLI discovery must treat Antigravity as the `agy` CLI first, while still supporting `antigravity`, `antigravity-cli`, `codex`, and `codex-cli`. `agy` and `antigravity-cli` run non-interactively through `--print --add-dir=<workspace> <prompt>` without a SoloMap-imposed print timeout.
- Antigravity/agy print mode can emit progress text while still returning a zero shell exit code. Solopreneur must not treat exit code alone as successful progress; a run needs project file changes or a completion decision before it can advance out of failure handling.

## CLI Orchestration Contract

- User-facing setting `solopreneur.cliPath` controls the local agent executable.
- `codex` and `codex-cli` sessions must be invoked through `codex exec -C <workspace> <prompt>`, even when a previous same-step session ID exists.
- `agy` / `antigravity-cli` sessions use the `--print --add-dir=<workspace> <prompt>` shape for every run. Previous conversation IDs are not passed as forced `--conversation` arguments, and SoloMap should not add its own task timeout.
- Agent commands run in the opened workspace root, and the sentinel file is written with an absolute path so sidebar-only usage can still complete.
- If the configured/default CLI is unavailable, runtime discovery falls back to installed candidates such as `codex` before failing.
- Task dependencies are enforced before running a node: dependent tasks must be `Completed`.
- Agent execution uses `bash -lc` plus `tee` so users see terminal output while the extension also captures it for the execution log.
- Agent execution records touched project files outside `.solopreneur`, `.git`, and `node_modules`. If the CLI exits without project file changes and without a completion decision, the sentinel records `Failed` instead of silently advancing the roadmap step.
- Settings-panel CLI tests must use the same candidate ordering as Agent dispatch in both the full roadmap and sidebar webviews. The result message should show the actual resolved command so users know which local CLI will be used.
- AI roadmap generation falls back to a local starter roadmap if the configured AI provider is unavailable or missing credentials, so the user can still continue the flow.

## Regression Tests

- `npm test` compiles the extension and runs Node tests from `test/*.test.js`.
- `test/webview-regression.test.js` verifies the final generated Webview scripts parse, the settings gear opens the settings panel, CLI command construction keeps Codex and Antigravity paths distinct, runner scripts capture output/changes, and local roadmap fallback keeps dependency order.
- Regression coverage also checks that the full roadmap webview exposes node conversation history wiring and the language selector.
- Regression coverage checks that the sidebar project creation flow stays focused on the project switcher and that agent prompts include user supplements plus closure instructions.

## Packaging And Local Install

- Local or Marketplace VSIX builds must include runtime dependencies. Use `vsce package` / `vsce publish`, not `--no-dependencies`, because the extension imports `papaparse` and `sql.js` at activation time.
- `.vscodeignore` intentionally excludes source, docs, tests, env files, and project memory from the shipped extension.
- Code-server local dev install must not chain `node_modules` through versioned extension directories like `0.0.28-link -> 0.0.27-link -> ...`. That chain can break and leave activation stuck on Loading with `Cannot find module 'papaparse'`. Use the stable repo-backed installer `npm run install:local-dev`, which registers `szlk.solopreneur-roadmap-dev` and symlinks its runtime assets directly to the repo root.
