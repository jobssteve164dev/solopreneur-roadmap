export function buildAgentCliUpgradePrompt(resultFilePath: string): string {
  return [
    'Upgrade every Agent CLI currently installed on this machine to its latest stable version.',
    '',
    'Scope:',
    '- Detect installed Agent CLIs, including agy, Codex, Claude Code, Cursor CLI, GitHub Copilot CLI, and OpenCode.',
    '- For each installed CLI, identify how that exact installation is managed and use its official supported upgrade path.',
    '- Do not install CLIs that are not already installed.',
    '- Preserve user configuration, authentication, plugins, skills, MCP connections, and project files.',
    '- Verify each upgraded CLI by reading its version after the upgrade.',
    '- If this Agent CLI itself must be upgraded, do it last so the rest of the work can finish first.',
    '- Continue with the remaining installed CLIs if one upgrade fails.',
    '',
    `When finished, write UTF-8 JSON to ${JSON.stringify(resultFilePath)} with this shape:`,
    '{"success":true,"message":"short user-facing summary","upgraded":[{"name":"CLI name","before":"version","after":"version"}],"unchanged":[{"name":"CLI name","version":"version","reason":"already latest or no supported upgrade path"}],"failed":[{"name":"CLI name","reason":"actionable failure"}]}',
    'Set success to false only when one or more installed CLIs could not be checked or upgraded. Always write the result file before exiting.'
  ].join('\n');
}
