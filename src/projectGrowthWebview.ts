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
    title: "项目代码生长图",
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
      git: "Git 变更"
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
      git: "Git"
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
    }
  }
};

function formatMappedLabel(labels: Record<string, string>, value: string): string {
  const normalized = String(value || '').trim();
  return labels[normalized] || normalized.replace(/_/g, ' ');
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

  // Render module cards
  let moduleCardsHtml = '';
  if (viewModel.modules && viewModel.modules.length > 0) {
    moduleCardsHtml = viewModel.modules.map(mod => {
      let signalClass = 'signal-stable';
      if (mod.signal === 'watch') signalClass = 'signal-watch';
      if (mod.signal === 'attention') signalClass = 'signal-attention';
      if (mod.signal === 'blocked') signalClass = 'signal-blocked';
      if (mod.signal === 'growing') signalClass = 'signal-growing';

      return `
        <div class="module-card ${signalClass}">
          <div class="module-card-head">
            <span class="module-title"><span class="codicon codicon-symbol-module"></span> ${escapeHtml(mod.label)}</span>
            <span class="signal-tag">${escapeHtml(formatMappedLabel(t.signalLabels, mod.signal))}</span>
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
          <div class="module-role-tag">${escapeHtml(t.role)}: ${escapeHtml(formatMappedLabel(t.roleLabels, mod.role))}</div>
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
      --bg: #090a10;
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

    @media (max-width: 900px) {
      .dashboard-grid {
        grid-template-columns: 1fr;
      }
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
    .module-matrix {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 16px;
    }

    .module-card {
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }

    .module-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: var(--muted);
    }

    .module-card.signal-stable::before { background: var(--success); }
    .module-card.signal-growing::before { background: var(--accent); }
    .module-card.signal-watch::before { background: var(--warn); }
    .module-card.signal-attention::before { background: var(--attention); }
    .module-card.signal-blocked::before { background: var(--danger); }

    .module-card:hover {
      transform: translateY(-4px) scale(1.02);
      background: rgba(255, 255, 255, 0.03);
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
    }

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
    }

    .signal-tag {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
    }

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
  <div class="neon-glow-container"></div>
  <div class="container">
    <header>
      <div style="display: flex; align-items: center; gap: 16px;">
        <h1 class="brand-title"><img class="brand-wordmark" src="${wordmarkUri}" width="132" height="34" alt="SoloMap"></h1>
        <div style="width: 1px; height: 20px; background: var(--border);"></div>
        <div>
          <h2 style="margin: 0; font-size: 16px; font-weight: 800; background: linear-gradient(135deg, var(--accent), var(--accent-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: -0.5px; line-height: 1.2;">${escapeHtml(t.title)}: ${escapeHtml(projectName)}</h2>
          <div class="sub-heading">${escapeHtml(t.subTitle)}</div>
        </div>
      </div>
      <div class="header-actions">
        <button type="button" class="btn-refresh" id="btn-refresh"><span class="codicon codicon-refresh"></span> ${escapeHtml(t.refreshBtn)}</button>
      </div>
    </header>

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
          <h2 class="panel-title"><span class="codicon codicon-grid"></span> ${escapeHtml(t.modulesSignalMatrix)}</h2>
          <div class="module-matrix">
            ${moduleCardsHtml}
          </div>
        </div>

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
