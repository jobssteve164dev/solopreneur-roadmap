import * as path from 'path';
import type * as vscode from 'vscode';
import { ProjectGrowthViewModel } from './projectGrowth';

function joinExtensionUri(context: vscode.ExtensionContext, ...segments: string[]): vscode.Uri {
  const base = context.extensionUri as any;
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
    architectureEdges: "系统架构与依赖调用链",
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
    architectureEdges: "Architecture & Dependency Edges",
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
  isZh: boolean
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
        ? area.summary
        : `${formatMappedLabel(t.roleLabels, area.summary.split(' · ')[0])} · ${area.files} files · ${area.loc.toLocaleString()} LOC · ${area.tests} tests`;
      return `
        <div class="focus-area-row ${statusClass(area.status)}">
          <div class="focus-main">
            <div class="focus-title">${escapeHtml(area.label)} <span class="status-pill ${statusClass(area.status)}">${escapeHtml(formatMappedLabel(t.growthStatusLabels, area.status))}</span></div>
            <div class="focus-summary">${escapeHtml(focusSummary)}</div>
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
      const roleLabel = formatMappedLabel(t.roleLabels, mod.role);
      return `
        <div class="module-card ${signalClass} ${tileSize}" style="--tile-weight:${tileWeight}" tabindex="0" role="group" aria-label="${escapeHtml(`${mod.label}, ${signalLabel}, ${mod.loc} ${t.lines}`)}">
          <div class="module-card-head">
            <span class="module-title"><span class="codicon codicon-symbol-module"></span> ${escapeHtml(mod.label)}</span>
            <span class="signal-tag"><span class="signal-mark"></span>${escapeHtml(signalLabel)}</span>
          </div>
          <div class="module-meta-grid">
            <div class="meta-item">
              <span class="meta-label">${escapeHtml(t.files)}</span>
              <span class="meta-val">${mod.files}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">${escapeHtml(t.lines)}</span>
              <span class="meta-val">${mod.loc.toLocaleString()}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">${escapeHtml(t.tests)}</span>
              <span class="meta-val">${mod.tests}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">${escapeHtml(t.confidence)}</span>
              <span class="meta-val">${Math.round(mod.confidence * 100)}%</span>
            </div>
          </div>
          <div class="module-role-tag">${escapeHtml(roleLabel)}</div>
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

  // Render key dependency relationships
  let edgesHtml = '';
  if (viewModel.keyEdges && viewModel.keyEdges.length > 0) {
    edgesHtml = viewModel.keyEdges.map(edge => {
      const cleanSrc = edge.sourceId.replace(/^(file:|module:|package:)/, '');
      const cleanTgt = edge.targetId.replace(/^(file:|module:|package:)/, '');
      let kindBadge = 'edge-imports';
      if (edge.kind === 'tested_by') kindBadge = 'edge-tested';
      if (edge.kind === 'depends_on') kindBadge = 'edge-depends';
      
      return `
        <div class="edge-row">
          <span class="edge-node src" title="${escapeHtml(edge.sourceId)}">${escapeHtml(cleanSrc)}</span>
          <span class="edge-arrow-badge ${kindBadge}">${escapeHtml(formatMappedLabel(t.edgeLabels, edge.kind))}</span>
          <span class="edge-node tgt" title="${escapeHtml(edge.targetId)}">${escapeHtml(cleanTgt)}</span>
        </div>
      `;
    }).join('');
  } else {
    edgesHtml = `<div class="empty-state">${escapeHtml(t.emptyEdges)}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="${isZh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconsUri}" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <title>SoloMap: ${escapeHtml(t.title)}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #0f111a);
      --fg: #f8fafc;
      --muted: #94a3b8;
      --border: rgba(255, 255, 255, 0.08);
      --glass-bg: rgba(255, 255, 255, 0.02);
      --glass-panel: rgba(15, 23, 42, 0.65);
      --accent: #00f0ff;
      --accent-purple: #7c4dff;
      --success: #00e676;
      --warn: #ffd600;
      --attention: #ff9100;
      --danger: #ff1744;
      --font: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font);
      line-height: 1.5;
      overflow-x: hidden;
    }

    /* Ambient background glow */
    .neon-glow-container {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: -10;
      overflow: hidden;
      pointer-events: none;
    }
    .neon-glow-container::before, .neon-glow-container::after {
      content: '';
      position: absolute;
      width: 400px;
      height: 400px;
      border-radius: 50%;
      filter: blur(140px);
      opacity: 0.1;
      animation: floatNeon 20s infinite alternate ease-in-out;
    }
    .neon-glow-container::before {
      background: radial-gradient(circle, var(--accent), var(--accent-purple));
      top: -5%; left: 5%;
    }
    .neon-glow-container::after {
      background: radial-gradient(circle, #ff007c, var(--accent-purple));
      bottom: -5%; right: 10%;
      animation-delay: -10s;
    }
    @keyframes floatNeon {
      0% { transform: translate(0, 0) scale(1); }
      100% { transform: translate(80px, 40px) scale(1.1); }
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
      position: relative;
      z-index: 1;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
    }

    .brand-title {
      margin: 0;
      display: flex;
      align-items: center;
    }

    .brand-wordmark {
      width: 132px;
      height: 34px;
      flex-shrink: 0;
    }

    .sub-heading {
      color: var(--muted);
      font-size: 13px;
      margin-top: 4px;
    }

    .header-actions {
      display: flex;
      gap: 10px;
    }

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
      background: var(--bg);
      color: var(--muted);
    }

    .journey-stage.completed .journey-marker { color: var(--success); border-color: rgba(0, 230, 118, 0.4); }
    .journey-stage.active .journey-marker { color: var(--accent); border-color: rgba(0, 240, 255, 0.5); }

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
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      backdrop-filter: blur(12px);
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
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.02);
      padding: 12px;
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
      border-color: rgba(0, 240, 255, 0.22);
      background: rgba(0, 240, 255, 0.08);
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
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--fg);
      padding: 8px 16px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font);
      font-size: 13px;
      font-weight: 500;
      transition: all 0.3s;
    }

    button.btn-refresh:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.2);
      box-shadow: 0 0 12px rgba(0, 240, 255, 0.15);
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
      border-radius: 12px;
      padding: 16px;
      backdrop-filter: blur(8px);
      text-align: center;
      transition: all 0.3s;
    }

    .stat-card:hover {
      border-color: rgba(0, 240, 255, 0.2);
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

    .left-col,
    .right-col,
    .panel {
      min-width: 0;
    }

    @media (max-width: 900px) {
      .dashboard-grid {
        grid-template-columns: 1fr;
      }
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
      .container { padding: 16px; }
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
      .sub-heading {
        overflow-wrap: anywhere;
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
      .edge-node { max-width: 110px; }
    }

    .panel {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
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
    .module-card.signal-growing:hover { border-color: rgba(0, 240, 255, 0.3); box-shadow: 0 8px 30px rgba(0, 240, 255, 0.08); }
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
    .module-card.signal-growing .signal-tag { color: var(--accent); background: rgba(0, 240, 255, 0.1); }
    .module-card.signal-watch .signal-tag { color: var(--warn); background: rgba(255, 214, 0, 0.1); }
    .module-card.signal-attention .signal-tag { color: var(--attention); background: rgba(255, 145, 0, 0.1); }
    .module-card.signal-blocked .signal-tag { color: var(--danger); background: rgba(255, 23, 68, 0.1); }

    .module-meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 12px;
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
      border: 2px solid var(--bg);
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
      background: rgba(0, 240, 255, 0.1);
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
      background: rgba(0, 240, 255, 0.02);
      border: 1px solid rgba(0, 240, 255, 0.1);
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

    /* Edge Table */
    .edge-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .edge-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      min-width: 0;
      gap: 8px;
    }

    .edge-node {
      font-family: monospace;
      color: var(--muted);
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .edge-node.src {
      color: var(--fg);
    }

    .edge-arrow-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 3px;
      text-transform: uppercase;
    }

    .edge-arrow-badge.edge-imports { color: var(--accent); background: rgba(0, 240, 255, 0.1); }
    .edge-arrow-badge.edge-tested { color: var(--success); background: rgba(0, 230, 118, 0.1); }
    .edge-arrow-badge.edge-depends { color: var(--accent-purple); background: rgba(124, 77, 255, 0.1); }

    .empty-state {
      text-align: center;
      padding: 16px;
      color: var(--muted);
      font-size: 12px;
      border: 1px dashed var(--border);
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div style="display: flex; align-items: center; gap: 16px;">
        <h1 class="brand-title"><img class="brand-wordmark" src="${wordmarkUri}" width="132" height="34" alt="SoloMap"></h1>
            <div style="width: 1px; height: 20px; background: var(--border);"></div>
            <div>
              <h2 style="margin: 0; font-size: 16px; font-weight: 800; color: var(--fg); letter-spacing: 0; line-height: 1.2;">${escapeHtml(t.title)}: ${escapeHtml(projectName)}</h2>
              <div class="sub-heading">${escapeHtml(t.currentProject)} · ${escapeHtml(projectName)}${projectPath ? ` · ${escapeHtml(t.projectPath)}: ${escapeHtml(projectPath)}` : ''}</div>
            </div>
          </div>
      <div class="header-actions">
        <button type="button" class="btn-refresh" id="btn-refresh"><span class="codicon codicon-refresh"></span> ${escapeHtml(t.refreshBtn)}</button>
          </div>
        </header>

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

        <section class="growth-v2-panel priority-actions code-footprint-panel">
          <div class="priority-title"><span class="codicon codicon-checklist"></span> ${escapeHtml(t.priorityActions)}</div>
          <div class="priority-list">${actionCardsHtml}</div>
        </section>

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

    <div class="dashboard-grid">
      <div class="left-col">
        <div class="panel">
          <h2 class="panel-title"><span class="codicon codicon-git-commit"></span> ${escapeHtml(t.architectureEdges)}</h2>
          <div class="edge-list">
            ${edgesHtml}
          </div>
        </div>
      </div>

      <div class="right-col">
        <div class="panel">
          <h2 class="panel-title"><span class="codicon codicon-warning"></span> ${escapeHtml(t.structuralGaps)}</h2>
          <div class="gaps-list">
            ${gapsHtml}
          </div>
        </div>

        <div class="panel">
          <h2 class="panel-title"><span class="codicon codicon-milestone"></span> ${escapeHtml(t.linkedCapabilities)}</h2>
          <div class="capabilities-list">
            ${capabilitiesHtml}
          </div>
        </div>

        <div class="panel">
          <h2 class="panel-title"><span class="codicon codicon-history"></span> ${escapeHtml(t.snapshotHistory)}</h2>
          <div class="timeline">
            ${historyHtml}
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshGrowth' });
    });
  </script>
</body>
</html>
  `;
}
