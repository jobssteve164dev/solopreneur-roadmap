import * as childProcess from 'child_process';

import { CognitiveShadowEngine, CognitiveShadowInput, CognitiveShadowProposal } from './autonomousRuntime';

interface CommandRunner {
  run(command: string, args: string[], stdin: string): Promise<string>;
}

function runCommand(command: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.fromEntries(Object.entries({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        SystemRoot: process.env.SystemRoot,
        NO_COLOR: '1'
      }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Copilot shadow decision timed out.'));
    }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += String(chunk).slice(0, 65_536 - stdout.length); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 8_192 - stderr.length); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Copilot shadow decision failed (${code ?? 'unknown'}): ${stderr.trim()}`));
    });
    child.stdin.end(stdin);
  });
}

function parseProposal(value: string): CognitiveShadowProposal {
  const source = String(value || '').trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1);
  const parsed = JSON.parse(candidate);
  return {
    candidateId: String(parsed.candidateId || '').trim(),
    reason: String(parsed.reason || '').trim()
  };
}

function buildPrompt(input: CognitiveShadowInput): string {
  return [
    '你是 SoloMap 今日安排的只读决策器。',
    '只能从候选中选择今天最值得先推进的一项，不能创建任务、修改项目或调用工具。',
    '优先考虑：解除阻塞、形成完整结果、延续已有进展、减少无价值切换。',
    '只输出一行合法 JSON：{"candidateId":"候选 ID","reason":"给最终用户的一句简短理由"}',
    '候选：',
    JSON.stringify(input.candidates)
  ].join('\n');
}

export class CopilotCliShadowEngine implements CognitiveShadowEngine {
  public readonly id = 'copilot-cli';
  private readonly runner: CommandRunner;

  constructor(options?: CommandRunner) {
    this.runner = options || { run: runCommand };
  }

  public async plan(input: CognitiveShadowInput): Promise<CognitiveShadowProposal> {
    const output = await this.runner.run('copilot', [
      '-s',
      '--available-tools',
      '--disable-builtin-mcps',
      '--no-custom-instructions',
      '--no-ask-user',
      '--no-auto-update',
      '--no-color',
      '--model', 'auto'
    ], buildPrompt(input));
    const proposal = parseProposal(output);
    if (!input.candidates.some((candidate) => candidate.id === proposal.candidateId)) {
      throw new Error('Copilot selected an unknown Today arrangement candidate.');
    }
    if (!proposal.reason || proposal.reason.length > 240) {
      throw new Error('Copilot Today arrangement reason is missing or too long.');
    }
    return proposal;
  }
}
