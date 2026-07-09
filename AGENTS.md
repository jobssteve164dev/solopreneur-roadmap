# Agent Instructions

## Project

SoloMap is a VS Code extension and local-first project roadmap cockpit for solo developers. Keep changes small, verifiable, and aligned with the current product boundary.

## Working Rules

- Preserve the user's requested scope. Do not change roadmap state, project boundaries, product naming, release behavior, or documentation structure unless explicitly asked.
- Read the relevant files before judging current behavior. Treat memory and old notes as context, not as stronger evidence than code, tests, logs, or current user input.
- Do not overwrite existing files when the task only asks to create missing files.
- Prefer focused patches over broad rewrites or opportunistic refactors.
- Keep user-facing UI and copy action-oriented. Avoid internal implementation language, template explanations, or maintainer-facing wording in product surfaces.

## Validation

- For extension code changes, run `npm run compile` and the narrow relevant Node tests; use `npm test` when the impact is shared.
- For website dependency or deploy-path changes, run the narrow `website` check that matches the change and note any required secrets or environment files.
- For workflow or configuration changes, verify the final YAML or configuration file can be parsed and that referenced scripts exist.

## Git

- Do not revert unrelated user changes.
- If the user asked for an implementation change, commit and push the completed work unless they explicitly ask not to.
