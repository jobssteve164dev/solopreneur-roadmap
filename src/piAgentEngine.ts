import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { getAgentCliFamily, resolveAgentCliWithinFamily } from './agentCli';
import { CognitiveShadowEngine, CognitiveShadowInput, CognitiveShadowProposal } from './autonomousRuntime';
import {
  buildCognitiveCliInvocation,
  CognitiveCliInvocation,
  CognitiveCliRunner,
  parseCognitiveDecisionProposal,
  runCognitiveCliInvocation
} from './localAgentCliEngine';

type PiAgentModule = {
  Agent: new (options: Record<string, unknown>) => {
    state: { messages: Array<Record<string, unknown>> };
    prompt(input: string): Promise<void>;
    abort(): void;
  };
};

type PiAiModule = {
  createAssistantMessageEventStream(): {
    push(event: Record<string, unknown>): void;
  };
};

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

async function loadPi(): Promise<{ agent: PiAgentModule; ai: PiAiModule }> {
  const bundled = await dynamicImport(pathToFileURL(path.join(__dirname, 'piAgentRuntime.mjs')).href);
  return { agent: bundled as PiAgentModule, ai: bundled as PiAiModule };
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is { type: string; text: string } => Boolean(item && typeof item === 'object' && (item as any).type === 'text'))
    .map(item => String(item.text || ''))
    .join('\n');
}

function transcriptPrompt(context: { messages?: Array<Record<string, unknown>> }): string {
  return (context.messages || []).map((message) => {
    const role = String(message.role || 'user').toUpperCase();
    return `${role}:\n${messageText(message)}`;
  }).filter(block => block.trim()).join('\n\n');
}

function emptyUsage(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function assistantMessage(model: string, content: string, stopReason: 'pending' | 'stop' | 'error' | 'aborted', errorMessage = ''): Record<string, unknown> {
  return {
    role: 'assistant',
    content: content ? [{ type: 'text', text: content }] : [],
    api: 'agent-cli',
    provider: 'agent-cli',
    model,
    usage: emptyUsage(),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now()
  };
}

function embeddedModel(model: string): Record<string, unknown> {
  return {
    id: model || 'auto',
    name: `Agent CLI ${model || 'auto'}`,
    api: 'agent-cli',
    provider: 'agent-cli',
    baseUrl: 'local-agent-cli://model-pipe',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192
  };
}

export class EmbeddedPiAgentEngine implements CognitiveShadowEngine {
  public readonly framework = '@earendil-works/pi-agent-core';
  public readonly id: string;
  private readonly agentCli: string;
  private readonly model: string;
  private readonly workingDirectory?: string;
  private readonly runner: CognitiveCliRunner;
  private cancelInvocation?: () => void;
  private activeAgent?: { abort(): void };
  private cancelled = false;

  constructor(options: { agentCli: string; model?: string; configRevision?: string; workingDirectory?: string; runner?: CognitiveCliRunner }) {
    this.agentCli = options.runner ? options.agentCli : resolveAgentCliWithinFamily(options.agentCli, options.agentCli);
    this.model = String(options.model || 'auto');
    this.workingDirectory = options.workingDirectory;
    this.runner = options.runner || ((invocation: CognitiveCliInvocation) => runCognitiveCliInvocation(invocation, cancel => { this.cancelInvocation = cancel; }));
    this.id = `pi-agent:agent-cli:${getAgentCliFamily(this.agentCli)}:${this.model}:${String(options.configRevision || 'unversioned')}`;
  }

  public async plan(input: CognitiveShadowInput): Promise<CognitiveShadowProposal> {
    this.cancelled = false;
    if (this.workingDirectory) fs.mkdirSync(this.workingDirectory, { recursive: true });
    const pi = await loadPi();
    if (this.cancelled) throw new Error('Pi Agent model pipe was cancelled.');
    const model = embeddedModel(this.model);
    const agent = new pi.agent.Agent({
      initialState: {
        systemPrompt: '你是 SoloMap 今日安排的只读决策器。只能选择候选，不得调用工具、读取文件或执行任务。',
        model,
        tools: []
      },
      streamFn: (_selectedModel: unknown, context: { messages?: Array<Record<string, unknown>> }) => {
        const stream = pi.ai.createAssistantMessageEventStream();
        if (this.cancelled) {
          const cancelledMessage = assistantMessage(this.model, '', 'aborted', 'Pi Agent model pipe was cancelled.');
          stream.push({ type: 'error', reason: 'aborted', error: cancelledMessage });
          return stream;
        }
        const partial = assistantMessage(this.model, '', 'pending');
        stream.push({ type: 'start', partial });
        const invocation = buildCognitiveCliInvocation(this.agentCli, this.model, transcriptPrompt(context), this.workingDirectory);
        void this.runner(invocation).then((output) => {
          const finalMessage = assistantMessage(this.model, output, 'stop');
          stream.push({ type: 'done', reason: 'stop', message: finalMessage });
        }, (error) => {
          const message = error instanceof Error ? error.message : String(error);
          const finalMessage = assistantMessage(this.model, '', 'error', message);
          stream.push({ type: 'error', reason: 'error', error: finalMessage });
        });
        return stream;
      }
    });
    this.activeAgent = agent;
    try {
      await agent.prompt([
        '从候选中选择今天最值得先推进的一项。',
        '只输出一行合法 JSON：{"candidateId":"候选 ID","reason":"给最终用户的一句简短理由"}',
        JSON.stringify(input.candidates)
      ].join('\n'));
      const response = [...agent.state.messages].reverse().find(message => message.role === 'assistant');
      if (!response) throw new Error('Pi Agent did not return a decision.');
      let proposal: CognitiveShadowProposal;
      try {
        proposal = parseCognitiveDecisionProposal(messageText(response));
      } catch {
        throw new Error('Pi Agent model pipe did not return a valid JSON decision.');
      }
      if (!input.candidates.some(candidate => candidate.id === proposal.candidateId) || !proposal.reason || proposal.reason.length > 240) {
        throw new Error('Pi Agent model pipe did not return a valid JSON decision.');
      }
      return proposal;
    } finally {
      this.activeAgent = undefined;
      this.cancelInvocation = undefined;
    }
  }

  public cancel(): void {
    this.cancelled = true;
    this.activeAgent?.abort();
    this.cancelInvocation?.();
  }
}
