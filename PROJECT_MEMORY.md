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
- User default Agent instructions are stored as `solopreneur.globalPrompt` and surfaced in both settings panels. They are injected into every roadmap-step Agent conversation, but the user's supplement in the current conversation always takes priority if there is a conflict.
- Project switcher areas should stay focused on project switching and adding folders. Do not reintroduce sidebar-level or full-header roadmap generation prompts; task-specific agent input belongs inside expanded roadmap node cards.
- The full roadmap view exposes a collapsed `调整路线图 / Revise Roadmap` action outside the project selector. It launches the same local Agent conversation flow at roadmap scope, keeps revision conversations in SQLite, and lets the user revise direction without treating revision as a fake roadmap step.
- A roadmap revision snapshots the existing `.solopreneur/roadmap.csv` before Agent execution. A revised CSV is accepted only after validating required fields, IDs, statuses, and dependencies; invalid or interrupted rewrites restore the previous roadmap and record a visible failure reason.
- The full roadmap view exposes a project-level `Solo` conversation action for issues or brainstorming that do not begin from a selected step. Solo runs are kept under the `__solo__` conversation scope, support optional in-project supplemental files, may succeed without file changes, and never update roadmap step status automatically.
- The sidebar exposes a Solo conversation card above the project portfolio. The card displays the current Solo project but does not provide a second project selector; users switch projects through the sidebar top project dropdown or by clicking a project portfolio card. The card lets the user choose Agent CLI and optional in-project supplemental files before sending, then stores the run in the current project's existing `__solo__` history without opening its roadmap view first. Selecting a project portfolio card must update the Solo target and clear previously selected attachments. The sidebar card displays only that project's most recent Solo conversation in the same summary/status/detail reading model as the full roadmap panel; full history remains in the full roadmap panel.
- A finished Solo conversation can be manually linked to an existing step as a `Linked` reference log. Linking preserves the original Solo history and adds context to the selected step without marking progress or completion; changing roadmap structure remains the responsibility of the revision action.
- Solo runs snapshot `.solopreneur/roadmap.csv` and restore it if the conversation changes the roadmap, so an unassigned conversation cannot silently alter planned work.
- Agent execution closure uses both the `.agent_status.json` watcher and a polling fallback. This prevents completed CLI runs from leaving node cards stuck in `Running` when VS Code misses a file watcher event.
- Agent run prompts are wrapped with Solopreneur task context, the user's per-run supplement, and explicit closure instructions so the CLI knows to deliver a small verifiable result and exit cleanly.
- Each Agent run should appear as one conversation. The extension creates one SQLite execution log when the run starts and updates that same row when the sentinel finishes; old launch-only `Running` rows are hidden once a later finished row exists for the same step.
- New project initialization seeds a runnable starter roadmap whose first step is `生成初始路线图`. The user describes the project inside that step conversation, and the selected local Agent rewrites `.solopreneur/roadmap.csv` through the same Agent task flow rather than a separate hosted generation path.
- Roadmap step completion is no longer equivalent to one successful Agent run. Successful CLI exit moves the step to `In Progress` unless the Agent writes the agreed completion decision JSON. Users can always close the loop manually through the step card's complete button.
- Each roadmap step keeps a project-local JSON handoff file at `.solopreneur/step-memory/<nodeId>.json`. After each Agent run, the extension appends a structured handoff entry with file changes, useful output signals, and completion judgment, keeping the latest 10 real entries. Agent prompts should tell the CLI to read this file and `.solopreneur/agent-runs/<nodeId>/` before working instead of injecting the handoff JSON body into the prompt.
- Each roadmap step also keeps per-Agent native session IDs in `.solopreneur/step-sessions/<nodeId>.json`, but Solopreneur should not force native resume anymore. New runs always start a fresh CLI invocation; the latest same-Agent session ID is exposed inside the prompt as an optional reference so the Agent can decide whether to inspect the previous conversation details.
- Saved session IDs are still updated after each run because they remain useful as optional references and for debugging native CLI behavior.
- Step handoff files must contain only real run entries. The parser/writer must dedupe entries by content and migrate old `.md` handoff files by stripping nested `# 环节交接总结` blocks so previous summaries cannot recursively copy themselves into future prompts.
- Webview node state and conversation history caches must be scoped by selected project path. Project switching must clear expanded node state and cached conversations because different projects often reuse the same roadmap node IDs.
- Solopreneur intentionally keeps project data inside the project folder under `.solopreneur/` so Git can manage it and the user can move between machines/IDEs without a Solopreneur backend. The extension must generate `.solopreneur/README.md` explaining the directory contents and deletion risk.
- Local Agent CLI discovery must treat Antigravity as the `agy` CLI first, while still supporting `antigravity`, `antigravity-cli`, `codex`, and `codex-cli`. Roadmap step composer runs are non-interactive and must exit so SoloMap can mark the conversation finished: `agy` / `antigravity-cli` use `--print --add-dir=<workspace> <prompt>` without a SoloMap-imposed print timeout.
- Antigravity/agy print mode can emit progress text while still returning a zero shell exit code. Solopreneur must not treat exit code alone as successful progress; a run needs project file changes or a completion decision before it can advance out of failure handling.

## CLI Orchestration Contract

- User-facing setting `solopreneur.cliPath` controls the local agent executable.
- `codex` and `codex-cli` task conversations must invoke non-interactive `codex exec --color always -C <workspace> --skip-git-repo-check -` from prompt stdin so the run exits and the step card can resolve its status.
- Step composer terminal output is captured with the simple `agent | tee output.log` path because this path is for bounded task execution, not native TUI interaction. Captured output tails must strip ANSI escape sequences before rendering in conversation history.
- Native TTY is only a user-controlled continuation action on an existing conversation with a recorded session ID. Codex continuation uses `codex resume -C <workspace> <sessionId>`; `agy` / `antigravity-cli` continuation uses `--conversation <sessionId> --prompt-interactive --add-dir=<workspace>`. This continuation does not write `.agent_status.json` and does not drive automatic step completion.
- Previous conversation IDs are not passed as forced resume parameters in normal step composer runs, and SoloMap should not add its own task timeout.
- Agent commands run in the opened workspace root, and the sentinel file is written with an absolute path so sidebar-only usage can still complete.
- If the configured/default CLI is unavailable, runtime discovery falls back to installed candidates such as `codex` before failing.
- Task dependencies describe roadmap order and support recommended-next-step selection, but they do not block a user from starting an Agent conversation in any step. Users must be able to explore, prepare, or revise downstream work before prior steps are completed.
- Before a step-card composer run, the extension calls `syncEngine.initAndSync()` so the selected conversation uses the latest `.solopreneur/roadmap.csv` node after roadmap revisions or external CSV edits.
- Agent execution uses `bash` plus `tee` for normal task runs so users see output while the extension captures it for the execution log. Native TTY continuation is a separate manual terminal action.
- Every Agent task conversation and native continuation must create a fresh VS Code terminal with a unique `SoloMap Agent Console · ...` name. Do not reuse a previous terminal by name, because later runs can inherit stale terminal/session state and fail to start correctly. `Open terminal` and `Stop` should target the current active SoloMap terminal name.
- Agent execution records touched project files outside `.solopreneur`, `.git`, and `node_modules`. If the CLI exits without project file changes and without a completion decision, the sentinel records `Failed` instead of silently advancing the roadmap step.
- Settings-panel CLI tests must use the same candidate ordering as Agent dispatch in both the full roadmap and sidebar webviews. The result message should show the actual resolved command so users know which local CLI will be used.
- Roadmap creation and revision use the local Agent conversation chain. New projects seed a starter roadmap first; later revision runs update `roadmap.csv` only after validation rather than depending on a separate hosted AI provider path.

## Regression Tests

- `npm test` compiles the extension and runs Node tests from `test/*.test.js`.
- `test/webview-regression.test.js` verifies the final generated Webview scripts parse, the settings gear opens the settings panel, CLI command construction keeps Codex and Antigravity paths distinct, runner scripts capture output/changes, and local roadmap fallback keeps dependency order.
- Regression coverage also checks that the full roadmap webview exposes node conversation history wiring and the language selector.
- Regression coverage checks that the sidebar project creation flow stays focused on the project switcher and that agent prompts include user supplements plus closure instructions.

## Packaging And Local Install

- Local or Marketplace VSIX builds must include runtime dependencies. Use `vsce package` / `vsce publish`, not `--no-dependencies`, because the extension imports `papaparse` and `sql.js` at activation time.
- `.vscodeignore` intentionally excludes source, docs, tests, env files, and project memory from the shipped extension.
- Code-server local dev install must not chain `node_modules` through versioned extension directories like `0.0.28-link -> 0.0.27-link -> ...`. That chain can break and leave activation stuck on Loading with `Cannot find module 'papaparse'`. Use the stable repo-backed installer `npm run install:local-dev`, which registers `szlk.solopreneur-roadmap-dev` and symlinks its runtime assets directly to the repo root.
