import * as fs from 'fs';
import * as path from 'path';
import * as Papa from 'papaparse';
import { readLearningSummary } from './learningLedger';
import { readProjectInvestmentStats } from './projectAnalytics';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

export interface StrategyPyramidProject {
  name: string;
  path: string;
  type?: string;
  priority?: string;
  description?: string;
  notes?: string;
  pinnedAt?: string;
}

export interface StrategyPyramidNodeSummary {
  id: string;
  title: string;
  stage: string;
  status: string;
}

export interface StrategyPyramidProjectSummary {
  name: string;
  path: string;
  type: string;
  role: string;
  businessStage: string;
  revenueTier: string;
  timeLoad: string;
  strategicRelation: string;
  loop: MethodologyStageKey;
  action: string;
  risk: string;
  evidence: string[];
  abilities: string[];
  roleScores: StrategyPyramidProjectRoleScores;
  advice: StrategyPyramidProjectAdvice;
  completedNodes: number;
  failedNodes: number;
  runningNodes: number;
  inProgressNodes: number;
  pendingNodes: number;
  totalNodes: number;
  progressPercent: number;
  nodes: StrategyPyramidNodeSummary[];
}

export interface StrategyPyramidLoopSummary {
  key: MethodologyStageKey;
  label: string;
  title: string;
  count: number;
  projectNames: string[];
  judgment: string;
}

export interface StrategyPyramidLayerSummary {
  key: string;
  title: string;
  health: 'strong' | 'watch' | 'risk';
  signal: string;
  action: string;
  evidence: string[];
}

export interface StrategyPyramidMoveSummary {
  horizon: string;
  title: string;
  reason: string;
  evidence: string[];
}

export interface StrategyPyramidAbilitySummary {
  name: string;
  projectCount: number;
  projectNames: string[];
  value: string;
  judgment: string;
}

export interface StrategyPyramidProjectRoleScores {
  abilityAccumulation: number;
  revenueContribution: number;
  marketTrust: number;
  reusePotential: number;
  brandValue: number;
}

export interface StrategyPyramidProjectAdvice {
  doubleDown: string;
  reduce: string;
  observe: string;
}

export interface StrategyPyramidStageProfile {
  title: string;
  priorityLayer: string;
  keyMetric: string;
  defaultQuestion: string;
}

export interface StrategyPyramidStructureSignal {
  key: string;
  title: string;
  summary: string;
  health: 'strong' | 'watch' | 'risk';
  evidence: string[];
}

export interface StrategyPyramidRiskSignal {
  severity: 'high' | 'medium' | 'healthy';
  title: string;
  summary: string;
  evidence: string[];
}

export interface StrategyPyramidLearningSignal {
  projectName: string;
  projectPath: string;
  eventCount: number;
  candidateCount: number;
  promotedCount: number;
  latestAt: string;
  riskSignals: number;
  verificationSignals: number;
  strategySignals: number;
}

export interface StrategyPyramidScenario {
  key: string;
  title: string;
  investment: string;
  returnProfile: string;
  cost: string;
  risk: string;
  timeline: string;
  summary: string;
}

export interface StrategyPyramidSnapshot {
  generatedAt: string;
  confidence: 'low' | 'medium' | 'high';
  stageTitle: string;
  stageProfile: StrategyPyramidStageProfile;
  mainJudgment: string;
  strategicAction: string;
  constraint: string;
  totalProjects: number;
  buildCount: number;
  sellCount: number;
  learnCount: number;
  improveCount: number;
  risks: string[];
  loops: StrategyPyramidLoopSummary[];
  layers: StrategyPyramidLayerSummary[];
  moves: StrategyPyramidMoveSummary[];
  abilities: StrategyPyramidAbilitySummary[];
  structureSignals: StrategyPyramidStructureSignal[];
  riskSignals: StrategyPyramidRiskSignal[];
  opportunitySignals: StrategyPyramidRiskSignal[];
  learningSignals: StrategyPyramidLearningSignal[];
  scenarios: StrategyPyramidScenario[];
  recommendedScenarioPath: string;
  projects: StrategyPyramidProjectSummary[];
}

export type MethodologyStageKey = 'build' | 'sell' | 'learn' | 'improve';

function normalizeGlobalDataPath(rawPath: string): string {
  return normalizeGlobalDataPathForExtension(rawPath);
}

function readStrategyRoadmapNodes(projectPath: string): StrategyPyramidNodeSummary[] {
  const csvPath = path.join(projectPath, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(csvPath)) {
    return [];
  }
  try {
    const csv = fs.readFileSync(csvPath, 'utf8');
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    return (parsed.data || [])
      .filter((row) => row && (row.id || row.title))
      .map((row) => ({
        id: String(row.id || row.title || ''),
        title: String(row.title || row.id || ''),
        stage: String(row.stage || ''),
        status: String(row.status || 'Pending')
      }));
  } catch (error) {
    console.warn(`Failed to read strategy pyramid roadmap for ${projectPath}:`, error);
    return [];
  }
}

export function classifyStrategyLoop(node: StrategyPyramidNodeSummary): MethodologyStageKey {
  const text = `${node.stage} ${node.title}`.toLowerCase();
  if (/sell|sale|sales|market|marketing|growth|launch|revenue|pricing|收费|销售|营销|增长|发布|收入|定价/.test(text)) {
    return 'sell';
  }
  if (/learn|feedback|signal|interview|review|measure|复盘|反馈|学习|访谈|信号|数据|验证/.test(text)) {
    return 'learn';
  }
  if (/improve|iterate|polish|optimi[sz]e|fix|scale|改进|迭代|优化|修复|规模/.test(text)) {
    return 'improve';
  }
  return 'build';
}

function labelStrategyLoop(key: MethodologyStageKey): string {
  return {
    build: 'Build',
    sell: 'Sell',
    learn: 'Learn',
    improve: 'Improve'
  }[key];
}

function titleStrategyLoop(key: MethodologyStageKey): string {
  return {
    build: '产品与交付',
    sell: '收入与市场',
    learn: '学习与反馈',
    improve: '改进与复利'
  }[key];
}

function inferDominantStrategyLoop(nodes: StrategyPyramidNodeSummary[]): MethodologyStageKey {
  const counts: Record<MethodologyStageKey, number> = { build: 0, sell: 0, learn: 0, improve: 0 };
  for (const node of nodes) {
    counts[classifyStrategyLoop(node)] += 1;
  }
  const ordered: MethodologyStageKey[] = ['sell', 'learn', 'improve', 'build'];
  return ordered.sort((a, b) => counts[b] - counts[a])[0] || 'build';
}

function inferProjectAbilities(project: StrategyPyramidProject, nodes: StrategyPyramidNodeSummary[]): string[] {
  const text = `${project.name} ${project.type || ''} ${nodes.map((node) => `${node.stage} ${node.title}`).join(' ')}`.toLowerCase();
  const abilities: string[] = [];
  const add = (label: string, pattern: RegExp) => {
    if (pattern.test(text) && !abilities.includes(label)) {
      abilities.push(label);
    }
  };
  add('AI 产品编排', /ai|agent|llm|prompt|codex|claude|智能体|大模型|代理|编排/);
  add('CLI 与开发者工具', /cli|terminal|command|vscode|extension|插件|命令行|开发者工具/);
  add('Web 产品交付', /web|website|frontend|react|next|vue|官网|前端|页面/);
  add('订阅与商业化', /stripe|passport|billing|subscription|pricing|pro|订阅|付费|收费|定价|商业化/);
  add('内容与分发', /content|blog|seo|wechat|video|newsletter|内容|文章|宣发|渠道|分发/);
  add('基础设施与自动化', /infra|cloud|worker|deploy|ci|github actions|mcp|数据库|基础设施|自动化|部署/);
  add('反馈与研究', /feedback|learn|research|review|interview|用户|反馈|研究|访谈|复盘/);
  return abilities.slice(0, 4);
}

function inferStrategyRole(project: StrategyPyramidProject, nodes: StrategyPyramidNodeSummary[]): string {
  const type = String(project.type || '').trim();
  const stages = nodes.map((node) => node.stage).join(' ');
  if (type === 'core_product') return '核心产品';
  if (type === 'content') return '内容资产';
  if (type === 'infrastructure' || /基础|架构|infra|cloud|平台/i.test(`${project.name} ${stages}`)) return '能力底座';
  if (type === 'maintenance' || /维护|归档|稳定|修复/i.test(`${project.name} ${stages}`)) return '稳定维护';
  if (type === 'experiment' || /实验|试验|研究|验证/i.test(`${project.name} ${stages}`)) return '机会验证';
  return '推进项目';
}

function countProjectLoops(nodes: StrategyPyramidNodeSummary[]): Record<MethodologyStageKey, number> {
  const counts: Record<MethodologyStageKey, number> = { build: 0, sell: 0, learn: 0, improve: 0 };
  for (const node of nodes) {
    counts[classifyStrategyLoop(node)] += 1;
  }
  return counts;
}

function inferBusinessStage(project: StrategyPyramidProject, nodes: StrategyPyramidNodeSummary[]): string {
  const loops = countProjectLoops(nodes);
  const completed = nodes.filter((node) => node.status === 'Completed').length;
  if (/archive|frozen|归档|冻结/i.test(`${project.type || ''} ${project.name}`)) return 'sunset';
  if (loops.sell > 0 && loops.learn > 0) return completed > 0 ? 'commercial_validation' : 'validation';
  if (loops.learn > 0) return 'validation';
  if (loops.sell > 0) return 'commercial_validation';
  if (loops.build > 0) return 'build';
  return 'idea';
}

function inferRevenueTier(project: StrategyPyramidProject, nodes: StrategyPyramidNodeSummary[]): string {
  const loops = countProjectLoops(nodes);
  if (loops.sell === 0) return 'unknown';
  if (project.type === 'core_product') return 'unknown';
  return 'unknown';
}

function inferTimeLoadFromCounts(runningNodes: number, inProgressNodes: number, failedNodes: number, totalNodes: number): string {
  if (failedNodes > 0 || runningNodes + inProgressNodes >= 2) return 'high';
  if (runningNodes + inProgressNodes === 1 || totalNodes >= 6) return 'medium';
  if (totalNodes > 0) return 'low';
  return 'unknown';
}

function inferTimeLoad(actualMinutes: number, runningNodes: number, inProgressNodes: number, failedNodes: number, totalNodes: number): string {
  if (actualMinutes > 120 || failedNodes > 0 || runningNodes + inProgressNodes >= 2) return 'high';
  if (actualMinutes >= 30 || runningNodes + inProgressNodes === 1 || totalNodes >= 6) return 'medium';
  if (actualMinutes > 0 || totalNodes > 0) return 'low';
  return 'unknown';
}

function inferStrategicRelation(role: string, abilities: string[], nodes: StrategyPyramidNodeSummary[]): string {
  const loops = countProjectLoops(nodes);
  if (role === '核心产品') return '高：承载收入、信誉和能力复利的主线';
  if (abilities.length >= 2 && loops.improve + loops.learn > 0) return '高：能力可跨项目复用';
  if (abilities.length > 0 || loops.sell + loops.learn > 0) return '中：已有可复用或市场信号';
  return '低：仍需验证它与整体系统的关系';
}

function inferProjectRoleScores(
  project: StrategyPyramidProject,
  nodes: StrategyPyramidNodeSummary[],
  abilities: string[],
  role: string
): StrategyPyramidProjectRoleScores {
  const loops = countProjectLoops(nodes);
  const completed = nodes.filter((node) => node.status === 'Completed').length;
  const score = (value: number) => Math.max(1, Math.min(5, value));
  return {
    abilityAccumulation: score(1 + Math.min(3, abilities.length) + (loops.improve > 0 ? 1 : 0)),
    revenueContribution: score(1 + Math.min(3, loops.sell) + (project.type === 'core_product' ? 1 : 0)),
    marketTrust: score(1 + Math.min(2, loops.learn) + (loops.sell > 0 ? 1 : 0) + (completed > 0 ? 1 : 0)),
    reusePotential: score(1 + Math.min(3, abilities.length) + (loops.improve > 0 ? 1 : 0)),
    brandValue: score(1 + (role === '核心产品' ? 2 : 0) + (loops.sell > 0 ? 1 : 0) + (loops.learn > 0 ? 1 : 0))
  };
}

function inferProjectAdvice(summary: Pick<StrategyPyramidProjectSummary, 'role' | 'nodes' | 'abilities' | 'failedNodes' | 'progressPercent'>): StrategyPyramidProjectAdvice {
  const hasSell = summary.nodes.some((node) => classifyStrategyLoop(node) === 'sell');
  const hasLearn = summary.nodes.some((node) => classifyStrategyLoop(node) === 'learn');
  const lowReuse = summary.abilities.length === 0 && summary.progressPercent < 40;
  return {
    doubleDown: summary.role === '核心产品' || hasSell
      ? '加码商业化验证、渠道建设和能沉淀信誉的交付'
      : '只加码能补市场反馈或复用能力的切片',
    reduce: summary.failedNodes > 0
      ? '收缩失败环节外的新增建设，先让阻塞收口'
      : lowReuse
        ? '减少一次性建设和低复利维护'
        : '收缩重复支持、临时修补和不产生学习信号的投入',
    observe: hasLearn
      ? '观察反馈是否能转成定价、转化或明确取舍'
      : '观察它是否继续占用新收入源验证时间'
  };
}

function inferStrategyAction(summary: Pick<StrategyPyramidProjectSummary, 'failedNodes' | 'runningNodes' | 'inProgressNodes' | 'progressPercent' | 'nodes'>): string {
  if (summary.failedNodes > 0) return '先收口失败点';
  if (summary.runningNodes > 0 || summary.inProgressNodes > 0) return '继续当前推进';
  if (summary.progressPercent >= 80) return '复盘价值，决定加码或收缩';
  if (!summary.nodes.some((node) => classifyStrategyLoop(node) === 'sell' || classifyStrategyLoop(node) === 'learn')) {
    return '补一个销售或学习信号';
  }
  return '推进下一个可验证切片';
}

function inferStrategyRisk(summary: Pick<StrategyPyramidProjectSummary, 'failedNodes' | 'nodes' | 'progressPercent'>): string {
  if (summary.failedNodes > 0) return '交付阻塞';
  if (!summary.nodes.some((node) => classifyStrategyLoop(node) === 'sell')) return '缺少销售动作';
  if (!summary.nodes.some((node) => classifyStrategyLoop(node) === 'learn')) return '缺少学习信号';
  if (summary.progressPercent >= 80) return '需要投入决策';
  return '';
}

function inferProjectEvidence(summary: Pick<StrategyPyramidProjectSummary, 'totalNodes' | 'completedNodes' | 'runningNodes' | 'inProgressNodes' | 'failedNodes' | 'nodes'>): string[] {
  const evidence: string[] = [];
  if (summary.totalNodes === 0) {
    evidence.push('还没有可读取的路线图信号');
  } else {
    evidence.push(`${summary.completedNodes}/${summary.totalNodes} 个环节已完成`);
  }
  if (summary.runningNodes + summary.inProgressNodes > 0) {
    evidence.push('当前有推进中的环节');
  }
  if (summary.failedNodes > 0) {
    evidence.push('存在失败环节');
  }
  if (!summary.nodes.some((node) => classifyStrategyLoop(node) === 'sell')) {
    evidence.push('缺少销售动作');
  }
  if (!summary.nodes.some((node) => classifyStrategyLoop(node) === 'learn')) {
    evidence.push('缺少学习信号');
  }
  return evidence.slice(0, 3);
}

function buildLoopSummaries(projects: StrategyPyramidProjectSummary[], allNodes: StrategyPyramidNodeSummary[]): StrategyPyramidLoopSummary[] {
  const keys: MethodologyStageKey[] = ['build', 'sell', 'learn', 'improve'];
  return keys.map((key) => {
    const count = allNodes.filter((node) => classifyStrategyLoop(node) === key).length;
    const projectNames = projects
      .filter((project) => project.loop === key || project.nodes.some((node) => classifyStrategyLoop(node) === key))
      .map((project) => project.name)
      .slice(0, 5);
    const judgment = count === 0
      ? `${labelStrategyLoop(key)} 信号不足`
      : projectNames.length > 0
        ? `${projectNames.length} 个项目形成 ${labelStrategyLoop(key)} 信号`
        : `${count} 个 ${labelStrategyLoop(key)} 信号`;
    return {
      key,
      label: labelStrategyLoop(key),
      title: titleStrategyLoop(key),
      count,
      projectNames,
      judgment
    };
  });
}

function buildAbilitySummaries(projects: StrategyPyramidProjectSummary[]): StrategyPyramidAbilitySummary[] {
  const abilityProjects = new Map<string, Set<string>>();
  for (const project of projects) {
    for (const ability of project.abilities) {
      if (!abilityProjects.has(ability)) {
        abilityProjects.set(ability, new Set());
      }
      abilityProjects.get(ability)?.add(project.name);
    }
  }
  return [...abilityProjects.entries()]
    .map(([name, projectSet]) => {
      const projectCount = projectSet.size;
      const projectNames = [...projectSet].sort((a, b) => a.localeCompare(b));
      return {
        name,
        projectCount,
        projectNames,
        value: projectCount >= 3 ? '高' : projectCount >= 2 ? '中高' : '观察',
        judgment: projectCount >= 2 ? '继续加码并对外表达' : '已有信号，继续观察'
      };
    })
    .sort((a, b) => b.projectCount - a.projectCount || a.name.localeCompare(b.name))
    .slice(0, 6);
}

function buildStageProfile(stageTitle: string, projects: StrategyPyramidProjectSummary[]): StrategyPyramidStageProfile {
  if (projects.length <= 2) {
    return {
      title: stageTitle,
      priorityLayer: '底层：能力库 + 市场发现渠道',
      keyMetric: '是否能接近第一个付费用户',
      defaultQuestion: '我应该集中在哪个细分方向？'
    };
  }
  if (projects.length >= 6) {
    return {
      title: stageTitle,
      priorityLayer: '上层：可复利收入 + 系统自动化',
      keyMetric: '总投入时间是否可持续',
      defaultQuestion: '哪些部分应该自动化、委托或冻结？'
    };
  }
  return {
    title: stageTitle,
    priorityLayer: '中层：项目组合 + 收入结构',
    keyMetric: '哪些项目在积累复利，哪些在消耗注意力',
    defaultQuestion: '应该加码、收缩还是暂停？'
  };
}

function inferStrategyStage(projects: StrategyPyramidProjectSummary[], buildCount: number, sellCount: number, learnCount: number): string {
  if (projects.length === 0) return '起步定向期';
  if (projects.some((project) => project.failedNodes > 0)) return '结构收口期';
  if (projects.length <= 2) return sellCount + learnCount > 0 ? '早期验证期' : '集中建设期';
  if (buildCount > sellCount + learnCount + 1) return 'Build 偏重期';
  if (projects.length >= 6) return '组合治理期';
  return '组合成长期';
}

function inferMainJudgment(projects: StrategyPyramidProjectSummary[], buildCount: number, sellCount: number, learnCount: number): string {
  if (projects.length === 0) return '还没有形成项目组合，先把一个能接近付费用户的项目推进到可验证状态。';
  if (projects.some((project) => project.failedNodes > 0)) return '当前组合的第一优先级不是继续扩张，而是收口失败环节，避免风险拖累核心产品。';
  if (sellCount === 0 && learnCount === 0) return '项目组合正在积累建设动作，但还没有形成足够的销售和学习信号。';
  if (buildCount > sellCount + learnCount + 1) return 'Build 信号明显偏重，继续新增功能会降低商业化验证效率。';
  if (!projects.some((project) => project.type === 'core_product' || project.role === '核心产品')) return '组合已有多个推进点，但缺少一个明确承载收入、信誉和能力复利的核心产品。';
  return '组合已经具备跨项目推进信号，下一步应让收入、反馈和能力复用互相增强。';
}

function inferPortfolioStrategicAction(projects: StrategyPyramidProjectSummary[], sellCount: number, learnCount: number): string {
  if (projects.length === 0) return '选择一个最接近付费用户的问题，先推进到可演示切片。';
  if (projects.some((project) => project.failedNodes > 0)) return '先收口阻塞，再决定哪些项目值得继续加码。';
  if (sellCount === 0 || learnCount === 0) return '加码核心产品的商业化验证，补上销售与反馈信号。';
  if (!projects.some((project) => project.type === 'core_product' || project.role === '核心产品')) return '选出一个核心产品承载收入验证，其他项目围绕它复用能力。';
  return '围绕核心产品建立第二收入源假设，并减少低复利维护投入。';
}

function inferPortfolioConstraint(projects: StrategyPyramidProjectSummary[], buildCount: number, sellCount: number, learnCount: number): string {
  if (projects.length === 0) return '不要先铺多个方向，先让一个项目产生真实反馈。';
  if (buildCount > sellCount + learnCount + 1) return '未来 30 天减少新功能建设，把时间转向商业化验证和用户反馈。';
  if (projects.filter((project) => project.totalNodes === 0).length > 0) return '没有路线图信号的项目先不要加码，避免项目数量制造虚假的安全感。';
  return '新增项目必须复用已有能力或补上收入缺口，否则先暂停孵化。';
}

function buildStrategyLayers(
  projects: StrategyPyramidProjectSummary[],
  buildCount: number,
  sellCount: number,
  learnCount: number,
  improveCount: number,
  abilities: StrategyPyramidAbilitySummary[]
): StrategyPyramidLayerSummary[] {
  const hasCore = projects.some((project) => project.type === 'core_product' || project.role === '核心产品');
  const activeProjects = projects.filter((project) => project.runningNodes + project.inProgressNodes > 0).length;
  const reusableAbilities = abilities.filter((ability) => ability.projectCount >= 2).length;
  const health = (ok: boolean, watch: boolean): 'strong' | 'watch' | 'risk' => ok ? 'strong' : watch ? 'watch' : 'risk';
  return [{
    key: 'freedom-brand',
    title: '自由选择与个人品牌',
    health: health(hasCore && (sellCount > 0 || learnCount > 0), hasCore),
    signal: hasCore ? '已有核心产品承载信誉积累。' : '核心产品尚未明确，品牌信号容易分散。',
    action: hasCore ? '继续把市场反馈沉淀到核心产品。' : '先选出最能代表长期方向的核心产品。',
    evidence: hasCore ? ['存在核心产品标记或核心产品角色'] : ['未识别到核心产品角色']
  }, {
    key: 'revenue-system',
    title: '可复利收入系统',
    health: health(sellCount >= 2, sellCount === 1),
    signal: sellCount > 0 ? `${sellCount} 个收入或市场动作可继续验证。` : '还没有可读取的收入验证动作。',
    action: sellCount > 0 ? '把销售动作接到明确的升级或付费路径。' : '补一个低成本销售实验，不继续只做功能。',
    evidence: [`${sellCount} 个 Sell 阶段信号`]
  }, {
    key: 'market-trust',
    title: '市场覆盖与信誉',
    health: health(learnCount >= 2, learnCount === 1 || sellCount > 0),
    signal: learnCount > 0 ? `${learnCount} 个学习信号可用于下一轮改进。` : '用户反馈和市场学习信号不足。',
    action: learnCount > 0 ? '把反馈转成下一轮取舍，而不是继续堆需求。' : '补一次真实用户反馈或公开分发验证。',
    evidence: [`${learnCount} 个 Learn 阶段信号`]
  }, {
    key: 'ability-compounding',
    title: '能力系统与产品交付',
    health: health(reusableAbilities > 0 && improveCount > 0, abilities.length > 0 || activeProjects > 0),
    signal: reusableAbilities > 0 ? `${reusableAbilities} 项能力正在跨项目复用。` : '能力复用还没有形成稳定信号。',
    action: reusableAbilities > 0 ? '把可复用能力产品化或品牌化。' : '标记能跨项目复用的能力，减少一次性建设。',
    evidence: [`${abilities.length} 项能力标签`, `${improveCount} 个 Improve 阶段信号`]
  }, {
    key: 'reality-inventory',
    title: '现实锚点与投资库存',
    health: health(projects.length > 0 && buildCount + sellCount + learnCount + improveCount > 0, projects.length > 0),
    signal: projects.length > 0 ? `${projects.length} 个项目进入组合视野。` : '还没有项目进入组合视野。',
    action: projects.length > 0 ? '冻结低复利项目，把注意力留给核心验证。' : '先登记一个真实项目，形成第一组战略信号。',
    evidence: [`${projects.length} 个本地登记项目`, `${activeProjects} 个当前推进项目`]
  }];
}

function buildStrategyMoves(projects: StrategyPyramidProjectSummary[], sellCount: number, learnCount: number, abilities: StrategyPyramidAbilitySummary[]): StrategyPyramidMoveSummary[] {
  const moves: StrategyPyramidMoveSummary[] = [];
  if (projects.length === 0) {
    moves.push({ horizon: '未来 30 天', title: '推进一个可演示切片', reason: '先让战略判断有真实项目和用户反馈可依赖。', evidence: ['未读取到已登记项目'] });
  } else if (sellCount === 0 || learnCount === 0) {
    moves.push({ horizon: '未来 30 天', title: '补齐商业化与反馈验证', reason: '当前组合的建设动作多于市场信号，继续 Build 会放大战略盲区。', evidence: [`${sellCount} 个 Sell 信号`, `${learnCount} 个 Learn 信号`] });
  } else {
    moves.push({ horizon: '未来 30 天', title: '把核心项目推向更清晰的付费路径', reason: '已有市场与反馈信号，下一步要让收入验证闭环。', evidence: [`${sellCount} 个 Sell 信号`, `${learnCount} 个 Learn 信号`] });
  }
  if (projects.some((project) => project.failedNodes > 0)) {
    moves.push({ horizon: '本季度', title: '收口失败环节', reason: '失败环节会吞噬注意力，先处理再加码。', evidence: ['存在失败环节'] });
  } else {
    moves.push({ horizon: '本季度', title: '减少低复利维护投入', reason: '组合价值来自复利关系，不来自项目数量。', evidence: [`${projects.length} 个项目进入组合`] });
  }
  if (abilities.some((ability) => ability.projectCount >= 2)) {
    moves.push({ horizon: '本季度', title: '把复用能力变成对外可表达的卖点', reason: '跨项目复用能力已经出现，适合沉淀成产品、模板或内容资产。', evidence: abilities.filter((ability) => ability.projectCount >= 2).map((ability) => ability.name).slice(0, 3) });
  } else {
    moves.push({ horizon: '本季度', title: '识别一个可跨项目复用的能力', reason: '没有能力复利时，多项目会更容易变成维护负担。', evidence: ['尚未识别跨项目复用能力'] });
  }
  return moves.slice(0, 4);
}

function buildStructureSignals(
  projects: StrategyPyramidProjectSummary[],
  loops: StrategyPyramidLoopSummary[],
  abilities: StrategyPyramidAbilitySummary[]
): StrategyPyramidStructureSignal[] {
  const loopCount = (key: MethodologyStageKey) => loops.find((loop) => loop.key === key)?.count || 0;
  const buildCount = loopCount('build');
  const sellCount = loopCount('sell');
  const learnCount = loopCount('learn');
  const heavyTimeProjects = projects.filter((project) => project.timeLoad === 'high');
  const reusableAbilities = abilities.filter((ability) => ability.projectCount >= 2);
  const high = (health: StrategyPyramidStructureSignal['health']) => health;
  return [{
    key: 'portfolio',
    title: '项目组合',
    health: high(projects.length === 0 ? 'risk' : buildCount > sellCount + learnCount + 1 ? 'watch' : 'strong'),
    summary: projects.length === 0
      ? '还没有项目进入战略组合。'
      : buildCount > sellCount + learnCount + 1
        ? 'Build 偏重，Sell / Learn 信号不足。'
        : 'Build / Sell / Learn / Improve 已形成可判断结构。',
    evidence: loops.map((loop) => `${loop.label}: ${loop.count}`)
  }, {
    key: 'time',
    title: '时间结构',
    health: high(heavyTimeProjects.length > 0 ? 'risk' : projects.some((project) => project.timeLoad === 'medium') ? 'watch' : 'strong'),
    summary: heavyTimeProjects.length > 0
      ? '已有项目显示高时间负担，可能挤压第二收入源验证。'
      : '未读取到明显高负担项目，但仍需用推进记录持续观察。',
    evidence: heavyTimeProjects.length ? heavyTimeProjects.map((project) => `${project.name}: ${project.timeLoad}`) : ['基于推进中、失败和路线图数量推断']
  }, {
    key: 'ability',
    title: '能力复利',
    health: high(reusableAbilities.length > 0 ? 'strong' : abilities.length > 0 ? 'watch' : 'risk'),
    summary: reusableAbilities.length > 0
      ? '已有能力在跨项目复用，适合沉淀为产品卖点或内容资产。'
      : abilities.length > 0
        ? '能力信号已出现，但跨项目复用还不稳定。'
        : '尚未识别稳定能力复利信号。',
    evidence: reusableAbilities.length ? reusableAbilities.map((ability) => `${ability.name}: ${ability.projectCount} 项目`) : ['来自项目类型、阶段标题和路线图文本']
  }, {
    key: 'trust',
    title: '市场信誉',
    health: high(learnCount >= 2 ? 'strong' : learnCount + sellCount > 0 ? 'watch' : 'risk'),
    summary: learnCount > 0
      ? '已有反馈或学习信号，但渠道、评价和转化仍需要更硬证据。'
      : '市场信誉信号不足，当前判断不能假装已有品牌增长。',
    evidence: [`${learnCount} 个 Learn 信号`, `${sellCount} 个 Sell 信号`]
  }];
}

function buildRiskSignals(projects: StrategyPyramidProjectSummary[], sellCount: number, learnCount: number, buildCount: number): StrategyPyramidRiskSignal[] {
  const signals: StrategyPyramidRiskSignal[] = [];
  const failedProjects = projects.filter((project) => project.failedNodes > 0);
  if (failedProjects.length > 0) {
    signals.push({
      severity: 'high',
      title: '结构高风险',
      summary: '存在失败环节，继续扩张会放大维护负担。',
      evidence: failedProjects.map((project) => `${project.name}: ${project.failedNodes} 个失败环节`)
    });
  }
  if (projects.length > 0 && buildCount > sellCount + learnCount + 1) {
    signals.push({
      severity: 'medium',
      title: '中等结构风险',
      summary: 'Build 偏重，商业化与反馈验证不足。',
      evidence: [`Build: ${buildCount}`, `Sell: ${sellCount}`, `Learn: ${learnCount}`]
    });
  }
  if (projects.length > 1 && !projects.some((project) => project.type === 'core_product' || project.role === '核心产品')) {
    signals.push({
      severity: 'medium',
      title: '中等结构风险',
      summary: '组合缺少明确核心产品，收入、信誉和能力复利容易分散。',
      evidence: [`${projects.length} 个项目`, '未识别核心产品角色']
    });
  }
  if (signals.length === 0) {
    signals.push({
      severity: 'healthy',
      title: '健康结构信号',
      summary: '没有读取到高风险阻塞，可以继续围绕核心验证推进。',
      evidence: [`${projects.length} 个项目`, `${sellCount} 个 Sell 信号`, `${learnCount} 个 Learn 信号`]
    });
  }
  return signals.slice(0, 4);
}

function buildOpportunitySignals(projects: StrategyPyramidProjectSummary[], abilities: StrategyPyramidAbilitySummary[]): StrategyPyramidRiskSignal[] {
  const reusable = abilities.filter((ability) => ability.projectCount >= 2);
  const coreProjects = projects.filter((project) => project.role === '核心产品');
  const signals: StrategyPyramidRiskSignal[] = [];
  if (reusable.length > 0) {
    signals.push({
      severity: 'healthy',
      title: '结构机会',
      summary: '跨项目能力已经出现，可以转成模板、内容资产、服务产品化或核心卖点。',
      evidence: reusable.map((ability) => `${ability.name}: ${ability.projectNames.join(' / ')}`).slice(0, 3)
    });
  }
  if (coreProjects.length > 0) {
    signals.push({
      severity: 'healthy',
      title: '结构机会',
      summary: '核心产品可作为收入、信誉和能力复利的统一承载点。',
      evidence: coreProjects.map((project) => project.name).slice(0, 3)
    });
  }
  if (signals.length === 0) {
    signals.push({
      severity: 'medium',
      title: '结构机会',
      summary: '先让一个项目形成明确市场反馈，再判断是否值得加码。',
      evidence: ['当前本地事实不足以识别稳定机会']
    });
  }
  return signals.slice(0, 3);
}

function buildLearningStructureSignal(learningSignals: StrategyPyramidLearningSignal[]): StrategyPyramidStructureSignal {
  const riskCount = learningSignals.reduce((sum, item) => sum + Number(item.riskSignals || 0), 0);
  const verificationCount = learningSignals.reduce((sum, item) => sum + Number(item.verificationSignals || 0), 0);
  const promotedCount = learningSignals.reduce((sum, item) => sum + Number(item.promotedCount || 0), 0);
  const candidateCount = learningSignals.reduce((sum, item) => sum + Number(item.candidateCount || 0), 0);
  return {
    key: 'learning',
    title: '学习闭环',
    health: riskCount > promotedCount + verificationCount ? 'risk' : verificationCount + promotedCount > 0 ? 'strong' : candidateCount > 0 ? 'watch' : 'risk',
    summary: riskCount > promotedCount + verificationCount
      ? '学习线索里未收口风险偏多，加码前应先确认哪些会影响本周动作。'
      : verificationCount + promotedCount > 0
        ? '已有验证或已确认经验进入组合判断，可以支撑下一轮加码/收缩。'
        : candidateCount > 0
          ? '学习线索已出现，但还缺少已验证或已确认的复用结论。'
          : '尚未读取到可进入战略判断的学习线索。',
    evidence: learningSignals.length
      ? learningSignals.slice(0, 4).map((item) => `${item.projectName}: ${item.candidateCount} 候选 / ${item.riskSignals} 风险 / ${item.verificationSignals} 验证`)
      : ['统一学习主线尚无项目级信号']
  };
}

function buildLearningRiskSignals(learningSignals: StrategyPyramidLearningSignal[]): StrategyPyramidRiskSignal[] {
  const riskProjects = learningSignals.filter((item) => Number(item.riskSignals || 0) > Number(item.verificationSignals || 0) + Number(item.promotedCount || 0));
  if (!riskProjects.length) {
    return [];
  }
  return [{
    severity: 'medium',
    title: '学习未收口风险',
    summary: '部分项目的失败、偏航或待确认经验还没有被验证经验抵消，加码前应先收口。',
    evidence: riskProjects.slice(0, 4).map((item) => `${item.projectName}: ${item.riskSignals} 个风险信号，${item.verificationSignals} 个验证信号`)
  }];
}

function buildLearningOpportunitySignals(learningSignals: StrategyPyramidLearningSignal[]): StrategyPyramidRiskSignal[] {
  const verifiedProjects = learningSignals.filter((item) => Number(item.verificationSignals || 0) + Number(item.promotedCount || 0) > 0);
  if (!verifiedProjects.length) {
    return [];
  }
  return [{
    severity: 'healthy',
    title: '学习复利机会',
    summary: '已有验证过的执行经验可以反哺路线图、项目优先级和下一轮执行计划。',
    evidence: verifiedProjects.slice(0, 4).map((item) => `${item.projectName}: ${item.verificationSignals} 个验证信号，${item.promotedCount} 个已确认经验`)
  }];
}

function buildStrategyScenarios(projects: StrategyPyramidProjectSummary[], abilities: StrategyPyramidAbilitySummary[]): StrategyPyramidScenario[] {
  const core = projects.find((project) => project.role === '核心产品') || projects[0];
  const reusable = abilities.find((ability) => ability.projectCount >= 2);
  return [{
    key: 'A',
    title: `场景 A：深化${core ? ` ${core.name}` : '核心产品'}`,
    investment: '把主要注意力集中到一个核心产品',
    returnProfile: '回报依赖单一产品商业化验证，增长速度可能更快但波动更高',
    cost: '其他孵化项目和第二收入源验证会被压缩',
    risk: '单一产品依赖风险',
    timeline: '6-12 个月',
    summary: core ? `适合 ${core.name} 已经形成 Sell / Learn 信号时选择。` : '适合先选出一个能代表长期方向的项目。'
  }, {
    key: 'B',
    title: '场景 B：建立产品组合',
    investment: '保持核心产品推进，同时保留一个低成本第二收入源假设',
    returnProfile: '回报增长更平衡，依赖能力复用和市场反馈互相增强',
    cost: '每个项目的投入强度会下降，需要严格冻结低复利维护',
    risk: '注意力分散风险',
    timeline: '12-18 个月',
    summary: reusable ? `适合围绕 ${reusable.name} 做跨项目复利。` : '适合已有多个项目但还需要识别复用能力。'
  }, {
    key: 'C',
    title: '场景 C：咨询/服务产品化',
    investment: '用一部分时间换取更快收入反馈，并把服务过程产品化',
    returnProfile: '收入反馈可能更快，但不应吞掉产品时间',
    cost: '咨询会挤占产品复利和自动化沉淀',
    risk: '活跃收入反向锁死风险',
    timeline: '3-6 个月',
    summary: '适合在产品收入证据不足时，用高质量需求验证补足市场信号。'
  }];
}

function inferRecommendedScenarioPath(projects: StrategyPyramidProjectSummary[], sellCount: number, learnCount: number): string {
  if (projects.length <= 1 || sellCount + learnCount === 0) return '推荐路径：先用场景 C 获取市场反馈，再决定是否切到场景 A。';
  if (projects.some((project) => project.role === '核心产品') && sellCount > 0 && learnCount > 0) return '推荐路径：场景 B 运行 6 个月，若核心产品转化信号增强再切到场景 A。';
  return '推荐路径：场景 B 为主，先冻结低复利项目，保留一个商业化验证窗口。';
}

function toStrategyId(value: string): string {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

interface SavedProjectStrategy {
  projectPath: string;
  role: string;
  businessStage: string;
  revenueTier: string;
  timeLoad: string;
  strategicAction: string;
  abilities: string;
  updatedAt: string;
}

function csvRoleToDisplay(role: string): string {
  switch (role) {
    case 'core_product': return '核心产品';
    case 'incubation': return '推进项目';
    case 'maintenance': return '稳定维护';
    case 'experiment': return '机会验证';
    case 'frozen': return '冻结项目';
    case 'infrastructure': return '能力底座';
    case 'content': return '内容资产';
    default: return '推进项目';
  }
}

function displayRoleToCsv(role: string): string {
  switch (role) {
    case '核心产品': return 'core_product';
    case '推进项目': return 'incubation';
    case '稳定维护': return 'maintenance';
    case '机会验证': return 'experiment';
    case '冻结项目': return 'frozen';
    case '能力底座': return 'infrastructure';
    case '内容资产': return 'content';
    default: return 'incubation';
  }
}

function csvActionToDisplay(action: string): string {
  switch (action) {
    case 'double_down': return '加码商业化验证与渠道建设';
    case 'reduce': return '收缩重复支持和低复利维护';
    case 'maintain': return '观察反馈是否能转成定价或明确取舍';
    case 'freeze': return '冻结项目，减少维护';
    case 'explore': return '推进下一个可验证切片';
    case 'sunset': return '收缩或降级';
    default: return '推进下一个可验证切片';
  }
}

function displayActionToCsv(action: string): string {
  if (/加码|继续|推进|核心|付费|商业化/.test(action)) return 'double_down';
  if (/收缩|减少|冻结|失败|阻塞/.test(action)) return 'reduce';
  if (/观察|复盘/.test(action)) return 'maintain';
  if (/验证|孵化|选择/.test(action)) return 'explore';
  return 'maintain';
}

function readProjectStrategyCsv(globalDataPath: string): Map<string, SavedProjectStrategy> {
  const map = new Map<string, SavedProjectStrategy>();
  try {
    const globalRoot = normalizeGlobalDataPath(globalDataPath);
    const csvPath = path.join(globalRoot, 'strategy', 'project-strategy.csv');
    if (fs.existsSync(csvPath)) {
      const csv = fs.readFileSync(csvPath, 'utf8');
      const parsed = Papa.parse<SavedProjectStrategy>(csv, { header: true, skipEmptyLines: true });
      if (parsed.data) {
        for (const row of parsed.data) {
          if (row.projectPath) {
            map.set(row.projectPath, row);
          }
        }
      }
    }
  } catch (error) {
    console.warn('Failed to read project-strategy.csv:', error);
  }
  return map;
}

export async function saveProjectStrategyData(
  globalDataPath: string,
  projectPath: string,
  role: string,
  businessStage: string,
  revenueTier: string,
  timeLoad: string,
  strategicAction: string,
  abilities: string[]
): Promise<void> {
  try {
    const globalRoot = normalizeGlobalDataPath(globalDataPath);
    const strategyRoot = path.join(globalRoot, 'strategy');
    fs.mkdirSync(strategyRoot, { recursive: true });

    const csvPath = path.join(strategyRoot, 'project-strategy.csv');
    let rows: SavedProjectStrategy[] = [];
    if (fs.existsSync(csvPath)) {
      const csv = fs.readFileSync(csvPath, 'utf8');
      const parsed = Papa.parse<SavedProjectStrategy>(csv, { header: true, skipEmptyLines: true });
      rows = parsed.data || [];
    }

    const existingIndex = rows.findIndex((r) => r.projectPath === projectPath);
    const newRow: SavedProjectStrategy = {
      projectPath,
      role: displayRoleToCsv(role),
      businessStage,
      revenueTier,
      timeLoad,
      strategicAction: displayActionToCsv(strategicAction),
      abilities: (abilities || []).map(toStrategyId).join(';'),
      updatedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      rows[existingIndex] = newRow;
    } else {
      rows.push(newRow);
    }

    fs.writeFileSync(csvPath, Papa.unparse(rows), 'utf8');
  } catch (error) {
    console.error('Failed to save project strategy:', error);
  }
}

function mapAbilityCategory(ability: string): string {
  if (/内容|分发|反馈|研究/.test(ability)) return 'marketing';
  if (/订阅|商业化/.test(ability)) return 'business';
  if (/基础设施|自动化|CLI|开发者|Web|AI/.test(ability)) return 'technical';
  return 'operations';
}

function writeStrategyPyramidSnapshot(globalDataPath: string, snapshot: StrategyPyramidSnapshot): void {
  try {
    const globalRoot = normalizeGlobalDataPath(globalDataPath);
    const strategyRoot = path.join(globalRoot, 'strategy');
    fs.mkdirSync(strategyRoot, { recursive: true });
    fs.writeFileSync(path.join(strategyRoot, 'pyramid-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    const projectRows = snapshot.projects.map((project) => ({
      projectPath: project.path,
      role: displayRoleToCsv(project.role),
      businessStage: project.businessStage,
      revenueTier: project.revenueTier,
      timeLoad: project.timeLoad,
      strategicAction: displayActionToCsv(project.action),
      abilities: project.abilities.map(toStrategyId).join(';'),
      updatedAt: snapshot.generatedAt
    }));
    fs.writeFileSync(path.join(strategyRoot, 'project-strategy.csv'), Papa.unparse(projectRows), 'utf8');
    const abilityRows = snapshot.abilities.map((ability) => ({
      abilityId: toStrategyId(ability.name),
      name: ability.name,
      category: mapAbilityCategory(ability.name),
      marketRelevance: ability.projectCount >= 2 ? 'high' : 'medium',
      notes: ability.judgment,
      updatedAt: snapshot.generatedAt
    }));
    fs.writeFileSync(path.join(strategyRoot, 'ability-registry.csv'), Papa.unparse(abilityRows), 'utf8');
  } catch (error) {
    console.warn('Failed to write strategy pyramid snapshot:', error);
  }
}

export function buildStrategyPyramidSnapshotData(
  projectEntries: StrategyPyramidProject[],
  globalDataPath: string,
  fallbackWorkspaceRoot = process.cwd()
): StrategyPyramidSnapshot {
  const savedStrategies = readProjectStrategyCsv(globalDataPath);

  const projects = projectEntries
    .filter((project) => project && project.path)
    .map((project) => {
      const nodes = readStrategyRoadmapNodes(project.path);
      const totalNodes = nodes.length;
      const completedNodes = nodes.filter((node) => node.status === 'Completed').length;
      const failedNodes = nodes.filter((node) => node.status === 'Failed').length;
      const runningNodes = nodes.filter((node) => node.status === 'Running').length;
      const inProgressNodes = nodes.filter((node) => node.status === 'In Progress').length;
      const pendingNodes = nodes.filter((node) => node.status === 'Pending').length;
      const progressPercent = totalNodes ? Math.round((completedNodes / totalNodes) * 100) : 0;

      const saved = savedStrategies.get(project.path);

      const investment = readProjectInvestmentStats(project.path);
      const actualMinutes = Math.round(Number(investment.totalDurationMs || 0) / 60000);

      const role = saved ? csvRoleToDisplay(saved.role) : inferStrategyRole(project, nodes);
      const businessStage = saved ? saved.businessStage : inferBusinessStage(project, nodes);
      const revenueTier = saved ? saved.revenueTier : inferRevenueTier(project, nodes);
      const timeLoad = saved ? saved.timeLoad : inferTimeLoad(actualMinutes, runningNodes, inProgressNodes, failedNodes, totalNodes);

      const abilities = (saved && saved.abilities)
        ? saved.abilities.split(';').map(x => x.trim()).filter(Boolean)
        : inferProjectAbilities(project, nodes);

      const base = {
        name: project.name,
        path: project.path,
        type: project.type || '',
        role,
        businessStage,
        revenueTier,
        timeLoad,
        actualMinutes,
        strategicRelation: inferStrategicRelation(role, abilities, nodes),
        loop: inferDominantStrategyLoop(nodes),
        abilities,
        roleScores: inferProjectRoleScores(project, nodes, abilities, role),
        completedNodes,
        failedNodes,
        runningNodes,
        inProgressNodes,
        pendingNodes,
        totalNodes,
        progressPercent,
        nodes
      };
      const evidence = inferProjectEvidence(base);
      if (actualMinutes > 0) {
        evidence.push(`实际累计耗时：${actualMinutes} 分钟`);
      } else {
        evidence.push(`实际累计耗时：0 分钟 (暂无本地 Agent 运行记录)`);
      }
      const tempBase = { ...base, evidence };

      const action = saved ? csvActionToDisplay(saved.strategicAction) : inferStrategyAction(tempBase);
      const risk = inferStrategyRisk(tempBase);

      return {
        ...tempBase,
        action,
        risk,
        advice: inferProjectAdvice({
          role: tempBase.role,
          nodes: tempBase.nodes,
          abilities: tempBase.abilities,
          failedNodes: tempBase.failedNodes,
          progressPercent: tempBase.progressPercent
        })
      };
    })
    .sort((a, b) => (
      b.failedNodes - a.failedNodes ||
      b.runningNodes - a.runningNodes ||
      b.inProgressNodes - a.inProgressNodes ||
      b.pendingNodes - a.pendingNodes ||
      a.name.localeCompare(b.name)
    ));

  const allNodes = projects.flatMap((project) => project.nodes);
  const countLoop = (key: MethodologyStageKey) => allNodes.filter((node) => classifyStrategyLoop(node) === key).length;
  const buildCount = countLoop('build');
  const sellCount = countLoop('sell');
  const learnCount = countLoop('learn');
  const improveCount = countLoop('improve');
  const learningSummary = readLearningSummary(projects[0]?.path || fallbackWorkspaceRoot, globalDataPath);
  const learningSignals: StrategyPyramidLearningSignal[] = learningSummary.projectSignals.slice(0, 8).map((item) => ({
    projectName: item.projectName,
    projectPath: item.projectPath,
    eventCount: item.eventCount,
    candidateCount: item.candidateCount,
    promotedCount: item.promotedCount,
    latestAt: item.latestAt,
    riskSignals: item.riskSignals,
    verificationSignals: item.verificationSignals,
    strategySignals: item.strategySignals
  }));
  const risks: string[] = [];
  if (projects.length > 0 && sellCount === 0) risks.push('组合缺少 Sell 信号，容易只 Build 不卖。');
  if (projects.length > 0 && learnCount === 0) risks.push('组合缺少 Learn 信号，下一轮改进依据不足。');
  if (projects.some((project) => project.failedNodes > 0)) risks.push('存在失败环节，应先收口再继续加码。');
  if (projects.length > 1 && !projects.some((project) => project.type === 'core_product' || project.role === '核心产品')) risks.push('组合缺少明确核心产品。');
  if (projects.filter((project) => project.totalNodes === 0).length > 0) risks.push('部分项目缺少路线图信号，容易形成低复利库存。');
  if (learningSignals.some((item) => item.riskSignals > item.verificationSignals + item.promotedCount)) risks.push('学习线索存在未收口风险，加码前应确认是否影响本周动作。');
  const loops = buildLoopSummaries(projects, allNodes);
  const abilities = buildAbilitySummaries(projects);
  const stageTitle = inferStrategyStage(projects, buildCount, sellCount, learnCount);
  const riskSignals = [
    ...buildRiskSignals(projects, sellCount, learnCount, buildCount),
    ...buildLearningRiskSignals(learningSignals)
  ].slice(0, 5);
  const structureSignals = [
    ...buildStructureSignals(projects, loops, abilities),
    buildLearningStructureSignal(learningSignals)
  ];
  const opportunitySignals = [
    ...buildOpportunitySignals(projects, abilities),
    ...buildLearningOpportunitySignals(learningSignals)
  ].slice(0, 4);
  const snapshot: StrategyPyramidSnapshot = {
    generatedAt: new Date().toISOString(),
    confidence: allNodes.length >= 4 ? 'medium' : 'low',
    stageTitle,
    stageProfile: buildStageProfile(stageTitle, projects),
    mainJudgment: inferMainJudgment(projects, buildCount, sellCount, learnCount),
    strategicAction: inferPortfolioStrategicAction(projects, sellCount, learnCount),
    constraint: inferPortfolioConstraint(projects, buildCount, sellCount, learnCount),
    totalProjects: projects.length,
    buildCount,
    sellCount,
    learnCount,
    improveCount,
    risks,
    loops,
    layers: buildStrategyLayers(projects, buildCount, sellCount, learnCount, improveCount, abilities),
    moves: buildStrategyMoves(projects, sellCount, learnCount, abilities),
    abilities,
    structureSignals,
    riskSignals,
    opportunitySignals,
    learningSignals,
    scenarios: buildStrategyScenarios(projects, abilities),
    recommendedScenarioPath: inferRecommendedScenarioPath(projects, sellCount, learnCount),
    projects
  };

  writeStrategyPyramidSnapshot(globalDataPath, snapshot);
  return snapshot;
}
