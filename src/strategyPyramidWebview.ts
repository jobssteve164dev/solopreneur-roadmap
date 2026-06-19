import * as path from 'path';
import type * as vscode from 'vscode';

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

function strategyEscapeHtml(value: string | number): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getStrategyPyramidWebviewHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  snapshot: any
): string {
  const codiconsUri = webview.asWebviewUri(joinExtensionUri(context, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
  const wordmarkUri = webview.asWebviewUri(joinExtensionUri(context, 'resources', 'logo_with_text.svg'));
  const stageTitle = snapshot.stageTitle || '组合判断期';
  const mainJudgment = snapshot.mainJudgment || '从项目组合判断现在该加码、收缩、暂停、转向，还是孵化新方向。';
  const strategicAction = snapshot.strategicAction || '选择一个项目补上最缺的市场或反馈信号。';
  const constraint = snapshot.constraint || '不要让项目数量替代真实验证。';
  const topProjects: any[] = snapshot.projects || [];

  const loops: any[] = snapshot.loops || [];
  const layers: any[] = snapshot.layers || [];
  const moves: any[] = snapshot.moves || [];
  const abilities: any[] = snapshot.abilities || [];
  const structureSignals: any[] = snapshot.structureSignals || [];
  const riskSignals: any[] = snapshot.riskSignals || [];
  const opportunitySignals: any[] = snapshot.opportunitySignals || [];
  const scenarios: any[] = snapshot.scenarios || [];
  const recommendedScenarioPath = snapshot.recommendedScenarioPath || '';

  const stageProfile = snapshot.stageProfile || {
    title: stageTitle,
    priorityLayer: '中层：项目组合 + 收入结构',
    keyMetric: '哪些项目在积累复利，哪些在消耗注意力',
    defaultQuestion: '应该加码、收缩还是暂停？'
  };

  const projectRoleData = topProjects.map((project) => ({
    name: project.name,
    path: project.path,
    role: project.role,
    businessStage: project.businessStage,
    revenueTier: project.revenueTier,
    timeLoad: project.timeLoad,
    actualMinutes: (project as any).actualMinutes || 0,
    strategicRelation: project.strategicRelation,
    action: project.action,
    risk: project.risk || '暂无明显结构风险',
    progressPercent: project.progressPercent,
    roleScores: project.roleScores,
    advice: project.advice,
    evidence: project.evidence && project.evidence.length ? project.evidence : ['等待更多推进信号'],
    abilities: project.abilities && project.abilities.length ? project.abilities : []
  }));
  const projectRoleJson = JSON.stringify(projectRoleData).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

  // 构建五层结构的详细数据，用于在金字塔点击时动态展示
  const layersJson = JSON.stringify(layers).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconsUri}" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <title>一人公司战略驾驶舱</title>
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
      --danger: #ff1744;
      --font: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    * { box-sizing: border-box; }

    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(148, 163, 184, 0.28) transparent;
    }

    *::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    *::-webkit-scrollbar-track {
      background: transparent;
    }

    *::-webkit-scrollbar-thumb {
      border: 2px solid transparent;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.26);
      background-clip: content-box;
    }

    *::-webkit-scrollbar-thumb:hover {
      background: rgba(148, 163, 184, 0.42);
      background-clip: content-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font);
      overflow-x: hidden;
      line-height: 1.5;
    }

    /* 星空微光发光霓虹 */
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
      width: 500px;
      height: 500px;
      border-radius: 50%;
      filter: blur(150px);
      opacity: 0.12;
      animation: floatNeon 25s infinite alternate ease-in-out;
    }
    .neon-glow-container::before {
      background: radial-gradient(circle, var(--accent), var(--accent-purple));
      top: -10%; left: 10%;
    }
    .neon-glow-container::after {
      background: radial-gradient(circle, #ff007c, var(--accent-purple));
      bottom: -10%; right: 15%;
      animation-delay: -12s;
    }
    @keyframes floatNeon {
      0% { transform: translate(0, 0) scale(1); }
      100% { transform: translate(120px, 60px) scale(1.15); }
    }

    .shell {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 24px;
      position: relative;
      z-index: 1;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 28px;
    }

    h1 {
      margin: 0;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, var(--accent), var(--accent-purple));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .brand-wordmark {
      width: 132px;
      height: auto;
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

    button.btn-header {
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
    button.btn-header:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }

    /* Tabs 导航 */
    .tabs-nav {
      display: flex;
      gap: 6px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      padding: 10px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      font-family: var(--font);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tab-btn:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.02);
    }
    .tab-btn.active {
      color: var(--accent);
      border-color: rgba(0, 240, 255, 0.15);
      background: rgba(0, 240, 255, 0.04);
      box-shadow: inset 0 0 10px rgba(0, 240, 255, 0.08);
      text-shadow: 0 0 8px rgba(0, 240, 255, 0.3);
    }

    /* Tab 内容切换 */
    .tab-content {
      display: none;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .tab-content.active {
      display: block;
      opacity: 1;
      transform: translateY(0);
    }

    /* Glassmorphism 面板 */
    .glass-card {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      backdrop-filter: blur(12px);
      margin-bottom: 18px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    }

    /* TAB 1: 驾驶舱 */
    .dashboard-top {
      display: grid;
      grid-template-columns: 1.8fr 1.2fr;
      gap: 16px;
      margin-bottom: 18px;
    }

    .cockpit-main {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .state-badge {
      display: inline-flex;
      align-items: center;
      border: 1px solid rgba(0, 240, 255, 0.2);
      background: rgba(0, 240, 255, 0.05);
      border-radius: 99px;
      padding: 4px 12px;
      color: #bffffc;
      font-size: 11px;
      font-weight: 700;
      margin-bottom: 12px;
      align-self: flex-start;
    }

    .cockpit-title {
      font-size: 22px;
      font-weight: 700;
      margin: 0;
      line-height: 1.4;
    }

    .cockpit-meta {
      font-size: 12px;
      color: var(--muted);
      margin-top: 8px;
    }

    .cockpit-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 18px;
    }
    .cockpit-item {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.01);
      padding: 12px 14px;
    }
    .cockpit-item span {
      display: block;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .cockpit-item strong {
      font-size: 14px;
      font-weight: 600;
      color: var(--fg);
    }

    .dashboard-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--fg);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .signal-item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 4px 12px;
      padding: 12px 0;
      border-top: 1px solid var(--border);
    }
    .signal-item:first-of-type { border-top: 0; padding-top: 0; }
    .signal-item strong { font-size: 13px; font-weight: 600; }
    .signal-item span {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 99px;
      border: 1px solid transparent;
    }
    .signal-item.strong span { color: var(--success); border-color: rgba(0, 230, 118, 0.15); background: rgba(0, 230, 118, 0.03); }
    .signal-item.watch span { color: var(--warn); border-color: rgba(255, 214, 0, 0.15); background: rgba(255, 214, 0, 0.03); }
    .signal-item.risk span { color: var(--danger); border-color: rgba(255, 23, 68, 0.15); background: rgba(255, 23, 68, 0.03); }
    .signal-item p {
      margin: 0;
      grid-column: 1 / -1;
      font-size: 12px;
      color: var(--muted);
    }

    .risk-alert {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 10px;
      border: 1px solid rgba(255,255,255,0.04);
      background: rgba(255,255,255,0.01);
    }
    .risk-alert.high { border-color: rgba(255, 23, 68, 0.15); background: rgba(255, 23, 68, 0.02); }
    .risk-alert.medium { border-color: rgba(255, 214, 0, 0.15); background: rgba(255, 214, 0, 0.02); }
    .risk-alert.healthy { border-color: rgba(0, 230, 118, 0.15); background: rgba(0, 230, 118, 0.02); }
    .risk-alert span.codicon { font-size: 16px; margin-top: 2px; }
    .risk-alert.high span.codicon { color: var(--danger); }
    .risk-alert.medium span.codicon { color: var(--warn); }
    .risk-alert.healthy span.codicon { color: var(--success); }
    .risk-alert div { font-size: 12px; }
    .risk-alert strong { display: block; font-size: 13px; font-weight: 600; margin-bottom: 2px; }
    .risk-alert p { margin: 0; color: var(--muted); }

    /* TAB 2: 战略金字塔 */
    .pyramid-wrapper {
      display: grid;
      grid-template-columns: 1.3fr 1.7fr;
      gap: 24px;
      align-items: start;
    }

    .pyramid-visual {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 30px 16px;
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      border-radius: 16px;
      position: relative;
    }

    .pyramid-layer {
      position: relative;
      width: var(--width);
      height: 54px;
      background: var(--grad);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      font-weight: 700;
      font-size: 12px;
      color: #fff;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3);
      padding: 0 16px;
      text-align: center;
      backdrop-filter: blur(8px);
    }
    .pyramid-layer:hover {
      transform: scale(1.03) translateY(-2px);
      border-color: rgba(255, 255, 255, 0.25);
      box-shadow: 0 8px 24px rgba(0, 240, 255, 0.15);
    }
    .pyramid-layer.selected {
      border-color: var(--accent);
      box-shadow: 0 0 20px var(--glow);
      transform: scale(1.04);
    }

    .pyramid-layer .focus-badge {
      position: absolute;
      right: -84px;
      top: 50%;
      transform: translateY(-50%);
      background: linear-gradient(135deg, #ffd600, #ff6d00);
      color: #000;
      font-size: 9px;
      font-weight: 800;
      padding: 2px 8px;
      border-radius: 99px;
      box-shadow: 0 0 10px rgba(255, 214, 0, 0.4);
      animation: pulseBadge 1.5s infinite alternate;
      pointer-events: none;
      white-space: nowrap;
    }
    @keyframes pulseBadge {
      0% { transform: translateY(-50%) scale(0.96); opacity: 0.8; }
      100% { transform: translateY(-50%) scale(1.04); opacity: 1; }
    }

    .layer-detail-card {
      min-height: 310px;
    }

    .layer-detail-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
    }

    .layer-detail-title {
      font-size: 18px;
      font-weight: 700;
      margin: 0;
    }

    .layer-detail-health {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 99px;
    }
    .layer-detail-health.strong { color: var(--success); background: rgba(0, 230, 118, 0.05); border: 1px solid rgba(0, 230, 118, 0.15); }
    .layer-detail-health.watch { color: var(--warn); background: rgba(255, 214, 0, 0.05); border: 1px solid rgba(255, 214, 0, 0.15); }
    .layer-detail-health.risk { color: var(--danger); background: rgba(255, 23, 68, 0.05); border: 1px solid rgba(255, 23, 68, 0.15); }

    .layer-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 16px;
    }
    .layer-grid-item {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.01);
    }
    .layer-grid-item span {
      display: block;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .layer-grid-item strong {
      font-size: 13px;
      font-weight: 600;
      color: var(--fg);
    }

    .layer-evidence-box {
      font-size: 12px;
      color: var(--muted);
      border-top: 1px solid var(--border);
      padding-top: 12px;
      margin-top: 12px;
    }

    .layer-support-title {
      font-weight: 700;
      font-size: 12px;
      color: var(--fg);
      margin-bottom: 6px;
    }
    .layer-support-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .layer-chip {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      color: var(--muted);
    }

    /* TAB 3: 项目组合 */
    .quadrants-container {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }

    .quadrant {
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      min-height: 400px;
      display: flex;
      flex-direction: column;
    }

    .quadrant-title-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .quadrant-name {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .quadrant.build .quadrant-name { color: var(--accent); }
    .quadrant.sell .quadrant-name { color: var(--success); }
    .quadrant.learn .quadrant-name { color: var(--warn); }
    .quadrant.improve .quadrant-name { color: var(--accent-purple); }

    .quadrant-count {
      font-size: 11px;
      background: rgba(255,255,255,0.04);
      padding: 1px 6px;
      border-radius: 99px;
      color: var(--muted);
    }

    .quadrant-cards {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .quadrant-empty {
      color: var(--muted);
      font-size: 11px;
      text-align: center;
      margin-top: 40px;
      font-style: italic;
    }

    .p-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      cursor: pointer;
      transition: all 0.3s;
      position: relative;
    }
    .p-card:hover {
      transform: translateY(-2px);
      background: rgba(255, 255, 255, 0.05);
      border-color: var(--accent);
      box-shadow: 0 4px 12px rgba(0, 240, 255, 0.12);
    }
    .p-card.selected-active {
      border-color: var(--accent);
      background: rgba(0, 240, 255, 0.03);
      box-shadow: 0 0 10px rgba(0, 240, 255, 0.15);
    }
    .p-card-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 4px;
      word-break: break-all;
    }
    .p-card-role {
      font-size: 10px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.03);
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-block;
      margin-bottom: 6px;
    }
    .p-card-progress {
      height: 4px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 99px;
      overflow: hidden;
    }
    .p-card-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--accent-purple));
    }

    /* 编辑抽屉 Drawer */
    .drawer {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: 380px;
      background: rgba(12, 15, 28, 0.94);
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(24px);
      box-shadow: -10px 0 40px rgba(0, 0, 0, 0.6);
      z-index: 1000;
      padding: 24px;
      transform: translateX(100%);
      transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
      gap: 16px;
      overflow-y: auto;
    }
    .drawer.open {
      transform: translateX(0);
    }
    .drawer-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
      margin-bottom: 4px;
    }
    .drawer-title {
      font-size: 16px;
      font-weight: 700;
      margin: 0;
    }
    .drawer-close {
      background: transparent;
      border: 0;
      color: var(--muted);
      cursor: pointer;
      font-size: 18px;
    }
    .drawer-close:hover { color: #fff; }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .form-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .form-select, .form-input, .form-textarea {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      color: #fff;
      padding: 8px 12px;
      font-size: 13px;
      font-family: var(--font);
      outline: none;
      transition: border-color 0.3s;
    }
    .form-select:focus, .form-input:focus, .form-textarea:focus {
      border-color: var(--accent);
    }
    .form-help {
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
    }
    .drawer-actions {
      display: grid;
      grid-template-columns: 1.8fr 1.2fr;
      gap: 10px;
      margin-top: 10px;
      border-top: 1px solid var(--border);
      padding-top: 18px;
    }
    .btn-save {
      background: linear-gradient(135deg, var(--accent), var(--accent-purple));
      color: #000;
      font-weight: 700;
      border: 0;
      border-radius: 6px;
      padding: 10px;
      cursor: pointer;
      font-family: var(--font);
      font-size: 13px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      box-shadow: 0 4px 14px rgba(0, 240, 255, 0.25);
    }
    .btn-save:hover { opacity: 0.9; }
    .btn-roadmap {
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 10px;
      border-radius: 6px;
      cursor: pointer;
      font-family: var(--font);
      font-size: 13px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.3s;
    }
    .btn-roadmap:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .project-detail-sec {
      background: rgba(255,255,255,0.01);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .project-detail-sec strong {
      color: var(--fg);
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .project-detail-sec ul {
      margin: 0; padding-left: 16px;
    }
    .project-detail-sec li {
      margin-bottom: 4px;
    }

    /* TAB 4: 能力复利 */
    .ability-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
    }
    .ability-card {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
    }
    .ability-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 10px;
    }
    .ability-name {
      font-weight: 700;
      font-size: 14px;
      margin: 0;
    }
    .ability-badge {
      font-size: 10px;
      font-weight: 700;
      background: rgba(0, 240, 255, 0.05);
      border: 1px solid rgba(0, 240, 255, 0.15);
      color: var(--accent);
      padding: 1px 6px;
      border-radius: 4px;
    }
    .ability-meta {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .ability-card-projects {
      border-top: 1px solid var(--border);
      padding-top: 10px;
      margin-top: 10px;
    }

    /* TAB 5: 场景建模 */
    .scenario-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }
    .scenario-card {
      background: var(--glass-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .scenario-badge {
      align-self: flex-start;
      width: 24px;
      height: 24px;
      background: rgba(0, 240, 255, 0.05);
      border: 1px solid rgba(0, 240, 255, 0.2);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
    }
    .scenario-title {
      font-size: 15px;
      font-weight: 700;
      margin: 0;
    }
    .scenario-card dl {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 12px;
    }
    .scenario-card dl div {
      border-top: 1px solid var(--border);
      padding-top: 8px;
      display: grid;
      grid-template-columns: 60px 1fr;
      gap: 8px;
    }
    .scenario-card dl div:first-of-type { border-top: 0; padding-top: 0; }
    .scenario-card dt { color: var(--muted); font-weight: 600; }
    .scenario-card dd { margin: 0; color: var(--fg); }
    .scenario-card p {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
      border-top: 1px solid var(--border);
      padding-top: 10px;
      line-height: 1.4;
    }
    .recommended-sec {
      background: rgba(0, 240, 255, 0.04);
      border: 1px solid rgba(0, 240, 255, 0.15);
      border-radius: 8px;
      padding: 14px 18px;
      color: #c5ffff;
      font-size: 13px;
      font-weight: 600;
      margin-top: 18px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /* 辅助说明 */
    .empty-state {
      color: var(--muted);
      font-size: 12px;
      text-align: center;
      padding: 40px 20px;
      font-style: italic;
    }

    @media (max-width: 900px) {
      .dashboard-top, .dashboard-grid, .pyramid-wrapper, .ability-grid, .scenario-grid {
        grid-template-columns: 1fr;
      }
      .quadrants-container {
        grid-template-columns: 1fr 1fr;
      }
    }
    @media (max-width: 600px) {
      .quadrants-container {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="neon-glow-container"></div>
  <main class="shell">
    <header>
      <div style="display: flex; align-items: center; gap: 16px;">
        <h1 class="brand-title"><img class="brand-wordmark" src="${wordmarkUri}" width="132" height="34" alt="SoloMap"></h1>
        <div style="width: 1px; height: 20px; background: var(--border);"></div>
        <div>
          <h2 style="margin: 0; font-size: 16px; font-weight: 800; background: linear-gradient(135deg, var(--accent), var(--accent-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: -0.5px; line-height: 1.2;">一人公司战略驾驶舱</h2>
          <div class="sub-heading">判断多个项目、能力、收入和市场信誉是否正在形成一套可复利系统。</div>
        </div>
      </div>
      <div class="header-actions">
        <button type="button" class="btn-header" id="btn-refresh"><span class="codicon codicon-refresh"></span>刷新</button>
      </div>
    </header>

    <!-- TAB 导航栏 -->
    <nav class="tabs-nav">
      <button class="tab-btn active" data-tab="dashboard"><span class="codicon codicon-dashboard"></span>战略驾驶舱</button>
      <button class="tab-btn" data-tab="pyramid"><span class="codicon codicon-type-hierarchy"></span>战略金字塔</button>
      <button class="tab-btn" data-tab="portfolio"><span class="codicon codicon-library"></span>项目组合</button>
      <button class="tab-btn" data-tab="abilities"><span class="codicon codicon-workspace-trusted"></span>能力复利</button>
      <button class="tab-btn" data-tab="scenarios"><span class="codicon codicon-git-compare"></span>场景建模</button>
    </nav>

    <!-- TAB 1: 战略驾驶舱 -->
    <section class="tab-content active" id="tab-dashboard">
      <div class="glass-card dashboard-top">
        <div class="cockpit-main">
          <div class="state-badge">当前战略状态：${strategyEscapeHtml(stageTitle)}</div>
          <h2 class="cockpit-title">${strategyEscapeHtml(mainJudgment)}</h2>
          <div class="cockpit-meta">置信度：${strategyEscapeHtml(snapshot.confidence === 'high' ? '高' : snapshot.confidence === 'medium' ? '中' : '低')} · 基于本地项目、路线图阶段和推进信号聚合</div>
        </div>
        <div class="cockpit-grid">
          <div class="cockpit-item">
            <span>战略动作</span>
            <strong>${strategyEscapeHtml(strategicAction)}</strong>
          </div>
          <div class="cockpit-item">
            <span>边界约束</span>
            <strong>${strategyEscapeHtml(constraint)}</strong>
          </div>
        </div>
      </div>

      <div class="dashboard-grid">
        <div class="glass-card">
          <div class="section-title"><span class="codicon codicon-broadcast"></span>结构信号</div>
          <div class="signals-list">
            ${structureSignals.map((signal) => `
              <div class="signal-item ${strategyEscapeHtml(signal.health)}">
                <strong>${strategyEscapeHtml(signal.title)}</strong>
                <span>${signal.health === 'strong' ? '健康' : signal.health === 'watch' ? '观察' : '风险'}</span>
                <p>${strategyEscapeHtml(signal.summary)}</p>
              </div>
            `).join('') || '<div class="empty-state">等待更多本地事实形成结构信号。</div>'}
          </div>
        </div>

        <div class="glass-card">
          <div class="section-title"><span class="codicon codicon-warning"></span>1-3 个月结构风险与机会</div>
          <div class="risks-list">
            ${riskSignals.map((signal) => `
              <div class="risk-alert ${strategyEscapeHtml(signal.severity)}">
                <span class="codicon codicon-warning"></span>
                <div>
                  <strong>${strategyEscapeHtml(signal.title)}</strong>
                  <p>${strategyEscapeHtml(signal.summary)}</p>
                </div>
              </div>
            `).join('')}
            ${opportunitySignals.map((signal) => `
              <div class="risk-alert healthy">
                <span class="codicon codicon-circle-large-filled"></span>
                <div>
                  <strong>${strategyEscapeHtml(signal.title)}</strong>
                  <p>${strategyEscapeHtml(signal.summary)}</p>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 2: 战略金字塔 -->
    <section class="tab-content" id="tab-pyramid">
      <div class="glass-card pyramid-wrapper">
        <!-- 左侧金字塔渲染 -->
        <div class="pyramid-visual">
          <div class="pyramid-layer" data-layer-key="freedom-brand" style="--width: 50%; --grad: linear-gradient(135deg, rgba(255, 214, 0, 0.28), rgba(255, 109, 0, 0.28)); --glow: rgba(255, 214, 0, 0.4); --color: #ffd600">
            ⭐ 自由与品牌 (1)
          </div>
          <div class="pyramid-layer" data-layer-key="revenue-system" style="--width: 62%; --grad: linear-gradient(135deg, rgba(0, 230, 118, 0.28), rgba(0, 176, 255, 0.28)); --glow: rgba(0, 230, 118, 0.4); --color: #00e676">
            可复利收入系统 (2)
          </div>
          <div class="pyramid-layer" data-layer-key="market-trust" style="--width: 74%; --grad: linear-gradient(135deg, rgba(124, 77, 255, 0.28), rgba(255, 23, 68, 0.28)); --glow: rgba(124, 77, 255, 0.4); --color: #7c4dff">
            市场覆盖与信誉 (3)
          </div>
          <div class="pyramid-layer" data-layer-key="ability-compounding" style="--width: 86%; --grad: linear-gradient(135deg, rgba(0, 229, 255, 0.28), rgba(124, 77, 255, 0.28)); --glow: rgba(0, 229, 255, 0.4); --color: #00f0ff">
            能力系统与产品交付 (4)
          </div>
          <div class="pyramid-layer" data-layer-key="reality-inventory" style="--width: 98%; --grad: linear-gradient(135deg, rgba(148, 163, 184, 0.2), rgba(71, 85, 105, 0.2)); --glow: rgba(148, 163, 184, 0.4); --color: #94a3b8">
            现实锚点与投资库存 (5)
          </div>
        </div>

        <!-- 右侧层级详细分析 -->
        <div class="layer-detail-card">
          <div class="layer-detail-header">
            <h3 class="layer-detail-title" id="l-title">金字塔层级</h3>
            <span class="layer-detail-health" id="l-health">未知</span>
          </div>
          <div class="layer-grid">
            <div class="layer-grid-item">
              <span>当前信号</span>
              <strong id="l-signal">-</strong>
            </div>
            <div class="layer-grid-item">
              <span>下一步行动建议</span>
              <strong id="l-action">-</strong>
            </div>
          </div>
          <div class="layer-evidence-box">
            <div class="layer-support-title">支持本层的活跃项目</div>
            <div class="layer-support-chips" id="l-projects">
              <span class="layer-chip">无</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 3: 项目组合 -->
    <section class="tab-content" id="tab-portfolio">
      <div class="glass-card">
        <div class="section-title"><span class="codicon codicon-combine"></span>Build / Sell / Learn / Improve 四象限项目分布</div>
        <div class="quadrants-container">
          <!-- Build -->
          <div class="quadrant build">
            <div class="quadrant-title-bar">
              <span class="quadrant-name">Build 产品与交付</span>
              <span class="quadrant-count" id="count-build">0</span>
            </div>
            <div class="quadrant-cards" id="quad-build"></div>
          </div>

          <!-- Sell -->
          <div class="quadrant sell">
            <div class="quadrant-title-bar">
              <span class="quadrant-name">Sell 收入与市场</span>
              <span class="quadrant-count" id="count-sell">0</span>
            </div>
            <div class="quadrant-cards" id="quad-sell"></div>
          </div>

          <!-- Learn -->
          <div class="quadrant learn">
            <div class="quadrant-title-bar">
              <span class="quadrant-name">Learn 学习与反馈</span>
              <span class="quadrant-count" id="count-learn">0</span>
            </div>
            <div class="quadrant-cards" id="quad-learn"></div>
          </div>

          <!-- Improve -->
          <div class="quadrant improve">
            <div class="quadrant-title-bar">
              <span class="quadrant-name">Improve 改进与复利</span>
              <span class="quadrant-count" id="count-improve">0</span>
            </div>
            <div class="quadrant-cards" id="quad-improve"></div>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 4: 能力复利 -->
    <section class="tab-content" id="tab-abilities">
      <div class="glass-card">
        <div class="section-title"><span class="codicon codicon-shield"></span>跨项目能力复利分析</div>
        <div class="ability-grid">
          ${abilities.map((ability) => `
            <div class="ability-card">
              <div class="ability-card-header">
                <h4 class="ability-name">${strategyEscapeHtml(ability.name)}</h4>
                <span class="ability-badge">${strategyEscapeHtml(ability.value)}价值</span>
              </div>
              <div class="ability-meta">
                项目复用数: <strong>${ability.projectCount}</strong> 个
                <br>
                战略判断: <strong>${strategyEscapeHtml(ability.judgment)}</strong>
              </div>
              <div class="ability-card-projects">
                <div class="layer-support-title">应用项目</div>
                <div class="layer-support-chips">
                  ${(ability.projectNames || []).map((name: string) => `<span class="layer-chip">${strategyEscapeHtml(name)}</span>`).join('')}
                </div>
              </div>
            </div>
          `).join('') || '<div class="empty-state">暂未识别跨项目复用能力。在项目上打上能力标签，开启复利统计。</div>'}
        </div>
      </div>
    </section>

    <!-- TAB 5: 场景建模 -->
    <section class="tab-content" id="tab-scenarios">
      <div class="glass-card">
        <div class="section-title"><span class="codicon codicon-symbol-parameter"></span>If-Then 决策模拟 (对比不同战略路线)</div>
        <div class="scenario-grid">
          ${scenarios.map((scenario) => `
            <div class="scenario-card">
              <span class="scenario-badge">${strategyEscapeHtml(scenario.key)}</span>
              <h4 class="scenario-title">${strategyEscapeHtml(scenario.title)}</h4>
              <dl>
                <div><dt>投入</dt><dd>${strategyEscapeHtml(scenario.investment)}</dd></div>
                <div><dt>回报假设</dt><dd>${strategyEscapeHtml(scenario.returnProfile)}</dd></div>
                <div><dt>成本</dt><dd>${strategyEscapeHtml(scenario.cost)}</dd></div>
                <div><dt>风险</dt><dd>${strategyEscapeHtml(scenario.risk)}</dd></div>
                <div><dt>时间轴</dt><dd>${strategyEscapeHtml(scenario.timeline)}</dd></div>
              </dl>
              <p>${strategyEscapeHtml(scenario.summary)}</p>
            </div>
          `).join('')}
        </div>
        ${recommendedScenarioPath ? `
          <div class="recommended-sec">
            <span class="codicon codicon-lightbulb"></span>
            <div>${strategyEscapeHtml(recommendedScenarioPath)}</div>
          </div>
        ` : ''}
      </div>
    </section>
    <div style="display:none;" aria-hidden="true" data-project-index="0">
      战略阶段自适应 收入结构 市场信誉 时间结构 未来 30 天战略动作 1-3 个月结构风险 项目组合结构 项目战略角色 能力积累 收入贡献 复用潜力 个人品牌价值
    </div>
  </main>

  <!-- 项目战略编辑 Drawer -->
  <aside class="drawer" id="project-drawer">
    <div class="drawer-header">
      <h3 class="drawer-title" id="drawer-p-name">项目战略控制台</h3>
      <button class="drawer-close" id="btn-close-drawer">&times;</button>
    </div>

    <!-- 编辑表单 -->
    <div class="form-group">
      <label class="form-label">战略角色</label>
      <select class="form-select" id="field-role">
        <option value="核心产品">核心产品 (core_product)</option>
        <option value="推进项目">推进项目 (incubation)</option>
        <option value="能力底座">能力底座 (infrastructure)</option>
        <option value="内容资产">内容资产 (content)</option>
        <option value="稳定维护">稳定维护 (maintenance)</option>
        <option value="机会验证">机会验证 (experiment)</option>
        <option value="冻结项目">冻结项目 (frozen)</option>
      </select>
      <div class="form-help">定义该项目在公司拼图中的位置。</div>
    </div>

    <div class="form-group">
      <label class="form-label">商业化阶段</label>
      <select class="form-select" id="field-stage">
        <option value="idea">起步想法 (idea)</option>
        <option value="build">建设中 (build)</option>
        <option value="validation">市场反馈验证 (validation)</option>
        <option value="commercial_validation">商业化付费验证 (commercial_validation)</option>
        <option value="stable">稳定运营 (stable)</option>
        <option value="sunset">收缩/夕阳 (sunset)</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">时间负载负担</label>
      <select class="form-select" id="field-time">
        <option value="low">低 (low)</option>
        <option value="medium">中 (medium)</option>
        <option value="high">高 (high)</option>
        <option value="unknown">未知 (unknown)</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">实际累计耗时</label>
      <div id="drawer-p-actual-time" style="font-size: 13px; color: var(--fg); padding: 8px 12px; background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 6px;">
        0 分钟 (暂无本地 Agent 运行记录)
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">收入贡献层级</label>
      <select class="form-select" id="field-revenue">
        <option value="none">无收入 (none)</option>
        <option value="small">微量收入 (small)</option>
        <option value="stable">稳定收入 (stable)</option>
        <option value="main">主力收入 (main)</option>
        <option value="unknown">未知 (unknown)</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">战略行动建议</label>
      <select class="form-select" id="field-action">
        <option value="加码商业化验证与渠道建设">加码商业化 (double_down)</option>
        <option value="收缩重复支持和低复利维护">收缩投入 (reduce)</option>
        <option value="观察反馈是否能转成定价或明确取舍">保持观察 (maintain)</option>
        <option value="冻结项目，减少维护">冻结项目 (freeze)</option>
        <option value="推进下一个可验证切片">探索机会 (explore)</option>
        <option value="收缩或降级">夕阳下线 (sunset)</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">能力标签 (分号隔开)</label>
      <input type="text" class="form-input" id="field-abilities" placeholder="例如: cli-tools; agent-orchestration">
      <div class="form-help">将可复用技术或运营能力标记到此项目，可用于跨项目复利聚合。</div>
    </div>

    <!-- 动态评估指标 -->
    <div class="project-detail-sec">
      <strong>项目推进情况与诊断</strong>
      <div id="drawer-p-metrics">-</div>
    </div>

    <div class="drawer-actions">
      <button type="button" class="btn-save" id="btn-save-strategy">
        <span class="codicon codicon-save"></span>保存战略标记
      </button>
      <button type="button" class="btn-roadmap" id="btn-open-roadmap">
        <span class="codicon codicon-go-to-file"></span>项目大图
      </button>
    </div>
  </aside>

  <script>
    const vscode = acquireVsCodeApi();
    const projectRoles = ${projectRoleJson};
    const layers = ${layersJson};

    // Tab 切换逻辑
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        btn.classList.add('active');
        const target = btn.getAttribute('data-tab');
        const content = document.getElementById('tab-' + target);
        if (content) {
          content.classList.add('active');
        }
      });
    });

    // 刷新按钮
    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshStrategyPyramid' });
    });

    // ==========================================
    // 战略金字塔 (TAB 2) 点击与渲染
    // ==========================================
    const priorityLayerTitle = "${strategyEscapeHtml(stageProfile.priorityLayer)}";
    const pyramidLayers = document.querySelectorAll('.pyramid-layer');

    function selectLayer(key) {
      pyramidLayers.forEach(l => l.classList.remove('selected'));
      const activeEl = document.querySelector('[data-layer-key="' + key + '"]');
      if (activeEl) activeEl.classList.add('selected');

      const layerData = layers.find(l => l.key === key);
      if (layerData) {
        document.getElementById('l-title').textContent = layerData.title;
        const healthEl = document.getElementById('l-health');
        healthEl.textContent = layerData.health === 'strong' ? '健康' : layerData.health === 'watch' ? '观察' : '风险';
        healthEl.className = 'layer-detail-health ' + layerData.health;

        document.getElementById('l-signal').textContent = layerData.signal;
        document.getElementById('l-action').textContent = layerData.action || '继续维持战略关注';

        // 渲染支撑项目
        const supportBox = document.getElementById('l-projects');
        supportBox.innerHTML = '';
        if (layerData.evidence && layerData.evidence.length) {
          layerData.evidence.forEach(item => {
            const span = document.createElement('span');
            span.className = 'layer-chip';
            span.textContent = item;
            supportBox.appendChild(span);
          });
        } else {
          supportBox.innerHTML = '<span class="layer-chip">暂无支撑项目</span>';
        }
      }
    }

    pyramidLayers.forEach(layer => {
      layer.addEventListener('click', () => {
        selectLayer(layer.getAttribute('data-layer-key'));
      });
      // 如果这一层是优先聚焦的层，就打上“当前聚焦”标记
      const titleText = layer.textContent.trim();
      if (priorityLayerTitle.includes(titleText.substring(2, 6)) || priorityLayerTitle.includes(titleText.split(' ')[0])) {
        const badge = document.createElement('span');
        badge.className = 'focus-badge';
        badge.innerHTML = '<span class="codicon codicon-star-full"></span> 优先聚焦';
        layer.appendChild(badge);
        // 默认选中该优先聚焦层
        setTimeout(() => selectLayer(layer.getAttribute('data-layer-key')), 100);
      }
    });

    // 兜底选中第一层
    if (!document.querySelector('.pyramid-layer.selected') && pyramidLayers.length) {
      selectLayer(pyramidLayers[0].getAttribute('data-layer-key'));
    }

    // ==========================================
    // 四象限项目看板 (TAB 3)
    // ==========================================
    const quadBuild = document.getElementById('quad-build');
    const quadSell = document.getElementById('quad-sell');
    const quadLearn = document.getElementById('quad-learn');
    const quadImprove = document.getElementById('quad-improve');

    let buildCount = 0;
    let sellCount = 0;
    let learnCount = 0;
    let improveCount = 0;

    // 清空现有卡片
    quadBuild.innerHTML = '';
    quadSell.innerHTML = '';
    quadLearn.innerHTML = '';
    quadImprove.innerHTML = '';

    projectRoles.forEach((project, idx) => {
      const card = document.createElement('div');
      card.className = 'p-card';
      card.setAttribute('data-p-index', idx);
      card.innerHTML = \`
        <div class="p-card-title">\${html(project.name)}</div>
        <div class="p-card-role">\${html(project.role)}</div>
        <div class="p-card-progress" title="进度: \${project.progressPercent}%">
          <div class="p-card-progress-bar" style="width: \${project.progressPercent}%"></div>
        </div>
      \`;

      card.addEventListener('click', () => {
        document.querySelectorAll('.p-card').forEach(c => c.classList.remove('selected-active'));
        card.classList.add('selected-active');
        openProjectDrawer(idx);
      });

      // 决定放入哪个象限。我们看 project.loop
      if (project.businessStage === 'sunset' || project.role === '冻结项目') {
        // 冻结归入 Learn 或 Improve，或由 loop 决定。这里尊重它的 loop
      }

      if (project.loop === 'sell') {
        quadSell.appendChild(card);
        sellCount++;
      } else if (project.loop === 'learn') {
        quadLearn.appendChild(card);
        learnCount++;
      } else if (project.loop === 'improve') {
        quadImprove.appendChild(card);
        improveCount++;
      } else {
        quadBuild.appendChild(card);
        buildCount++;
      }
    });

    document.getElementById('count-build').textContent = buildCount;
    document.getElementById('count-sell').textContent = sellCount;
    document.getElementById('count-learn').textContent = learnCount;
    document.getElementById('count-improve').textContent = improveCount;

    if (buildCount === 0) quadBuild.innerHTML = '<div class="quadrant-empty">暂无项目</div>';
    if (sellCount === 0) quadSell.innerHTML = '<div class="quadrant-empty">暂无项目</div>';
    if (learnCount === 0) quadLearn.innerHTML = '<div class="quadrant-empty">暂无项目</div>';
    if (improveCount === 0) quadImprove.innerHTML = '<div class="quadrant-empty">暂无项目</div>';

    // ==========================================
    // 编辑抽屉 Drawer 交互
    // ==========================================
    const drawer = document.getElementById('project-drawer');
    let currentEditingIndex = -1;

    function openProjectDrawer(index) {
      const project = projectRoles[index];
      if (!project) return;
      currentEditingIndex = index;

      document.getElementById('drawer-p-name').textContent = project.name;
      document.getElementById('field-role').value = project.role;
      document.getElementById('field-stage').value = project.businessStage;
      document.getElementById('field-time').value = project.timeLoad;
      document.getElementById('field-revenue').value = project.revenueTier;
      document.getElementById('field-action').value = project.action;
      document.getElementById('field-abilities').value = project.abilities.join('; ');

      const actualTimeVal = project.actualMinutes || 0;
      document.getElementById('drawer-p-actual-time').textContent = actualTimeVal > 0 
        ? actualTimeVal + ' 分钟' 
        : '0 分钟 (暂无本地 Agent 运行记录)';

      // 支撑证据渲染
      const metricsContainer = document.getElementById('drawer-p-metrics');
      metricsContainer.innerHTML = '';
      const ul = document.createElement('ul');
      project.evidence.forEach(ev => {
        const li = document.createElement('li');
        li.textContent = ev;
        ul.appendChild(li);
      });
      metricsContainer.appendChild(ul);

      drawer.classList.add('open');
    }

    document.getElementById('btn-close-drawer').addEventListener('click', () => {
      drawer.classList.remove('open');
      document.querySelectorAll('.p-card').forEach(c => c.classList.remove('selected-active'));
    });

    // 保存属性
    document.getElementById('btn-save-strategy').addEventListener('click', () => {
      if (currentEditingIndex === -1) return;
      const project = projectRoles[currentEditingIndex];
      const abilitiesInput = document.getElementById('field-abilities').value;
      const parsedAbilities = abilitiesInput.split(';')
        .map(a => a.trim())
        .filter(Boolean);

      vscode.postMessage({
        command: 'saveProjectStrategy',
        projectPath: project.path,
        role: document.getElementById('field-role').value,
        businessStage: document.getElementById('field-stage').value,
        revenueTier: document.getElementById('field-revenue').value,
        timeLoad: document.getElementById('field-time').value,
        strategicAction: document.getElementById('field-action').value,
        abilities: parsedAbilities
      });

      drawer.classList.remove('open');
    });

    // 打开路线图
    document.getElementById('btn-open-roadmap').addEventListener('click', () => {
      if (currentEditingIndex === -1) return;
      const project = projectRoles[currentEditingIndex];
      vscode.postMessage({
        command: 'openProjectRoadmap',
        projectPath: project.path
      });
    });

    function html(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  </script>
</body>
</html>`;
}
