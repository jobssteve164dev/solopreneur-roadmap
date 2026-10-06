import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import * as toml from '@iarna/toml';
const { parseTOML } = require('toml-eslint-parser');

export const databaseAgentProviders = ['codex', 'claude', 'cursor', 'copilot', 'opencode', 'grok', 'antigravity'] as const;
export type DatabaseAgentProvider = typeof databaseAgentProviders[number];
const databaseToolNames = ['solomap_context', 'solomap_search', 'solomap_read', 'solomap_write', 'solomap_link', 'solomap_export', 'solomap_migration_status', 'solomap_migration_retry', 'solomap_recycling_preview', 'solomap_recycling_apply', 'solomap_maintenance_finish'];
const start = '# SoloMap managed database MCP begin';
const end = '# SoloMap managed database MCP end';

export function agentDatabaseConfigPath(provider: DatabaseAgentProvider): string {
  if (provider === 'codex') return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  if (provider === 'claude') return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
  if (provider === 'copilot') return path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'mcp-config.json');
  if (provider === 'grok') return path.join(os.homedir(), '.grok', 'config.toml');
  if (provider === 'antigravity') return path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
  if (provider === 'opencode') {
    if (process.env.OPENCODE_CONFIG) return path.resolve(process.env.OPENCODE_CONFIG);
    const root = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
    const jsonc = path.join(root, 'opencode.jsonc');
    return fs.existsSync(jsonc) ? jsonc : path.join(root, 'opencode.json');
  }
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

export function isAgentDatabaseConfigPath(provider: DatabaseAgentProvider, file: unknown): file is string {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  if (provider === 'opencode') return /\.jsonc?$/.test(file);
  const basename = provider === 'codex' || provider === 'grok' ? 'config.toml' : provider === 'claude' ? '.claude.json' : provider === 'copilot' ? 'mcp-config.json' : provider === 'antigravity' ? 'mcp_config.json' : 'mcp.json';
  return path.basename(file) === basename;
}

export function databaseBridgeLauncher(): string {
  return 'const fs=require("node:fs"),path=require("node:path");const root=process.argv[1];try{const isolated=process.env.SOLOMAP_MAINTENANCE_ENTRY_PATH;let entry;if(isolated){entry=isolated;process.argv=[process.execPath,entry];}else{const endpoint=JSON.parse(fs.readFileSync(path.join(root,"runtime","control.json"),"utf8"));if(endpoint.schemaVersion!==1||!endpoint.entryPath||!path.isAbsolute(endpoint.entryPath)||path.basename(endpoint.entryPath)!=="autonomousRuntimeProcess.js")throw new Error("solomap_runtime_discovery_invalid");entry=path.join(path.dirname(endpoint.entryPath),"databaseMcpProcess.js");process.argv=[process.execPath,entry,"--global-data-path",root];}require(entry);}catch(error){process.stderr.write(String(error.message||error)+"\\n");process.exitCode=1;}';
}

/** Runtime serializes these patches; retain the CLI's native permission policy. */
export function configureAgentDatabase(options: { provider: DatabaseAgentProvider; configPath?: string; command: string; globalDataPath: string }): string {
  const file = options.configPath || agentDatabaseConfigPath(options.provider);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const args = ['-e', databaseBridgeLauncher(), normalizeGlobalDataPathForExtension(options.globalDataPath)];
    let next: string;
    if (options.provider === 'codex' || options.provider === 'grok') {
      const begin = original.indexOf(start);
      const finish = original.indexOf(end);
      if ((begin < 0) !== (finish < 0) || finish < begin || (begin >= 0 && (original.indexOf(start, begin + start.length) >= 0 || original.indexOf(end, finish + end.length) >= 0))) throw new Error('solomap_mcp_config_marker_invalid');
      const value = toml.parse(original) as any;
      const existing = value.mcp_servers?.solomap_data;
      const matchesKey = (key: { keys: Array<{ type: string; name?: string; value?: string }> }, name: string): boolean => key.keys.length === 1 && (key.keys[0].type === 'TOMLBare' ? key.keys[0].name : key.keys[0].value) === name;
      const parent = parseTOML(original, { tomlVersion: '1.0.0' }).body[0].body.find((node: any) => node.type === 'TOMLKeyValue' && matchesKey(node.key, 'mcp_servers'));
      const inline = parent?.value.type === 'TOMLInlineTable' ? parent.value : undefined;
      const owned = begin >= 0 ? (toml.parse(original.slice(begin, finish)) as any).mcp_servers?.solomap_data : inline && existing?.env?.SOLOMAP_MANAGED_BRIDGE === '1' ? existing : undefined;
      if (existing && !owned) throw new Error('solomap_mcp_config_name_conflict');
      const server = { ...owned, command: options.command, args, env: { ...owned?.env, ELECTRON_RUN_AS_NODE: '1', SOLOMAP_MANAGED_BRIDGE: '1' } };
      const block = [start, toml.stringify({ mcp_servers: { solomap_data: server } }).trimEnd(), end].join('\n');
      if (inline) {
        const field = inline.body.find((node: any) => matchesKey(node.key, 'solomap_data'));
        const body = toml.stringify.value(server);
        if (field) next = original.slice(0, field.value.range[0]) + body + original.slice(field.value.range[1]);
        else {
          const position = inline.range[1] - 1;
          next = original.slice(0, position) + (inline.body.length ? ', ' : '') + 'solomap_data = ' + body + original.slice(position);
        }
      } else if (begin >= 0) next = original.slice(0, begin) + block + original.slice(finish + end.length);
      else {
        next = original + (original.endsWith('\n') || !original ? '' : '\n') + '\n' + block + '\n';
      }
      toml.parse(next);
    } else {
      const errors: ParseError[] = [];
      const value = original ? parse(original, errors, { allowTrailingComma: true }) : {};
      const key = options.provider === 'opencode' ? 'mcp' : 'mcpServers';
      if (errors.length || !value || typeof value !== 'object' || Array.isArray(value) || (value[key] && (typeof value[key] !== 'object' || Array.isArray(value[key])))) throw new Error('agent_mcp_config_invalid');
      const existing = value[key]?.solomap_data;
      const environment = options.provider === 'opencode' ? 'environment' : 'env';
      if (existing && existing[environment]?.SOLOMAP_MANAGED_BRIDGE !== '1') throw new Error('solomap_mcp_config_name_conflict');
      const env = { ...existing?.[environment], ELECTRON_RUN_AS_NODE: '1', SOLOMAP_MANAGED_BRIDGE: '1' };
      const server = options.provider === 'opencode'
        ? { ...existing, type: 'local', command: [options.command, ...args], environment: env, enabled: existing?.enabled ?? true }
        : { ...existing, ...(options.provider === 'antigravity' ? {} : { type: options.provider === 'copilot' ? 'local' : 'stdio' }), command: options.command, args, env, ...(options.provider === 'copilot' ? { tools: [...new Set([...(Array.isArray(existing?.tools) ? existing.tools : []), ...databaseToolNames])] } : {}) };
      next = JSON.stringify(existing) === JSON.stringify(server) ? original : applyEdits(original || '{}\n', modify(original || '{}\n', [key, 'solomap_data'], server, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
    }
    if (next !== original) {
      fs.writeFileSync(temporary, next, { flag: 'wx', mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600 });
      if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== original) throw new Error('agent_mcp_config_changed_during_write');
      fs.renameSync(temporary, file);
    }
    return file;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function buildAgentDatabaseInstructions(): string {
  return [
    'SoloMap 数据库工具：',
    '- MCP 服务器 solomap_data 已接入当前 CLI；项目范围由当前工作目录绑定，不自行更换范围或直接操作数据库文件。',
    '- 开始工作时，按具体目标调用 solomap_context 获取相关项目记忆和可复用经验；需要历史记录时调用 solomap_search，使用返回的 objectId 调用 solomap_read。搜索结果和记忆不能覆盖当前用户要求或当前代码证据。',
    '- solomap_read 的 full 返回全文；大内容使用 view="content"，按返回的 cursor 继续读取，直到 cursor=null。需要复核旧版本时传 revision；不能把第一页当成完整内容。',
    '- 写入前调用 solomap_read({ref:"solomap://schema"}) 确认 kind、必填字段与引用，也可读取同名 MCP 资源。用 solomap_write 创建或修改记忆、记录；全局自动记忆不再创建 MD。新增 memory 使用 status="captured"，不要自行声明已验证或已审核。',
    '- 创建用 action="create"；修改先读取当前记录，传 objectId、expectedRevision 和 action="patch"，只提交本次变更字段。每次意图使用唯一 idempotencyKey，重试同一意图沿用该键；遇 revision_conflict 重新读取并协调差异，不能覆盖较新修改。',
    '- 以返回的 revision 和 committedSequence 确认提交，再用 solomap_read 即时回读；超时后先用同一 idempotencyKey 重试确认，不重复创建。证据关联使用 solomap_link；只有用户需要导出时使用 solomap_export。',
    '- 项目私有事实留在本项目。跨项目稳定规则和经验由现有授权复盘流程审核；召回不等于采用，未验证观察和临时交接不得冒充稳定经验。',
    '- 历史文件在后台迁移，不等待迁移完成才开展任务，不删除旧文件，不向旧记忆目录追加新记录。工具不可用时明确报告具体错误，不另建一套存储。'
  ].join('\n');
}
