import * as path from 'path';
import type * as vscode from 'vscode';
import { ProjectGrowthViewModel } from './projectGrowth';

function joinExtensionUri(context: vscode.ExtensionContext, ...segments: string[]): vscode.Uri {
  const base = context.extensionUri as any;
  if (typeof base?.with === 'function') {
    return base.with({ path: path.posix.join(base.path, ...segments) });
  }
  const basePath = base?.fsPath || base?.path || String(base);
  const joined = path.join(basePath, ...segments);
  return {
    ...(base || {}),
    fsPath: joined,
    path: joined,
    toString: () => joined
  } as vscode.Uri;
}

function escapeHtml(value: string | number): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const locales = {
  zh: {
    title: "项目生长图",
    subTitle: "分析模块与文件的生长状态、诊断验证空缺并追踪演进历史。",
    refreshBtn: "刷新生长数据",
    snapshotTitle: "项目生长图分析快照",
    generatedAt: "生成时间",
    snapshotId: "快照标识",
    totalFiles: "总文件数",
    loc: "代码行数 (LOC)",
    modules: "模块数",
    capabilities: "路线图能力",
    packages: "依赖包数",
    signals: "警报信号",
    recentChanges: "最近一次代码快照演进 (对比上一次)",
    linesOfCode: "行代码",
    netFiles: "净文件变化",
    filesAdded: "新增文件数",
    filesRemoved: "删除文件数",
    filesModified: "修改文件数",
    modulesSignalMatrix: "模块与生长信号矩阵",
    architectureEdges: "真实模块与依赖关系",
    architectureGraph: "真实模块协同关系",
    architectureGraphHint: "行调用列；数字表示真实依赖强度。选择模块即可同时突出上下游协作关系。",
    architectureJudgement: "协同判断",
    verificationMatrix: "架构与验证盲区",
    verificationMatrixHint: "逐个真实模块核对代码体量、直接测试关系与验证覆盖，优先处理核心但无证据的区域。",
    covered: "有直接覆盖",
    partialCoverage: "部分覆盖",
    blindSpot: "验证盲区",
    coverage: "覆盖状态",
    directTests: "直接测试关系",
    openRoadmapStep: "打开路线图环节",
    graphPrimary: "完整构成",
    graphDependencies: "模块协作",
    graphVerification: "验证覆盖",
    graphCapability: "产品能力",
    graphCore: "实现模块",
    graphData: "调用与依赖",
    graphEvidence: "验证模块",
    structuralGaps: "架构与验证盲区 (Gaps)",
    linkedCapabilities: "关联路线图能力",
    snapshotHistory: "生长分析历史轨迹",
    currentProject: "当前项目",
    projectPath: "项目路径",
    understandingTitle: "项目概览",
    projectPurpose: "这个项目要解决什么",
    roadmapProgress: "路线进度",
    currentWork: "当前推进",
    journeyTitle: "项目阶段全貌",
    priorityActions: "接下来最值得做",
    capabilityMap: "项目能力全貌",
    growthFocus: "代码生长落点",
    detailData: "详细数据",
    noActions: "暂未发现必须立即处理的生长缺口。",
    noCapabilities: "当前路线图能力还没有明确代码落地信号。",
    noFocusAreas: "当前没有明显的重点生长区域。",
    actionLabel: "建议",
    evidenceLabel: "证据",
    sourceLabel: "来源",
    roadmapState: "路线状态",
    landingState: "落地状态",
    stepsCompleted: "个环节已完成",
    emptyModules: "当前项目未检测到模块。",
    emptyGaps: "所有健康度与分析规则均已满足。无架构与验证盲区！",
    emptyCaps: "没有关联路线图节点的特性。",
    emptyHistory: "暂无快照历史记录。",
    emptyEdges: "未计算出关键架构链路。",
    latest: "最新",
    files: "文件数",
    lines: "行数 (LOC)",
    tests: "测试数",
    confidence: "置信度",
    labelBasis: "命名依据",
    role: "职责",
    reason: "快照原因",
    source: "来源",
    stage: "阶段",
    timelineFiles: "文件",
    timelineLoc: "代码行",
    timelineModules: "模块",
    timelineSignals: "信号",
    signalLabels: {
      stable: "稳定",
      growing: "增长中",
      watch: "关注",
      attention: "需处理",
      blocked: "受阻",
      warning: "需处理",
      error: "错误",
      info: "信息"
    },
    roleLabels: {
      data: "数据层",
      interface: "界面层",
      "product-ui": "产品界面",
      execution: "执行层",
      knowledge: "知识层",
      verification: "验证层",
      "runtime-resource": "运行资源",
      website: "官网",
      delivery: "交付自动化",
      "extension-host": "插件宿主",
      implementation: "实现层",
      configuration: "配置",
      dependency: "依赖"
    },
    sourceLabels: {
      run_index: "运行索引",
      growth_rules: "生长规则",
      import_graph: "依赖关系",
      git: "Git 变更",
      roadmap: "路线图",
      filesystem: "项目文件"
    },
    labelSourceLabels: {
      dependency_cluster: "来自依赖聚类与共同目录",
      scan_fallback: "来自文件扫描回退命名"
    },
    edgeLabels: {
      imports: "调用",
      depends_on: "依赖",
      tested_by: "测试覆盖",
      implements: "支撑能力",
      shaped_by_run: "由运行塑造"
    },
    scanReasonLabels: {
      manual: "手动扫描",
      manual_command: "手动刷新",
      manual_refresh: "手动刷新",
      webview_refresh: "图内刷新",
      project_refresh: "项目刷新",
      query_refresh: "首次读取补齐",
      agent_run: "Agent 运行后",
      solo: "Solo 对话后",
      agent_continuation: "续聊后"
    },
    growthStatusLabels: {
      formed: "已成形",
      growing: "正在生长",
      needs_verification: "待验证",
      rework: "反复返工",
      risk: "风险集中",
      unshaped: "未长成",
      not_observed: "未识别到落地证据",
      stable: "稳定"
    },
    growthActionLabels: {
      keep_observing: "保持观察",
      add_verification: "补验证证据",
      reduce_risk: "先收口风险",
      continue_with_evidence: "继续推进并补证据",
      link_or_revise: "补齐代码落地或调整路线图归属",
      release_or_learn: "可进入发布、反馈或沉淀"
    },
    roadmapStatusLabels: {
      Completed: "已完成",
      Running: "执行中",
      Failed: "需修正",
      "In Progress": "推进中",
      Pending: "待推进"
    }
  },
  en: {
    title: "Project Growth Graph",
    subTitle: "Analyze code module growth, diagnose verification gaps, and track historical evolution.",
    refreshBtn: "Refresh Growth Data",
    snapshotTitle: "Project Growth Snapshot",
    generatedAt: "Generated at",
    snapshotId: "Snapshot ID",
    totalFiles: "Total Files",
    loc: "Lines of Code",
    modules: "Modules",
    capabilities: "Capabilities",
    packages: "Packages",
    signals: "Alert Signals",
    recentChanges: "Recent Changes (vs Previous Snapshot)",
    linesOfCode: "Lines of Code",
    netFiles: "Net Files",
    filesAdded: "Files Added",
    filesRemoved: "Files Removed",
    filesModified: "Files Modified",
    modulesSignalMatrix: "Modules & Signal Matrix",
    architectureEdges: "Real Modules & Dependencies",
    architectureGraph: "Real Module Relationships",
    architectureGraphHint: "Rows call columns; values show real dependency strength. Select a module to highlight both upstream and downstream collaborators.",
    architectureJudgement: "Collaboration judgement",
    verificationMatrix: "Architecture & Verification Blind Spots",
    verificationMatrixHint: "Review each real module's code weight, direct test relationships, and verification coverage. Prioritize core areas without evidence.",
    covered: "Directly covered",
    partialCoverage: "Partially covered",
    blindSpot: "Blind spot",
    coverage: "Coverage",
    directTests: "Direct test links",
    openRoadmapStep: "Open roadmap step",
    graphPrimary: "Full structure",
    graphDependencies: "Module collaboration",
    graphVerification: "Verification",
    graphCapability: "Product capabilities",
    graphCore: "Implementation modules",
    graphData: "Calls & dependencies",
    graphEvidence: "Verification modules",
    structuralGaps: "Structural Gaps",
    linkedCapabilities: "Linked Capabilities",
    snapshotHistory: "Snapshot History",
    currentProject: "Current Project",
    projectPath: "Project Path",
    understandingTitle: "Project Overview",
    projectPurpose: "What this project is for",
    roadmapProgress: "Roadmap progress",
    currentWork: "Current work",
    journeyTitle: "Project stages",
    priorityActions: "Most Useful Next Moves",
    capabilityMap: "Project Capability Map",
    growthFocus: "Code Growth Footprint",
    detailData: "Detailed Data",
    noActions: "No urgent growth gaps detected.",
    noCapabilities: "No roadmap capability has a clear code landing signal yet.",
    noFocusAreas: "No obvious growth focus area detected yet.",
    actionLabel: "Action",
    evidenceLabel: "Evidence",
    sourceLabel: "Source",
    roadmapState: "Roadmap",
    landingState: "Evidence",
    stepsCompleted: "steps completed",
    emptyModules: "No modules detected in this project.",
    emptyGaps: "All growth and health rules are satisfied. No architectural gaps found!",
    emptyCaps: "No capabilities linked to the roadmap.",
    emptyHistory: "No history recorded yet.",
    emptyEdges: "No key architectural edges computed.",
    latest: "LATEST",
    files: "Files",
    lines: "Lines (LOC)",
    tests: "Tests",
    confidence: "Confidence",
    labelBasis: "Naming basis",
    role: "Role",
    reason: "Reason",
    source: "Source",
    stage: "Stage",
    timelineFiles: "Files",
    timelineLoc: "LOC",
    timelineModules: "Modules",
    timelineSignals: "Signals",
    signalLabels: {
      stable: "Stable",
      growing: "Growing",
      watch: "Watch",
      attention: "Attention",
      blocked: "Blocked",
      warning: "Warning",
      error: "Error",
      info: "Info"
    },
    roleLabels: {
      data: "Data",
      interface: "Interface",
      "product-ui": "Product UI",
      execution: "Execution",
      knowledge: "Knowledge",
      verification: "Verification",
      "runtime-resource": "Runtime Resource",
      website: "Website",
      delivery: "Delivery Automation",
      "extension-host": "Extension Host",
      implementation: "Implementation",
      configuration: "Configuration",
      dependency: "Dependency"
    },
    sourceLabels: {
      run_index: "Run Index",
      growth_rules: "Growth Rules",
      import_graph: "Import Graph",
      git: "Git",
      roadmap: "Roadmap",
      filesystem: "Project Files"
    },
    labelSourceLabels: {
      dependency_cluster: "From dependency cluster and shared path",
      scan_fallback: "From scan fallback naming"
    },
    edgeLabels: {
      imports: "Imports",
      depends_on: "Depends On",
      tested_by: "Tested By",
      implements: "Implements",
      shaped_by_run: "Shaped By Run"
    },
    scanReasonLabels: {
      manual: "Manual Scan",
      manual_command: "Manual Refresh",
      manual_refresh: "Manual Refresh",
      webview_refresh: "View Refresh",
      project_refresh: "Project Refresh",
      query_refresh: "Initial Query Refresh",
      agent_run: "After Agent Run",
      solo: "After Solo Conversation",
      agent_continuation: "After Continuation"
    },
    growthStatusLabels: {
      formed: "Formed",
      growing: "Growing",
      needs_verification: "Needs Verification",
      rework: "Rework Loop",
      risk: "Concentrated Risk",
      unshaped: "Not Shaped",
      not_observed: "No landing evidence found",
      stable: "Stable"
    },
    growthActionLabels: {
      keep_observing: "Keep observing",
      add_verification: "Add verification evidence",
      reduce_risk: "Reduce risk first",
      continue_with_evidence: "Continue with evidence",
      link_or_revise: "Land code or revise roadmap ownership",
      release_or_learn: "Ready for release, feedback, or learning"
    },
    roadmapStatusLabels: {
      Completed: "Completed",
      Running: "Running",
      Failed: "Needs correction",
      "In Progress": "In progress",
      Pending: "Pending"
    }
  }
};

function formatMappedLabel(labels: Record<string, string>, value: string): string {
  const normalized = String(value || '').trim();
  return labels[normalized] || normalized.replace(/_/g, ' ');
}

function statusClass(value: string): string {
  if (value === 'formed') return 'formed';
  if (value === 'growing') return 'growing';
  if (value === 'needs_verification') return 'watch';
  if (value === 'risk') return 'attention';
  if (value === 'rework') return 'blocked';
  if (value === 'unshaped') return 'muted';
  if (value === 'not_observed') return 'muted';
  return 'stable';
}

export function getProjectGrowthWebviewHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  viewModel: ProjectGrowthViewModel,
  projectName: string,
  isZh: boolean,
  projects: Array<{ name: string; path: string }> = []
): string {
  const codiconsUri = webview.asWebviewUri(joinExtensionUri(context, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
  const wordmarkUri = webview.asWebviewUri(joinExtensionUri(context, 'resources', 'logo_with_text.svg'));
  
  const t = isZh ? locales.zh : locales.en;
  const localeCode = isZh ? 'zh-CN' : 'en-US';

  const totalFiles = viewModel.totals.files;
  const totalLoc = viewModel.totals.loc;
  const totalModules = viewModel.totals.modules;
  const totalCapabilities = viewModel.totals.capabilities;
  const totalPackages = viewModel.totals.packages;
  const totalSignals = viewModel.totals.signals;
  const projectPath = viewModel.projectPath || '';
  const focusCount = viewModel.focusAreas?.length || totalModules;
  const shapedCapabilities = (viewModel.capabilityHealth || []).filter((item) => item.modules.length > 0).length;
  const formedCapabilities = (viewModel.capabilityHealth || []).filter((item) => item.status === 'formed').length;
  const topFocus = viewModel.focusAreas?.[0]?.label || viewModel.modules?.[0]?.label || (isZh ? '项目主干' : 'Project core');
  const insightHeadline = isZh
    ? viewModel.insight.headline
    : (totalFiles > 0 ? `${totalFiles} files are organized into ${focusCount} main growth areas` : 'No project growth snapshot yet');
  const insightBody = isZh
    ? viewModel.insight.body
    : (totalCapabilities > 0
      ? `${shapedCapabilities}/${totalCapabilities} roadmap capabilities have code landing signals, and ${formedCapabilities} already have verification or stable evidence. The next useful view is not file volume, but the capability gaps that affect understanding and delivery.`
      : `${focusCount} main growth areas have been identified. The next useful step is to connect code areas to real product capabilities and add verification evidence.`);
  const insightHealthLabel = isZh
    ? viewModel.insight.healthLabel
    : (viewModel.recommendedActions.length > 0 ? `${viewModel.recommendedActions.length} priority actions` : 'No obvious blockers');
  const insightFocusLabel = isZh
    ? viewModel.insight.focusLabel
    : `${topFocus} is the first area to inspect`;
  const insightEvidenceLabel = isZh
    ? viewModel.insight.evidenceLabel
    : (totalSignals > 0 ? `${totalSignals} growth signals` : 'No growth signals yet');
  const orientation = viewModel.orientation || {
    purpose: '', currentStage: '', currentStep: '', currentStepStatus: '', completedSteps: 0, totalSteps: 0, stages: []
  };
  const progressPercent = orientation.totalSteps > 0
    ? Math.round((orientation.completedSteps / orientation.totalSteps) * 100)
    : 0;
  const rawProjectPurpose = orientation.purpose || insightBody;
  const bilingualPurpose = rawProjectPurpose.split(/\s+\/\s+/);
  const projectPurpose = bilingualPurpose.length === 2
    ? (isZh ? bilingualPurpose[1] : bilingualPurpose[0])
    : rawProjectPurpose;
  const currentStepLabel = orientation.currentStep || (isZh ? '暂无待推进环节' : 'No active roadmap step');
  const currentStageLabel = orientation.currentStage || '-';
  const currentRoadmapStatus = formatMappedLabel(t.roadmapStatusLabels, orientation.currentStepStatus || 'Pending');
  const journeyHtml = orientation.stages.length > 0
    ? orientation.stages.map((stage) => `
        <div class="journey-stage ${escapeHtml(stage.status)}">
          <div class="journey-marker"><span class="codicon ${stage.status === 'completed' ? 'codicon-check' : stage.status === 'active' ? 'codicon-play' : 'codicon-circle-outline'}"></span></div>
          <div class="journey-copy">
            <strong>${escapeHtml(stage.label)}</strong>
            <span>${stage.completed}/${stage.total} ${escapeHtml(isZh ? '已完成' : 'completed')}</span>
          </div>
        </div>
      `).join('')
    : `<div class="empty-state">${escapeHtml(t.noCapabilities)}</div>`;

  const actionCardsHtml = viewModel.recommendedActions && viewModel.recommendedActions.length > 0
    ? viewModel.recommendedActions.slice(0, 3).map((action) => {
      const statusLabel = formatMappedLabel(t.growthStatusLabels, action.level);
      const sourceLabel = formatMappedLabel(t.sourceLabels, action.source);
      const actionTitle = isZh ? action.title : `${action.target}: ${statusLabel}`;
      const actionDetail = isZh ? action.detail : `${t.actionLabel}: ${formatMappedLabel(t.growthActionLabels, action.level === 'needs_verification' ? 'add_verification' : action.level === 'risk' || action.level === 'rework' ? 'reduce_risk' : 'keep_observing')}`;
      return `
        <div class="action-card ${statusClass(action.level)}">
          <div class="action-card-head">
            <span class="status-pill ${statusClass(action.level)}">${escapeHtml(statusLabel)}</span>
            <span class="action-source">${escapeHtml(sourceLabel)}</span>
          </div>
          <div class="action-title">${escapeHtml(actionTitle)}</div>
          <div class="action-detail">${escapeHtml(actionDetail)}</div>
          <div class="action-target">${escapeHtml(action.target)}</div>
          ${action.source === 'roadmap' && action.targetId ? `<button type="button" class="action-open-roadmap" data-roadmap-target="${escapeHtml(action.targetId.replace(/^capability:roadmap:/, ''))}">${escapeHtml(t.openRoadmapStep)} <span class="codicon codicon-arrow-right"></span></button>` : ''}
        </div>
      `;
    }).join('')
    : `<div class="empty-state-healthy"><span class="codicon codicon-check"></span> ${escapeHtml(t.noActions)}</div>`;

  const capabilityHealthHtml = viewModel.capabilityHealth && viewModel.capabilityHealth.length > 0
    ? viewModel.capabilityHealth.map((capability) => {
      return `
        <div class="capability-health-card ${statusClass(capability.status)}">
          <div class="capability-health-head">
            <span class="capability-name">${escapeHtml(capability.label)}</span>
            <span class="roadmap-state ${escapeHtml(capability.roadmapStatus.toLowerCase().replace(/\s+/g, '-'))}">${escapeHtml(t.roadmapState)} · ${escapeHtml(formatMappedLabel(t.roadmapStatusLabels, capability.roadmapStatus))}</span>
          </div>
          <div class="capability-stage">${escapeHtml(capability.stage || '-')}</div>
          ${capability.description ? `<div class="capability-description">${escapeHtml(capability.description)}</div>` : ''}
          <div class="capability-state-line">
            <span>${escapeHtml(t.landingState)}</span>
            <strong class="${statusClass(capability.status)}">${escapeHtml(formatMappedLabel(t.growthStatusLabels, capability.status))}</strong>
          </div>
          ${capability.modules && capability.modules.length > 0 ? `
            <div class="capability-modules">
              ${capability.modules.slice(0, 6).map((moduleName) => `<span>${escapeHtml(moduleName)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('')
    : `<div class="empty-state">${escapeHtml(t.noCapabilities)}</div>`;

  const focusAreasHtml = viewModel.focusAreas && viewModel.focusAreas.length > 0
    ? viewModel.focusAreas.map((area) => {
      const focusSummary = isZh
        ? `${area.files} 个文件 · ${area.loc.toLocaleString()} 行 · ${area.tests} 个测试`
        : `${area.files} files · ${area.loc.toLocaleString()} LOC · ${area.tests} tests`;
      const labelBasis = formatMappedLabel((t as any).labelSourceLabels || {}, area.labelSource);
      return `
        <div class="focus-area-row ${statusClass(area.status)}">
          <div class="focus-main">
            <div class="focus-title">${escapeHtml(area.label)} <span class="status-pill ${statusClass(area.status)}">${escapeHtml(formatMappedLabel(t.growthStatusLabels, area.status))}</span></div>
            <div class="focus-summary">${escapeHtml(focusSummary)}</div>
            <div class="focus-action">${escapeHtml(t.labelBasis)}: ${escapeHtml(labelBasis)}</div>
            <div class="focus-action">${escapeHtml(t.actionLabel)}: ${escapeHtml(formatMappedLabel(t.growthActionLabels, area.action))}</div>
          </div>
          <div class="focus-metrics">
            <span>${escapeHtml(t.files)} <strong>${area.files}</strong></span>
            <span>${escapeHtml(t.lines)} <strong>${area.loc.toLocaleString()}</strong></span>
            <span>${escapeHtml(t.tests)} <strong>${area.tests}</strong></span>
          </div>
        </div>
      `;
    }).join('')
    : `<div class="empty-state">${escapeHtml(t.noFocusAreas)}</div>`;

  // Render module cards
  let moduleCardsHtml = '';
  const displayModules = (viewModel.modules || []).filter((mod) => {
    const id = String(mod.nodeId || (mod as any).id || '');
    const label = String(mod.label || '');
    if (/^module:(\.solopreneur|CHANGELOG\.md|README\.md|package(?:-lock)?\.json|tsconfig\.json|log)$/i.test(id)) return false;
    if (/^\./.test(label) || /\.(md|json|ya?ml|toml|csv|txt|lock)$/i.test(label) || /^(CHANGELOG|README|package(?:-lock)?\.json|tsconfig\.json|log)$/i.test(label)) return false;
    if (['knowledge', 'verification', 'configuration', 'delivery'].includes(String(mod.role || ''))) return false;
    return mod.files > 0 && mod.loc > 0;
  });
  if (displayModules.length > 0) {
    const maxModuleLoc = Math.max(1, ...displayModules.map((item) => item.loc));
    moduleCardsHtml = [...displayModules]
      .sort((a, b) => b.loc - a.loc)
      .map((mod, index) => {
      let signalClass = 'signal-stable';
      if (mod.signal === 'watch') signalClass = 'signal-watch';
      if (mod.signal === 'attention') signalClass = 'signal-attention';
      if (mod.signal === 'blocked') signalClass = 'signal-blocked';
      if (mod.signal === 'growing') signalClass = 'signal-growing';

      const tileWeight = Math.max(1, Math.round(1 + 7 * Math.sqrt(mod.loc / maxModuleLoc)));
      const tileSize = index === 0 ? 'tile-dominant' : index < 3 ? 'tile-large' : index < 7 ? 'tile-medium' : 'tile-small';
      const signalLabel = formatMappedLabel(t.signalLabels, mod.signal);
      return `
        <div class="module-card ${signalClass} ${tileSize}" style="--tile-weight:${tileWeight}" tabindex="0" role="group" aria-label="${escapeHtml(`${mod.label}, ${signalLabel}, ${mod.loc} ${t.lines}`)}">
          <div class="module-card-head">
            <span class="module-title"><span class="codicon codicon-symbol-module"></span> ${escapeHtml(mod.label)}</span>
            <span class="signal-tag"><span class="signal-mark"></span>${escapeHtml(signalLabel)}</span>
          </div>
          <div class="module-facts">
            <span>${mod.files} ${escapeHtml(t.files)}</span>
            <span>${mod.loc.toLocaleString()} ${escapeHtml(t.lines)}</span>
            ${mod.tests > 0 ? `<span>${mod.tests} ${escapeHtml(t.tests)}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } else {
    moduleCardsHtml = `<div class="empty-state">${escapeHtml(t.emptyModules)}</div>`;
  }

  // Render structural gaps (diagnostics)
  let gapsHtml = '';
  if (viewModel.gaps && viewModel.gaps.length > 0) {
    gapsHtml = viewModel.gaps.map(gap => {
      let badgeClass = 'badge-watch';
      if (gap.level === 'attention' || gap.level === 'warning') badgeClass = 'badge-attention';
      if (gap.level === 'blocked' || gap.level === 'error') badgeClass = 'badge-blocked';
      
      return `
        <div class="gap-item">
          <span class="gap-badge ${badgeClass}">${escapeHtml(formatMappedLabel(t.signalLabels, gap.level))}</span>
          <div class="gap-content">
            <div class="gap-title">${escapeHtml(gap.label)}</div>
            <div class="gap-desc">${escapeHtml(gap.value)} <span class="gap-source">${escapeHtml(t.source)}: ${escapeHtml(formatMappedLabel(t.sourceLabels, gap.source))}</span></div>
          </div>
        </div>
      `;
    }).join('');
  } else {
    gapsHtml = `<div class="empty-state-healthy"><span class="codicon codicon-check"></span> ${escapeHtml(t.emptyGaps)}</div>`;
  }

  // Render capabilities
  let capabilitiesHtml = '';
  if (viewModel.capabilities && viewModel.capabilities.length > 0) {
    capabilitiesHtml = viewModel.capabilities.map(cap => {
      return `
        <div class="cap-card">
          <div class="cap-title"><span class="codicon codicon-milestone"></span> ${escapeHtml(cap.label)}</div>
          <div class="cap-stage">${escapeHtml(t.stage)}: ${escapeHtml(cap.stage)}</div>
          ${cap.modules && cap.modules.length > 0 ? `
            <div class="cap-modules">
              ${cap.modules.map(m => `<span class="cap-mod-badge">${escapeHtml(m.replace('module:', ''))}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  } else {
    capabilitiesHtml = `<div class="empty-state">${escapeHtml(t.emptyCaps)}</div>`;
  }

  // Render timeline history
  let historyHtml = '';
  if (viewModel.history && viewModel.history.length > 0) {
    historyHtml = viewModel.history.map((item, idx) => {
      const isLatest = idx === 0;
      const dateStr = new Date(item.createdAt).toLocaleString(localeCode);
      return `
        <div class="timeline-item ${isLatest ? 'is-latest' : ''}">
          <div class="timeline-marker"></div>
          <div class="timeline-content">
            <div class="timeline-time">${escapeHtml(dateStr)} ${isLatest ? `<span class="latest-tag">${escapeHtml(t.latest)}</span>` : ''}</div>
            <div class="timeline-reason">${escapeHtml(t.reason)}: <strong>${escapeHtml(formatMappedLabel(t.scanReasonLabels, item.scanReason))}</strong></div>
            <div class="timeline-stats">
              <span>${escapeHtml(t.timelineFiles)}: <strong>${item.totals.files}</strong></span>
              <span>${escapeHtml(t.timelineLoc)}: <strong>${item.totals.loc.toLocaleString()}</strong></span>
              <span>${escapeHtml(t.timelineModules)}: <strong>${item.totals.modules}</strong></span>
              <span>${escapeHtml(t.timelineSignals)}: <strong>${item.totals.signals}</strong></span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } else {
    historyHtml = `<div class="empty-state">${escapeHtml(t.emptyHistory)}</div>`;
  }

  // Render diff if available
  let diffHtml = '';
  if (viewModel.diff) {
    const d = viewModel.diff;
    const locDeltaSign = d.locDelta >= 0 ? `+${d.locDelta}` : `${d.locDelta}`;
    const filesDeltaSign = d.filesAdded - d.filesRemoved >= 0 ? `+${d.filesAdded - d.filesRemoved}` : `${d.filesAdded - d.filesRemoved}`;

    diffHtml = `
      <div class="diff-card">
        <div class="diff-head"><span class="codicon codicon-git-compare"></span> ${escapeHtml(t.recentChanges)}</div>
        <div class="diff-stats">
          <div class="diff-stat">
            <span class="diff-num ${d.locDelta >= 0 ? 'pos' : 'neg'}">${locDeltaSign}</span>
            <span class="diff-label">${escapeHtml(t.linesOfCode)}</span>
          </div>
          <div class="diff-stat">
            <span class="diff-num ${d.filesAdded - d.filesRemoved >= 0 ? 'pos' : 'neg'}">${filesDeltaSign}</span>
            <span class="diff-label">${escapeHtml(t.netFiles)}</span>
          </div>
          <div class="diff-stat-details">
            <div>${escapeHtml(t.filesAdded)}: <strong class="pos">+${d.filesAdded}</strong></div>
            <div>${escapeHtml(t.filesRemoved)}: <strong class="neg">-${d.filesRemoved}</strong></div>
            <div>${escapeHtml(t.filesModified)}: <strong>${d.filesChanged}</strong></div>
          </div>
        </div>
      </div>
    `;
  }

  const matrixModules = displayModules.slice(0, 12);
  const matrixModuleIds = new Set(matrixModules.map((module) => module.nodeId));
  const collaborationEdges = (viewModel.keyEdges || []).filter((edge) => (
    matrixModuleIds.has(edge.sourceId)
    && matrixModuleIds.has(edge.targetId)
    && ['imports', 'depends_on'].includes(edge.kind)
  ));
  const collaborationWeight = new Map<string, number>();
  const collaborationDegree = new Map(matrixModules.map((module) => [module.nodeId, { incoming: 0, outgoing: 0 }]));
  for (const edge of collaborationEdges) {
    const key = `${edge.sourceId}\u001f${edge.targetId}`;
    collaborationWeight.set(key, (collaborationWeight.get(key) || 0) + edge.weight);
    collaborationDegree.get(edge.sourceId)!.outgoing += edge.weight;
    collaborationDegree.get(edge.targetId)!.incoming += edge.weight;
  }
  const rankedCollaboration = [...matrixModules].sort((a, b) => {
    const aDegree = collaborationDegree.get(a.nodeId)!;
    const bDegree = collaborationDegree.get(b.nodeId)!;
    return (bDegree.incoming + bDegree.outgoing) - (aDegree.incoming + aDegree.outgoing);
  });
  const hubModule = rankedCollaboration[0];
  const isolatedModules = matrixModules.filter((module) => {
    const degree = collaborationDegree.get(module.nodeId)!;
    return degree.incoming + degree.outgoing === 0;
  });
  const strongestPair = [...collaborationEdges].sort((a, b) => b.weight - a.weight)[0];
  const matrixLabel = (nodeId: string) => matrixModules.find((module) => module.nodeId === nodeId)?.label || nodeId;
  const collaborationJudgements = [
    hubModule && (collaborationDegree.get(hubModule.nodeId)!.incoming + collaborationDegree.get(hubModule.nodeId)!.outgoing) > 0
      ? (isZh
        ? `${hubModule.label} 是当前协同枢纽，连接强度 ${collaborationDegree.get(hubModule.nodeId)!.incoming + collaborationDegree.get(hubModule.nodeId)!.outgoing}`
        : `${hubModule.label} is the collaboration hub with strength ${collaborationDegree.get(hubModule.nodeId)!.incoming + collaborationDegree.get(hubModule.nodeId)!.outgoing}`)
      : '',
    strongestPair
      ? (isZh
        ? `${matrixLabel(strongestPair.sourceId)} → ${matrixLabel(strongestPair.targetId)} 是最强调用链`
        : `${matrixLabel(strongestPair.sourceId)} → ${matrixLabel(strongestPair.targetId)} is the strongest dependency`)
      : '',
    isolatedModules.length > 0
      ? (isZh
        ? `${isolatedModules.length} 个模块未进入当前关键协同链`
        : `${isolatedModules.length} modules are outside the current key collaboration chain`)
      : ''
  ].filter(Boolean);
  const collaborationMatrixHtml = matrixModules.length > 0 ? `
    <div class="matrix-scroll">
      <table class="relationship-matrix" aria-label="${escapeHtml(t.architectureGraph)}">
        <thead><tr><th class="matrix-corner">${escapeHtml(isZh ? '调用方 \\ 被调用方' : 'Caller \\ Target')}</th>${matrixModules.map((module) => `<th title="${escapeHtml(module.label)}"><span>${escapeHtml(module.label)}</span></th>`).join('')}</tr></thead>
        <tbody>${matrixModules.map((source) => `
          <tr data-matrix-row="${escapeHtml(source.nodeId)}">
            <th scope="row"><span>${escapeHtml(source.label)}</span><small>${escapeHtml(formatMappedLabel(t.roleLabels, source.role))}</small></th>
            ${matrixModules.map((target) => {
              if (source.nodeId === target.nodeId) return `<td class="matrix-self" aria-label="${escapeHtml(source.label)}">—</td>`;
              const weight = collaborationWeight.get(`${source.nodeId}\u001f${target.nodeId}`) || 0;
              return `<td class="matrix-cell ${weight > 0 ? 'has-relation' : ''}" data-matrix-source="${escapeHtml(source.nodeId)}" data-matrix-target="${escapeHtml(target.nodeId)}" style="--relation-strength:${Math.min(1, weight / 6)}" title="${escapeHtml(weight > 0 ? `${source.label} → ${target.label}: ${weight}` : '')}">${weight || ''}</td>`;
            }).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  ` : `<div class="empty-state">${escapeHtml(t.emptyEdges)}</div>`;

  const verificationEdges = (viewModel.keyEdges || []).filter((edge) => edge.kind === 'tested_by');
  const verificationRows = [...displayModules].sort((a, b) => b.loc - a.loc).map((module) => {
    const directLinks = verificationEdges
      .filter((edge) => edge.sourceId === module.nodeId)
      .reduce((sum, edge) => sum + edge.weight, 0);
    const coverageState = directLinks > 0 ? 'covered' : module.tests > 0 ? 'partial' : 'blind';
    const coverageLabel = coverageState === 'covered' ? t.covered : coverageState === 'partial' ? t.partialCoverage : t.blindSpot;
    return { ...module, directLinks, coverageState, coverageLabel };
  });
  const coveredCount = verificationRows.filter((row) => row.coverageState === 'covered').length;
  const blindCount = verificationRows.filter((row) => row.coverageState === 'blind').length;
  const verificationMatrixHtml = verificationRows.length > 0 ? `
    <div class="verification-summary">
      <strong>${coveredCount}/${verificationRows.length}</strong>
      <span>${escapeHtml(t.covered)}</span>
      <strong class="${blindCount > 0 ? 'danger-text' : ''}">${blindCount}</strong>
      <span>${escapeHtml(t.blindSpot)}</span>
    </div>
    <div class="verification-grid" role="table" aria-label="${escapeHtml(t.verificationMatrix)}">
      <div class="verification-row verification-head" role="row">
        <span role="columnheader">${escapeHtml(isZh ? '真实模块' : 'Real module')}</span>
        <span role="columnheader">${escapeHtml(t.files)}</span>
        <span role="columnheader">${escapeHtml(t.lines)}</span>
        <span role="columnheader">${escapeHtml(t.directTests)}</span>
        <span role="columnheader">${escapeHtml(t.coverage)}</span>
      </div>
      ${verificationRows.map((row) => `
        <div class="verification-row coverage-${row.coverageState}" role="row">
          <span role="cell"><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(formatMappedLabel(t.roleLabels, row.role))}</small></span>
          <span role="cell">${row.files}</span>
          <span role="cell">${row.loc.toLocaleString()}</span>
          <span role="cell">${row.directLinks}</span>
          <span role="cell"><i></i>${escapeHtml(row.coverageLabel)}</span>
        </div>`).join('')}
    </div>
  ` : `<div class="empty-state">${escapeHtml(t.emptyModules)}</div>`;

  const architectureHtml = `
    <section class="matrix-panel collaboration-panel">
      <div class="matrix-panel-head">
        <div>
          <h2 class="panel-title"><span class="codicon codicon-type-hierarchy-sub"></span> ${escapeHtml(t.architectureGraph)}</h2>
          <p>${escapeHtml(t.architectureGraphHint)}</p>
        </div>
      </div>
      <div class="collaboration-judgements" aria-label="${escapeHtml(t.architectureJudgement)}">
        ${collaborationJudgements.map((judgement) => `<span><i></i>${escapeHtml(judgement)}</span>`).join('')}
      </div>
      ${collaborationMatrixHtml}
    </section>
    <section class="matrix-panel verification-panel">
      <div class="matrix-panel-head">
        <div>
          <h2 class="panel-title"><span class="codicon codicon-shield"></span> ${escapeHtml(t.verificationMatrix)}</h2>
          <p>${escapeHtml(t.verificationMatrixHint)}</p>
        </div>
      </div>
      ${verificationMatrixHtml}
    </section>
  `;

  return `<!DOCTYPE html>
<html lang="${isZh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconsUri}" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <title>solomap ${escapeHtml(t.title)}</title>
  <style>
    :root {
      --bg-dark: #0f111a;
      --fg: #e2e8f0;
      --muted: #94a3b8;
      --border: rgba(255, 255, 255, 0.08);
      --glass-bg: rgba(22, 28, 45, 0.6);
      --glass-panel: rgba(22, 28, 45, 0.6);
      --accent: #00e5ff;
      --accent-purple: #7c4dff;
      --success: #00e676;
      --warn: #ffd600;
      --attention: #ff9100;
      --danger: #ff1744;
      --font: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --heading-font: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    * { box-sizing: border-box; }

    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(148, 163, 184, 0.2) transparent;
    }

    *::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }

    *::-webkit-scrollbar-track {
      background: transparent;
    }

    *::-webkit-scrollbar-thumb {
      border: 1px solid transparent;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.2);
    }

    body {
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background, var(--bg-dark));
      color: var(--fg);
      font-family: var(--font);
      line-height: 1.5;
      overflow-x: hidden;
    }

    .app-container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
    }

    .growth-canvas {
      flex: 1;
      position: relative;
      overflow: auto;
      padding: clamp(18px, 4vw, 40px);
      background: radial-gradient(circle at 50% 50%, rgba(20, 25, 45, 0.6) 0%, rgba(10, 12, 22, 0.95) 100%);
      display: flex;
      flex-direction: column;
      gap: 30px;
    }

    .growth-content {
      width: 100%;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 16px 24px;
      background: rgba(15, 17, 26, 0.7);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      z-index: 10;
    }

    .brand-title {
      margin: 0;
      display: flex;
      align-items: center;
    }

    h1, h2, h3, .panel-title, .priority-title {
      font-family: var(--heading-font);
    }

    .brand-wordmark {
      width: 132px;
      height: 34px;
      flex-shrink: 0;
    }

    .page-heading { color: var(--fg); font-size: 16px; font-weight: 800; line-height: 1.2; }
    .header-divider { width: 1px; height: 20px; background: var(--border); }

    .header-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .project-select {
      width: clamp(150px, 18vw, 240px);
      min-width: 0;
      height: 34px;
      padding: 0 28px 0 10px;
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--fg);
      background: rgba(255, 255, 255, 0.05);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .project-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .project-orientation,
    .journey-panel {
      border-bottom: 1px solid var(--border);
      padding: 4px 0 20px;
      margin-bottom: 20px;
    }

    .orientation-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(220px, 0.6fr) minmax(260px, 0.8fr);
      gap: 24px;
      align-items: center;
    }

    .project-purpose span,
    .current-work span,
    .progress-head span,
    .progress-caption {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-style: normal;
    }

    .project-purpose h2 {
      margin: 6px 0 0;
      font-size: 20px;
      line-height: 1.35;
      font-weight: 650;
    }

    .progress-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .progress-track {
      height: 7px;
      overflow: hidden;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
    }

    .progress-track span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--success);
    }

    .progress-caption { margin-top: 6px; }

    .current-work {
      border-left: 2px solid var(--accent);
      padding-left: 14px;
    }

    .current-work strong {
      display: block;
      margin: 4px 0;
      font-size: 14px;
    }

    .current-work em {
      color: var(--accent);
      font-size: 11px;
      font-style: normal;
      font-weight: 700;
    }

    .journey-track {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 0;
    }

    .journey-stage {
      position: relative;
      display: flex;
      gap: 9px;
      padding: 4px 14px 4px 0;
      min-width: 0;
    }

    .journey-stage:not(:last-child)::after {
      content: '';
      position: absolute;
      top: 12px;
      left: 24px;
      right: 4px;
      height: 1px;
      background: var(--border);
      z-index: -1;
    }

    .journey-marker {
      width: 24px;
      height: 24px;
      flex: 0 0 24px;
      display: grid;
      place-items: center;
      border: 1px solid var(--border);
      border-radius: 50%;
      background: var(--vscode-editor-background, var(--bg-dark));
      color: var(--muted);
    }

    .journey-stage.completed .journey-marker { color: var(--success); border-color: rgba(0, 230, 118, 0.4); }
    .journey-stage.active .journey-marker { color: var(--accent); border-color: rgba(0, 229, 255, 0.5); }

    .journey-copy { min-width: 0; }
    .journey-copy strong { display: block; font-size: 12px; line-height: 1.3; }
    .journey-copy span { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; }

    .understanding-shell {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.9fr);
      gap: 18px;
      align-items: stretch;
      margin-bottom: 20px;
    }

    .understanding-main,
    .priority-actions,
    .growth-v2-panel {
      background: var(--glass-panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
      transition: all 0.3s ease;
    }

    .understanding-main:hover,
    .priority-actions:hover,
    .growth-v2-panel:hover {
      border-color: rgba(255, 255, 255, 0.12);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.32);
    }

    .section-kicker,
    .detail-section-title {
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
      margin-bottom: 8px;
    }

    .understanding-main h2 {
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.18;
      letter-spacing: 0;
    }

    .understanding-main p {
      color: var(--muted);
      margin: 0;
      font-size: 13px;
      max-width: 760px;
    }

    .understanding-chips,
    .capability-modules,
    .focus-metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }

    .understanding-chips span,
    .capability-modules span,
    .focus-metrics span,
    .action-target {
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.035);
      padding: 4px 8px;
      font-size: 11px;
    }

    .priority-title {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--fg);
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 10px;
    }

    .priority-list,
    .focus-area-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .action-card,
    .capability-health-card,
    .focus-area-row {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      padding: 16px;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .action-card:hover,
    .capability-health-card:hover,
    .focus-area-row:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-1px);
    }

    .action-card.attention,
    .capability-health-card.attention,
    .focus-area-row.attention {
      border-color: rgba(255, 145, 0, 0.24);
      background: rgba(255, 145, 0, 0.04);
    }

    .action-card.blocked,
    .capability-health-card.blocked,
    .focus-area-row.blocked {
      border-color: rgba(255, 23, 68, 0.24);
      background: rgba(255, 23, 68, 0.04);
    }

    .action-card.watch,
    .capability-health-card.watch,
    .focus-area-row.watch {
      border-color: rgba(255, 214, 0, 0.22);
      background: rgba(255, 214, 0, 0.035);
    }

    .action-card-head,
    .capability-health-head,
    .focus-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 700;
      color: var(--muted);
      white-space: nowrap;
    }

    .status-pill.formed,
    .status-pill.stable {
      color: var(--success);
      border-color: rgba(0, 230, 118, 0.24);
      background: rgba(0, 230, 118, 0.08);
    }

    .status-pill.growing {
      color: var(--accent);
      border-color: rgba(0, 229, 255, 0.22);
      background: rgba(0, 229, 255, 0.08);
    }

    .status-pill.watch {
      color: var(--warn);
      border-color: rgba(255, 214, 0, 0.24);
      background: rgba(255, 214, 0, 0.08);
    }

    .status-pill.attention {
      color: var(--attention);
      border-color: rgba(255, 145, 0, 0.24);
      background: rgba(255, 145, 0, 0.08);
    }

    .status-pill.blocked {
      color: var(--danger);
      border-color: rgba(255, 23, 68, 0.24);
      background: rgba(255, 23, 68, 0.08);
    }

    .action-title,
    .capability-name,
    .focus-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--fg);
    }

    .action-detail,
    .capability-summary,
    .focus-summary,
    .focus-action,
    .capability-stage,
    .evidence-list {
      color: var(--muted);
      font-size: 12px;
    }

    .action-source {
      color: var(--muted);
      font-size: 10px;
    }

    .action-open-roadmap {
      min-height: 36px;
      margin-top: 12px;
      padding: 7px 11px;
      border: 1px solid rgba(0, 229, 255, 0.32);
      border-radius: 7px;
      background: rgba(0, 229, 255, 0.1);
      color: var(--accent);
      font: inherit;
      font-size: 11px;
      font-weight: 750;
      cursor: pointer;
    }
    .action-open-roadmap:hover { background: rgba(0, 229, 255, 0.17); }
    .action-open-roadmap:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .capability-action {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 10px;
      font-size: 12px;
      color: var(--fg);
    }

    .capability-action span {
      color: var(--accent);
      font-weight: 700;
    }

    .evidence-list {
      margin-top: 10px;
      display: grid;
      gap: 4px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      padding-top: 10px;
    }

    .growth-v2-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 18px;
      margin-bottom: 20px;
    }

    .capability-health-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .matrix-panel {
      margin-bottom: 24px;
      padding: 20px;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--glass-panel);
    }
    .matrix-panel-head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
    .matrix-panel-head .panel-title { margin: 0 0 5px; padding: 0; border: 0; }
    .matrix-panel-head p { max-width: 760px; margin: 0; color: var(--muted); font-size: 12px; }
    .collaboration-judgements { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .collaboration-judgements span {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 6px 9px;
      border: 1px solid rgba(0, 229, 255, 0.16);
      border-radius: 999px;
      background: rgba(0, 229, 255, 0.05);
      color: var(--fg);
      font-size: 11px;
    }
    .collaboration-judgements i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
    .matrix-scroll { overflow: auto; border: 1px solid var(--border); border-radius: 9px; }
    .relationship-matrix { width: 100%; min-width: 820px; border-collapse: collapse; table-layout: fixed; }
    .relationship-matrix th, .relationship-matrix td { height: 48px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    .relationship-matrix thead th { width: 64px; padding: 5px; background: rgba(255,255,255,.035); color: var(--muted); font-size: 9px; font-weight: 700; }
    .relationship-matrix thead th span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .relationship-matrix .matrix-corner { width: 180px; padding: 10px; text-align: left; }
    .relationship-matrix tbody th { width: 180px; padding: 8px 10px; background: rgba(255,255,255,.025); text-align: left; }
    .relationship-matrix tbody th span, .relationship-matrix tbody th small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .relationship-matrix tbody th span { color: var(--fg); font-size: 11px; }
    .relationship-matrix tbody th small { margin-top: 2px; color: var(--muted); font-size: 9px; font-weight: 500; }
    .matrix-cell { text-align: center; color: transparent; font-size: 11px; font-weight: 800; transition: background 150ms ease, color 150ms ease, opacity 150ms ease; }
    .matrix-cell.has-relation { background: rgba(0,229,255,calc(.08 + var(--relation-strength) * .32)); color: var(--fg); cursor: pointer; }
    .matrix-cell.has-relation:hover, .matrix-cell.has-relation.is-active { background: rgba(0,229,255,.5); color: #fff; }
    .matrix-self { text-align: center; color: rgba(148,163,184,.35); background: rgba(255,255,255,.015); }
    .relationship-matrix tr.is-muted, .relationship-matrix .matrix-cell.is-muted { opacity: .28; }

    .verification-summary { display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px; color: var(--muted); font-size: 11px; }
    .verification-summary strong { color: var(--success); font-size: 21px; }
    .verification-summary .danger-text { margin-left: 18px; color: var(--danger); }
    .verification-grid { overflow: auto; border: 1px solid var(--border); border-radius: 9px; }
    .verification-row { display: grid; grid-template-columns: minmax(200px, 1.5fr) 80px 100px 120px minmax(130px, .8fr); min-width: 720px; min-height: 48px; align-items: center; border-bottom: 1px solid var(--border); }
    .verification-row:last-child { border-bottom: 0; }
    .verification-row > span { min-width: 0; padding: 9px 12px; font-size: 11px; }
    .verification-row > span + span { border-left: 1px solid var(--border); }
    .verification-row strong, .verification-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .verification-row small { margin-top: 2px; color: var(--muted); }
    .verification-head { min-height: 36px; background: rgba(255,255,255,.035); color: var(--muted); font-weight: 700; }
    .verification-row > span:last-child { display: flex; align-items: center; gap: 7px; font-weight: 700; }
    .verification-row > span:last-child i { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; }
    .coverage-covered > span:last-child { color: var(--success); }
    .coverage-covered > span:last-child i { background: var(--success); }
    .coverage-partial > span:last-child { color: var(--warn); }
    .coverage-partial > span:last-child i { background: var(--warn); }
    .coverage-blind { background: rgba(255,23,68,.025); }
    .coverage-blind > span:last-child { color: var(--danger); }
    .coverage-blind > span:last-child i { background: var(--danger); }

    .primary-understanding-grid {
      grid-template-columns: minmax(0, 1.6fr) minmax(300px, 0.7fr);
    }

    .capability-description {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
      margin-top: 8px;
    }

    .capability-state-line {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      color: var(--muted);
      font-size: 11px;
    }

    .capability-state-line strong.formed,
    .capability-state-line strong.stable { color: var(--success); }
    .capability-state-line strong.growing { color: var(--accent); }
    .capability-state-line strong.watch { color: var(--warn); }
    .capability-state-line strong.attention,
    .capability-state-line strong.blocked { color: var(--attention); }
    .capability-state-line strong.muted { color: var(--muted); }

    .roadmap-state {
      flex-shrink: 0;
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
    }

    .roadmap-state.completed { color: var(--success); }
    .roadmap-state.running,
    .roadmap-state.in-progress { color: var(--accent); }
    .roadmap-state.failed { color: var(--attention); }

    .code-footprint-panel { margin-bottom: 20px; }

    .focus-area-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
    }

    .focus-title {
      justify-content: flex-start;
    }

    .focus-metrics {
      margin-top: 0;
      justify-content: flex-end;
      min-width: 220px;
    }

    .detail-section-title {
      margin: 8px 0 12px;
    }

    button.btn-refresh {
      background: rgba(0, 229, 255, 0.1);
      border: 1px solid rgba(0, 229, 255, 0.28);
      border-radius: 8px;
      color: #d7f3ff;
      padding: 8px 16px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font);
      font-size: 13px;
      font-weight: 600;
      transition: all 0.3s;
    }

    button.btn-refresh:hover {
      background: #00e5ff;
      border-color: #00e5ff;
      color: #000;
      box-shadow: 0 0 12px rgba(0, 229, 255, 0.35);
    }

    /* Stats Banner */
    .stats-banner {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      backdrop-filter: blur(8px);
      text-align: center;
      transition: all 0.3s;
    }

    .stat-card:hover {
      border-color: rgba(0, 229, 255, 0.2);
      transform: translateY(-2px);
    }

    .stat-card .stat-val {
      display: block;
      font-size: 24px;
      font-weight: 700;
      color: var(--fg);
      margin-bottom: 4px;
    }

    .stat-card .stat-val.signals-count {
      color: var(--attention);
    }

    .stat-card .stat-label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Layout Grid */
    .dashboard-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 24px;
    }

    .detail-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      align-items: start;
    }

    .left-col,
    .right-col,
    .panel {
      min-width: 0;
    }

    @media (max-width: 900px) {
      .dashboard-grid {
        grid-template-columns: 1fr;
      }
      .detail-grid { grid-template-columns: 1fr; }
      .understanding-shell,
      .growth-v2-grid,
      .orientation-grid,
      .focus-area-row {
        grid-template-columns: 1fr;
      }
      .capability-health-grid { grid-template-columns: 1fr; }
      .focus-metrics {
        justify-content: flex-start;
        min-width: 0;
      }
    }

    @media (max-width: 600px) {
      .growth-canvas { padding: 16px; }
      header {
        align-items: flex-start;
        flex-wrap: wrap;
        gap: 12px;
      }
      header > div:first-child {
        min-width: 0;
        align-items: flex-start !important;
      }
      .brand-wordmark {
        width: 96px;
        height: auto;
      }
      .header-actions {
        width: 100%;
      }
      button.btn-refresh {
        width: 100%;
        min-height: 44px;
        justify-content: center;
      }
      .journey-track { grid-template-columns: 1fr; gap: 10px; }
      .journey-stage:not(:last-child)::after { display: none; }
      .timeline-stats,
      .diff-stats { flex-wrap: wrap; }
    }

    .panel {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      backdrop-filter: blur(12px);
      margin-bottom: 24px;
    }

    .panel-title {
      font-size: 16px;
      font-weight: 700;
      margin-top: 0;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
      color: var(--accent);
    }

    /* Module Matrix */
    .module-space-panel { margin-bottom: 20px; }

    .module-space-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin: -4px 0 14px;
      color: var(--muted);
      font-size: 11px;
    }

    .module-space-legend span { display: inline-flex; align-items: center; gap: 5px; }

    .module-matrix {
      display: flex;
      flex-wrap: wrap;
      align-items: stretch;
      gap: 7px;
      min-height: 330px;
    }

    .module-card {
      flex: var(--tile-weight, 1) 1 170px;
      min-width: 150px;
      min-height: 118px;
      background: rgba(255, 255, 255, 0.018);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 14px;
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
      position: relative;
      overflow: hidden;
    }

    .module-card.tile-dominant { min-height: 245px; flex-basis: 42%; }
    .module-card.tile-large { min-height: 180px; flex-basis: 28%; }
    .module-card.tile-medium { min-height: 140px; flex-basis: 21%; }
    .module-card.tile-small { min-height: 112px; flex-basis: 16%; }

    .module-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: var(--muted);
    }

    .module-card::after {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: 0.16;
      background-image: repeating-linear-gradient(135deg, transparent 0 9px, currentColor 9px 10px);
      mask-image: linear-gradient(to bottom, transparent 25%, black 100%);
    }

    .module-card.signal-stable::after { opacity: 0; }
    .module-card.signal-growing { color: var(--accent); }
    .module-card.signal-watch { color: var(--warn); }
    .module-card.signal-attention { color: var(--attention); }
    .module-card.signal-blocked { color: var(--danger); }

    .module-card.signal-stable::before { background: var(--success); }
    .module-card.signal-growing::before { background: var(--accent); }
    .module-card.signal-watch::before { background: var(--warn); }
    .module-card.signal-attention::before { background: var(--attention); }
    .module-card.signal-blocked::before { background: var(--danger); }

    .module-card:hover {
      background: rgba(255, 255, 255, 0.03);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.26);
    }

    .module-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .module-card.signal-stable:hover { border-color: rgba(0, 230, 118, 0.3); box-shadow: 0 8px 30px rgba(0, 230, 118, 0.08); }
    .module-card.signal-growing:hover { border-color: rgba(0, 229, 255, 0.3); box-shadow: 0 8px 30px rgba(0, 229, 255, 0.08); }
    .module-card.signal-watch:hover { border-color: rgba(255, 214, 0, 0.3); box-shadow: 0 8px 30px rgba(255, 214, 0, 0.08); }
    .module-card.signal-attention:hover { border-color: rgba(255, 145, 0, 0.3); box-shadow: 0 8px 30px rgba(255, 145, 0, 0.08); }
    .module-card.signal-blocked:hover { border-color: rgba(255, 23, 68, 0.3); box-shadow: 0 8px 30px rgba(255, 23, 68, 0.08); }

    .module-card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .module-title {
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--fg);
    }

    .signal-tag {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .signal-mark { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }

    .module-card.signal-stable .signal-tag { color: var(--success); background: rgba(0, 230, 118, 0.1); }
    .module-card.signal-growing .signal-tag { color: var(--accent); background: rgba(0, 229, 255, 0.1); }
    .module-card.signal-watch .signal-tag { color: var(--warn); background: rgba(255, 214, 0, 0.1); }
    .module-card.signal-attention .signal-tag { color: var(--attention); background: rgba(255, 145, 0, 0.1); }
    .module-card.signal-blocked .signal-tag { color: var(--danger); background: rgba(255, 23, 68, 0.1); }

    .module-meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 12px;
    }

    .module-facts {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 11px;
    }

    .module-facts span {
      padding: 3px 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.04);
    }

    .meta-item {
      display: flex;
      flex-direction: column;
    }

    .meta-label {
      font-size: 11px;
      color: var(--muted);
    }

    .meta-val {
      font-size: 14px;
      font-weight: 600;
    }

    .module-role-tag {
      font-size: 11px;
      color: var(--muted);
      border-top: 1px solid rgba(255, 255, 255, 0.04);
      padding-top: 8px;
    }

    /* Gaps */
    .gap-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 10px;
    }

    .gap-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .gap-badge.badge-watch { color: var(--warn); background: rgba(255, 214, 0, 0.1); border: 1px solid rgba(255, 214, 0, 0.2); }
    .gap-badge.badge-attention { color: var(--attention); background: rgba(255, 145, 0, 0.1); border: 1px solid rgba(255, 145, 0, 0.2); }
    .gap-badge.badge-blocked { color: var(--danger); background: rgba(255, 23, 68, 0.1); border: 1px solid rgba(255, 23, 68, 0.2); }

    .gap-content {
      flex: 1;
    }

    .gap-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 2px;
    }

    .gap-desc {
      font-size: 12px;
      color: var(--muted);
    }

    .gap-source {
      font-size: 10px;
      background: rgba(255, 255, 255, 0.04);
      padding: 1px 4px;
      border-radius: 2px;
      margin-left: 6px;
    }

    .empty-state-healthy {
      padding: 24px;
      text-align: center;
      background: rgba(0, 230, 118, 0.03);
      border: 1px dashed rgba(0, 230, 118, 0.2);
      border-radius: 12px;
      color: var(--success);
      font-weight: 500;
    }

    .empty-state-healthy .codicon {
      margin-right: 6px;
    }

    /* Capabilities */
    .capabilities-list {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .cap-card {
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }

    .cap-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 4px;
    }

    .cap-stage {
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 8px;
    }

    .cap-modules {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .cap-mod-badge {
      font-size: 10px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: 4px;
      color: var(--muted);
    }

    /* Timeline */
    .timeline {
      position: relative;
      padding-left: 20px;
      margin-left: 8px;
      border-left: 1px solid var(--border);
    }

    .timeline-item {
      position: relative;
      margin-bottom: 20px;
    }

    .timeline-marker {
      position: absolute;
      left: -25px;
      top: 4px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--border);
      border: 2px solid var(--vscode-editor-background, var(--bg-dark));
      transition: all 0.3s;
    }

    .timeline-item.is-latest .timeline-marker {
      background: var(--accent);
      box-shadow: 0 0 8px var(--accent);
    }

    .timeline-time {
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .latest-tag {
      font-size: 9px;
      background: rgba(0, 229, 255, 0.1);
      color: var(--accent);
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 700;
    }

    .timeline-reason {
      font-size: 12px;
      margin-bottom: 6px;
    }

    .timeline-stats {
      font-size: 11px;
      color: var(--muted);
      display: flex;
      gap: 12px;
    }

    /* Diff Card */
    .diff-card {
      background: rgba(0, 229, 255, 0.02);
      border: 1px solid rgba(0, 229, 255, 0.1);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 24px;
    }

    .diff-head {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 12px;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .diff-stats {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .diff-stat {
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .diff-num {
      font-size: 20px;
      font-weight: 800;
    }

    .diff-num.pos { color: var(--success); }
    .diff-num.neg { color: var(--danger); }

    .diff-label {
      font-size: 11px;
      color: var(--muted);
    }

    .diff-stat-details {
      font-size: 11px;
      color: var(--muted);
      border-left: 1px solid var(--border);
      padding-left: 16px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .pos { color: var(--success); }
    .neg { color: var(--danger); }

    .empty-state {
      text-align: center;
      padding: 16px;
      color: var(--muted);
      font-size: 12px;
      border: 1px dashed var(--border);
      border-radius: 8px;
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <header>
      <div style="display: flex; align-items: center; gap: 16px; min-width: 0;">
        <h1 class="brand-title"><img class="brand-wordmark" src="${wordmarkUri}" width="132" height="34" alt="SoloMap"></h1>
        <div class="header-divider"></div>
        <div class="page-heading">${escapeHtml(t.title)}</div>
      </div>
      <div class="header-actions">
        <select class="project-select" id="project-select" aria-label="${escapeHtml(t.currentProject)}">
          ${projects.map((project) => `<option value="${escapeHtml(project.path)}"${project.path === viewModel.projectPath ? ' selected' : ''}>${escapeHtml(project.name)}</option>`).join('')}
        </select>
        <button type="button" class="btn-refresh" id="btn-refresh"><span class="codicon codicon-refresh"></span> ${escapeHtml(t.refreshBtn)}</button>
      </div>
    </header>

    <main class="growth-canvas">
      <div class="growth-content">

        <section class="project-orientation">
          <div class="section-kicker">${escapeHtml(t.understandingTitle)}</div>
          <div class="orientation-grid">
            <div class="project-purpose">
              <span>${escapeHtml(t.projectPurpose)}</span>
              <h2>${escapeHtml(projectPurpose)}</h2>
            </div>
            <div class="roadmap-progress">
              <div class="progress-head"><span>${escapeHtml(t.roadmapProgress)}</span><strong>${orientation.completedSteps}/${orientation.totalSteps}</strong></div>
              <div class="progress-track"><span style="width: ${progressPercent}%"></span></div>
              <div class="progress-caption">${progressPercent}% · ${orientation.completedSteps} ${escapeHtml(t.stepsCompleted)}</div>
            </div>
            <div class="current-work">
              <span>${escapeHtml(t.currentWork)} · ${escapeHtml(currentStageLabel)}</span>
              <strong>${escapeHtml(currentStepLabel)}</strong>
              <em>${escapeHtml(currentRoadmapStatus)}</em>
            </div>
          </div>
        </section>

        <section class="journey-panel">
          <h2 class="panel-title"><span class="codicon codicon-map"></span> ${escapeHtml(t.journeyTitle)}</h2>
          <div class="journey-track">${journeyHtml}</div>
        </section>

        <div class="understanding-shell">
          <section class="understanding-main">
            <div class="section-kicker">${escapeHtml(isZh ? '项目现在怎样' : 'Where the project stands')}</div>
            <h2>${escapeHtml(insightHeadline)}</h2>
            <p>${escapeHtml(insightBody)}</p>
            <div class="understanding-chips">
              <span>${escapeHtml(insightHealthLabel)}</span>
              <span>${escapeHtml(insightFocusLabel)}</span>
              <span>${escapeHtml(insightEvidenceLabel)}</span>
            </div>
          </section>
          <section class="priority-actions">
            <div class="priority-title"><span class="codicon codicon-checklist"></span> ${escapeHtml(t.priorityActions)}</div>
            <div class="priority-list">${actionCardsHtml}</div>
          </section>
        </div>

        <section class="growth-v2-panel">
          <h2 class="panel-title"><span class="codicon codicon-milestone"></span> ${escapeHtml(t.capabilityMap)}</h2>
          <div class="capability-health-grid">${capabilityHealthHtml}</div>
        </section>

        <section class="panel module-space-panel">
          <h2 class="panel-title"><span class="codicon codicon-layout"></span> ${escapeHtml(t.modulesSignalMatrix)}</h2>
          <div class="module-space-legend" aria-label="${escapeHtml(t.modulesSignalMatrix)}">
            <span><i class="signal-mark" style="color:var(--success)"></i>${escapeHtml(formatMappedLabel(t.signalLabels, 'stable'))}</span>
            <span><i class="signal-mark" style="color:var(--accent)"></i>${escapeHtml(formatMappedLabel(t.signalLabels, 'growing'))}</span>
            <span><i class="signal-mark" style="color:var(--warn)"></i>${escapeHtml(formatMappedLabel(t.signalLabels, 'watch'))}</span>
            <span><i class="signal-mark" style="color:var(--attention)"></i>${escapeHtml(formatMappedLabel(t.signalLabels, 'attention'))}</span>
            <span><i class="signal-mark" style="color:var(--danger)"></i>${escapeHtml(formatMappedLabel(t.signalLabels, 'blocked'))}</span>
          </div>
          <div class="module-matrix">${moduleCardsHtml}</div>
        </section>

        ${architectureHtml}

        <div class="detail-section-title">${escapeHtml(t.detailData)}</div>

        <div class="stats-banner">
      <div class="stat-card">
        <span class="stat-val">${totalFiles}</span>
        <span class="stat-label">${escapeHtml(t.totalFiles)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-val">${totalLoc.toLocaleString()}</span>
        <span class="stat-label">${escapeHtml(t.loc)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-val">${totalModules}</span>
        <span class="stat-label">${escapeHtml(t.modules)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-val">${totalCapabilities}</span>
        <span class="stat-label">${escapeHtml(t.capabilities)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-val">${totalPackages}</span>
        <span class="stat-label">${escapeHtml(t.packages)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-val signals-count">${totalSignals}</span>
        <span class="stat-label">${escapeHtml(t.signals)}</span>
      </div>
    </div>

    ${diffHtml}

    <div class="detail-grid">
        <div class="panel">
          <h2 class="panel-title"><span class="codicon codicon-history"></span> ${escapeHtml(t.snapshotHistory)}</h2>
          <div class="timeline">
            ${historyHtml}
          </div>
        </div>
    </div>
      </div>
    </main>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshGrowth' });
    });
    document.getElementById('project-select').addEventListener('change', (event) => {
      vscode.postMessage({ command: 'project.select', projectPath: event.target.value });
    });
    document.querySelectorAll('[data-roadmap-target]').forEach((button) => button.addEventListener('click', () => {
      vscode.postMessage({ command: 'growth.openRoadmapStep', nodeId: button.dataset.roadmapTarget });
    }));

    document.querySelectorAll('.matrix-cell.has-relation').forEach((cell) => cell.addEventListener('click', () => {
      const source = cell.dataset.matrixSource;
      const target = cell.dataset.matrixTarget;
      document.querySelectorAll('[data-matrix-row]').forEach((row) => {
        row.classList.toggle('is-muted', row.dataset.matrixRow !== source && row.dataset.matrixRow !== target);
      });
      document.querySelectorAll('.matrix-cell').forEach((item) => {
        const connected = item.dataset.matrixSource === source
          || item.dataset.matrixTarget === source
          || item.dataset.matrixSource === target
          || item.dataset.matrixTarget === target;
        item.classList.toggle('is-muted', !connected);
        item.classList.toggle('is-active', item === cell);
      });
    }));

  </script>
</body>
</html>
  `;
}
