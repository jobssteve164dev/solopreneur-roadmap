import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import * as toml from '@iarna/toml';
import { replaceRegularFileIfUnchanged } from './safeFileReplace';
const { parseTOML } = require('toml-eslint-parser');

export const databaseAgentProviders = ['codex', 'claude', 'cursor', 'copilot', 'opencode', 'grok', 'antigravity'] as const;
export type DatabaseAgentProvider = typeof databaseAgentProviders[number];
const databaseToolNames = ['solomap_context', 'solomap_memory', 'solomap_experience', 'solomap_search', 'solomap_read', 'solomap_write', 'solomap_link', 'solomap_export', 'solomap_migration_start', 'solomap_migration_status', 'solomap_migration_retry', 'solomap_recycling_preview', 'solomap_recycling_apply'];
const start = '# SoloMap managed database MCP begin';
const end = '# SoloMap managed database MCP end';
export const codexDatabaseProfile = 'solomap';

export function codexDatabaseProfilePath(codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))): string {
  return path.join(codexHome, `${codexDatabaseProfile}.config.toml`);
}

export function retireManagedCodexBaseConfig(codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))): boolean {
  const file = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(file)) return false;
  const original = fs.readFileSync(file, 'utf8');
  const begin = original.indexOf(start), finish = original.indexOf(end);
  if (begin < 0 && finish < 0) return false;
  if (begin < 0 || finish < begin || original.indexOf(start, begin + start.length) >= 0 || original.indexOf(end, finish + end.length) >= 0) throw new Error('solomap_mcp_config_marker_invalid');
  const next = original.slice(0, begin) + original.slice(finish + end.length);
  if (next !== original) {
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, next, { flag: 'wx', mode: fs.statSync(file).mode & 0o777 });
      replaceRegularFileIfUnchanged(file, temporary, original);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return true;
}

export function agentDatabaseConfigPath(provider: DatabaseAgentProvider): string {
  if (provider === 'codex') return codexDatabaseProfilePath();
  if (provider === 'claude') {
    const home = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).normalize('NFC');
    const legacy = path.join(home, '.config.json');
    return fs.existsSync(legacy) ? legacy : path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
  }
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
  if (provider === 'claude' && path.basename(file) === '.config.json') return true;
  if (provider === 'codex') return ['config.toml', `${codexDatabaseProfile}.config.toml`].includes(path.basename(file));
  const basename = provider === 'grok' ? 'config.toml' : provider === 'claude' ? '.claude.json' : provider === 'copilot' ? 'mcp-config.json' : provider === 'antigravity' ? 'mcp_config.json' : 'mcp.json';
  return path.basename(file) === basename;
}

export function databaseBridgeLauncher(): string {
  return 'const fs=require("node:fs"),path=require("node:path");const root=process.argv[1],sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));(async()=>{const deadline=Date.now()+10000;let entry;for(;;){try{const endpoint=JSON.parse(fs.readFileSync(path.join(root,"runtime","control.json"),"utf8"));if(endpoint.schemaVersion!==1||!endpoint.entryPath||!path.isAbsolute(endpoint.entryPath)||path.basename(endpoint.entryPath)!=="autonomousRuntimeProcess.js")throw new Error("solomap_runtime_discovery_invalid");entry=path.join(path.dirname(endpoint.entryPath),"databaseMcpProcess.js");fs.accessSync(entry,fs.constants.R_OK);break;}catch(error){if(error&&error.code==="ENOENT"&&Date.now()<deadline){await sleep(50);continue;}throw error;}}process.argv=[process.execPath,entry,"--global-data-path",root];require(entry);})().catch(error=>{process.stderr.write(String(error.message||error)+"\\n");process.exitCode=1;});';
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
      if (options.provider === 'codex') Object.assign(server, { env_vars: [...(Array.isArray(owned?.env_vars) ? owned.env_vars : []), ...[
        'SOLOMAP_PROJECT_ID',
        'SOLOMAP_EXECUTION_LOG_ID',
        'SOLOMAP_RUN_GENERATION',
        'SOLOMAP_RUN_PROOF',
        'SOLOMAP_RUN_KIND'
      ].filter(name => !owned?.env_vars?.includes(name))] });
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
      try { replaceRegularFileIfUnchanged(file, temporary, original); }
      catch (error) {
        if ((error as Error).message === 'file_changed_during_write') throw new Error('agent_mcp_config_changed_during_write');
        throw error;
      }
    }
    return file;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function buildAgentDatabaseInstructions(options: { migrationTools?: boolean; readOnly?: boolean; contextProvided?: boolean } = {}): string {
  const shared = [
    'SoloMap 数据库记忆系统（每个任务必须执行）：',
    '- SoloMap 数据库工具通过 MCP 服务器 solomap_data 提供；项目范围由当前工作目录绑定，不自行更换范围或直接操作数据库文件。',
    options.contextProvided
      ? '- SoloMap 已根据当前用户目标和当前项目绑定加载本轮相关记忆，并在下方提供固定版本上下文；先使用该上下文，不需要为了启动再次调用 MCP。上下文不足时，用 solomap_memory 检索记忆、用 solomap_experience 检索经验或交接，再按固定版本引用调用 solomap_read。'
      : '- 每个任务开始时，根据当前用户目标和当前项目绑定构造简洁 query；在实现或判断前先调用 solomap_context 获取相关上下文，也可分别用 solomap_memory 和 solomap_experience 检索记忆与经验。需要完整历史记录时调用 solomap_experience 或 solomap_search，并用返回的 objectId 和固定 revision 调用 solomap_read。',
    '- solomap_read 的 full 返回全文；大内容使用 view="content"，按返回的 cursor 继续读取，直到 cursor=null。需要复核旧版本时传 revision；不能把第一页当成完整内容。',
    '- 召回结果只用于定位入口和证据；搜索结果和记忆不能覆盖当前用户要求或当前代码证据，也不能覆盖当前日志和测试；没有命中不阻断任务。',
    '- 旧全局 Markdown 记忆目录仅是迁移来源；运行任务不得依赖它、不得恢复它、不得追加新记录，也不得另建平行存储。'
  ];
  if (options.readOnly) return [
    ...shared,
    '- 本轮对数据库记忆仅可检索和读取相关记录，不得通过记忆工具写入或改变数据库；发现可复用结论时只在结果中说明，由有写权限的正式任务决定是否沉淀。',
    '- 工具不可用时明确报告具体错误，不用旧文件或其他存储绕过。'
  ].join('\n');
  return [
    ...shared,
    '- 写入前调用 solomap_read({ref:"solomap://schema"}) 确认 kind、必填字段与引用。用 solomap_write 创建或修改记忆、记录；新增 memory 使用 status="captured"，不要自行声明已验证或已审核。',
    '- 创建用 action="create"；修改先读取当前记录，传 objectId、expectedRevision 和 action="patch"，只提交本次变更字段。每次意图使用唯一 idempotencyKey，重试同一意图沿用该键；遇 revision_conflict 重新读取并协调差异，不能覆盖较新修改。',
    '- 以返回的 revision 和 committedSequence 确认提交，再用 solomap_read 即时回读；超时后先用同一 idempotencyKey 重试确认，不重复创建。证据关联使用 solomap_link；只有用户需要导出时使用 solomap_export。',
    '- 任务收尾时，只把已经验证且未来任务仍会复用的偏好、规则、项目事实、决策或交接写入正确作用域；原始日志、一次性输出、临时观察和未经验证猜测不得写成稳定记忆。',
    '- 项目私有事实留在本项目。跨项目稳定规则和经验由现有授权复盘流程审核；召回不等于采用，未验证观察和临时交接不得冒充稳定经验。',
    options.migrationTools ? '- 用户要求迁移当前项目旧数据时，先用 solomap_migration_status 读取摘要，再用 solomap_migration_start 发现并加入迁移；每个 jobId 都要读取详情，queued 或 running 时持续查询到终态，failed 或 interrupted 时按详情重试。completed_with_conflicts 不得原样重试；仅在来源或目标已变化，或当前版本明确修复该冲突且本轮尚未重试时重试一次，相同冲突再次出现就保留详情。单个来源仍有冲突时继续处理其他任务并生成当前安全回收清单，且不得把冲突来源列入清单。单次工具失败后必须先重读状态；只有状态读取连续 3 次失败才报告连接阻塞，同时说明任务仍可能在后台运行，不得宣称迁移失败。完成对账后用 solomap_recycling_preview 生成精确回收清单。必须传当前项目绝对路径；普通对话只生成清单，回收仍由界面逐项确认。' : '',
    '- 历史文件在后台迁移，不等待迁移完成才开展任务。工具不可用时明确报告具体错误，不另建一套存储。'
  ].filter(Boolean).join('\n');
}
