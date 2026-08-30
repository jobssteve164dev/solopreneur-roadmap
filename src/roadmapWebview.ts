import * as path from 'path';
import type * as vscode from 'vscode';
import { getSharedWebviewRuntimeScript } from './webviewSharedRuntime';

const roadmapHtmlCache = new Map<string, string>();

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

/**
 * Formulates the premium glassmorphic Webview page bundle.
 */
export function getWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  // In MVP, we embed a fully functional React + CSS app direct inside the iframe
  // which uses modern styling guidelines (glassmorphism, glowing connections, inter font).
  const codiconsUri = webview.asWebviewUri(joinExtensionUri(context, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
  const wordmarkUri = webview.asWebviewUri(joinExtensionUri(context, 'resources', 'logo_with_text.svg'));
  const cacheKey = `${String(codiconsUri)}|${String(wordmarkUri)}`;
  const cachedHtml = roadmapHtmlCache.get(cacheKey);
  if (cachedHtml) {
    return cachedHtml;
  }
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SoloMap</title>
  <!-- Load Inter & Outfit Fonts Asynchronously (Prevent network blocks on slow connections) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&display=swap" media="print" onload="this.media='all'">
  <link rel="stylesheet" href="${codiconsUri}">
  <noscript>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
  </noscript>

  <style>
    :root {
      --bg-dark: #0f111a;
      --bg-glass: rgba(22, 28, 45, 0.6);
      --border-glass: rgba(255, 255, 255, 0.08);
      --glow-blue: rgba(0, 229, 255, 0.8);
      --glow-green: rgba(0, 230, 118, 0.8);
      --glow-red: rgba(255, 23, 68, 0.8);
      --text-main: #e2e8f0;
      --text-muted: #94a3b8;
    }

    * {
      box-sizing: border-box;
    }

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
      padding: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--vscode-editor-background, var(--bg-dark));
      color: var(--text-main);
      overflow-x: hidden;
    }

    .app-container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
    }

    /* Premium Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 16px 24px;
      background: rgba(15, 17, 26, 0.7);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-glass);
      z-index: 10;
    }

    h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 20px;
      margin: 0;
      font-weight: 800;
      background: linear-gradient(135deg, #00e5ff 0%, #7c4dff 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .project-select {
      width: clamp(150px, 18vw, 240px);
      min-width: 0;
    }

    .project-property-select {
      width: clamp(96px, 10vw, 150px);
      min-width: 0;
    }

    .solo-select {
      position: relative;
      min-width: 0;
      font-size: 12px;
    }

    .solo-select-trigger {
      width: 100%;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 10px;
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 7px;
      font: inherit;
      font-weight: 400;
      cursor: pointer;
      text-align: left;
    }

    .solo-select-trigger:hover {
      transform: none;
      box-shadow: none;
      border-color: rgba(0, 229, 255, 0.38);
    }

    .solo-select-trigger-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .solo-select-caret {
      flex-shrink: 0;
      font-size: 13px;
      color: var(--text-muted);
      transition: transform 0.18s ease;
    }

    .solo-select.open .solo-select-caret {
      transform: rotate(180deg);
    }

    .solo-select.open .solo-select-trigger,
    .solo-select-trigger:focus {
      outline: none;
      border-color: rgba(0, 229, 255, 0.7);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.18);
    }

    .solo-select-menu {
      display: none;
      position: absolute;
      top: calc(100% + 5px);
      left: 0;
      right: 0;
      z-index: 120;
      padding: 5px;
      max-height: 224px;
      overflow-y: auto;
      border: 1px solid rgba(0, 229, 255, 0.2);
      border-radius: 9px;
      background: #141a29;
      box-shadow: 0 14px 32px rgba(0, 0, 0, 0.48);
    }

    .solo-select.open .solo-select-menu {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .solo-select-group-header {
      padding: 8px 9px;
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid var(--border-glass);
      margin: 4px 0 2px;
      pointer-events: none;
    }

    .solo-select-option {
      padding: 8px 9px;
      background: transparent;
      border-radius: 6px;
      color: var(--text-main);
      font: inherit;
      font-weight: 400;
      text-align: left;
      cursor: pointer;
    }

    .solo-select-option:hover,
    .solo-select-option[aria-selected="true"] {
      transform: none;
      box-shadow: none;
      color: #d8fbff;
      background: rgba(0, 229, 255, 0.12);
    }

    .solo-select.is-disabled {
      opacity: 0.55;
    }

    .solo-select.is-disabled .solo-select-trigger {
      cursor: not-allowed;
    }

    .btn-project-add {
      padding: 8px 10px;
      min-width: 34px;
    }

    .btn-project-remove {
      background: rgba(255, 23, 68, 0.10);
      color: #ffe1e8;
      border: 1px solid rgba(255, 23, 68, 0.22);
      padding: 8px 10px;
      min-width: 34px;
    }

    .btn-project-remove:hover {
      box-shadow: 0 4px 15px rgba(255, 23, 68, 0.28);
      background: rgba(255, 23, 68, 0.18);
    }

    .btn-roadmap-revision {
      width: 34px;
      height: 34px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      border: 1px solid rgba(56, 189, 248, 0.28);
      border-radius: 8px;
      flex-shrink: 0;
    }

    .btn-roadmap-revision:hover,
    .btn-roadmap-revision.active {
      background: #00e5ff;
      border-color: #00e5ff;
      color: #000;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.25);
    }

    .view-tabs {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 24px;
      background: rgba(15, 17, 26, 0.7);
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      z-index: 8;
    }

    .view-tab {
      height: 34px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      flex-shrink: 0;
    }

    .view-tab:hover,
    .view-tab.active {
      color: #d8fbff;
      background: rgba(0, 229, 255, 0.12);
      border-color: rgba(0, 229, 255, 0.32);
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.18);
    }

    .view-tab.solo-tab.active {
      color: #fff;
      background: rgba(124, 77, 255, 0.36);
      border-color: rgba(167, 139, 250, 0.68);
      box-shadow: 0 0 12px rgba(124, 77, 255, 0.28);
    }

    .view-tab.flow-tab.active {
      color: #fff7d6;
      background: rgba(245, 158, 11, 0.24);
      border-color: rgba(245, 158, 11, 0.58);
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.24);
    }

    .view-panel {
      display: none;
    }

    .view-panel.active {
      display: flex;
    }

    .roadmap-canvas.view-panel:not(.active),
    .solo-view.view-panel:not(.active) {
      display: none;
    }

    input[type="text"] {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 8px 12px;
      color: var(--text-main);
      font-family: inherit;
      width: 250px;
      outline: none;
      transition: all 0.3s ease;
    }

    input[type="text"]:focus {
      border-color: #00e5ff;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.25);
    }

    input[type="range"] {
      width: 100%;
      height: 18px;
      margin: 0;
      appearance: none;
      -webkit-appearance: none;
      background: transparent;
      accent-color: #38bdf8;
    }

    input[type="range"]::-webkit-slider-runnable-track {
      height: 4px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.22);
    }

    input[type="range"]::-webkit-slider-thumb {
      width: 14px;
      height: 14px;
      margin-top: -5px;
      border: 2px solid var(--vscode-editor-background, #0f111a);
      border-radius: 999px;
      background: #cbd5e1;
      -webkit-appearance: none;
    }

    input[type="range"]::-moz-range-track {
      height: 4px;
      border: 0;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.22);
    }

    input[type="range"]::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-editor-background, #0f111a);
      border-radius: 999px;
      background: #cbd5e1;
    }

    button {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .codicon {
      font-size: 16px;
      line-height: 1;
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

    .page-heading {
      color: var(--text-main);
      font-size: 16px;
      font-weight: 800;
      line-height: 1.2;
      white-space: nowrap;
    }

    .header-divider { width: 1px; height: 20px; background: var(--border-glass); }

    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 15px rgba(0, 229, 255, 0.4);
    }

    /* Roadmap Canvas */
    .roadmap-canvas {
      flex: 1;
      position: relative;
      background: radial-gradient(circle at 50% 50%, rgba(20, 25, 45, 0.6) 0%, rgba(10, 12, 22, 0.95) 100%);
      overflow: auto;
      padding: clamp(18px, 4vw, 40px);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 30px;
    }

    .solo-view {
      flex: 1;
      overflow: auto;
      padding: clamp(18px, 4vw, 40px);
      background: radial-gradient(circle at 50% 50%, rgba(35, 24, 66, 0.45) 0%, rgba(10, 12, 22, 0.95) 100%);
      flex-direction: column;
      align-items: center;
    }

    .solo-view-inner {
      width: min(1280px, 100%);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .roadmap-revision-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .roadmap-revision-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .roadmap-revision-body .conversation-composer {
      margin-top: 0;
    }

    .solo-conversation-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .solo-conversation-body .conversation-composer {
      margin-top: 0;
    }

    .solo-closure {
      border-top: 1px solid var(--border-glass);
      margin-top: 10px;
      padding-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .solo-closure-title {
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
    }

    .solo-closure-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .solo-link-select {
      flex: 1 1 180px;
      min-width: 150px;
    }

    .solo-action-btn {
      font-size: 11px;
      padding: 8px 10px;
      white-space: nowrap;
    }

    .solo-action-btn.secondary {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
    }

    /* Node Stack (Unified Roadmap Flow layout) */
    .flow-line {
      position: absolute;
      width: 4px;
      background: linear-gradient(to bottom, #00e5ff, #7c4dff);
      top: 60px;
      bottom: 60px;
      z-index: 1;
    }

    .methodology-shell {
      width: 100%;
      max-width: min(1280px, 100%);
      position: relative;
      z-index: 3;
    }

    .methodology-overview {
      width: 100%;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }

    .methodology-stage-card {
      width: 100%;
      min-width: 0;
      min-height: 78px;
      padding: 12px;
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--text-main);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 8px;
      text-align: left;
      cursor: pointer;
    }

    .methodology-stage-card:hover,
    .methodology-stage-card.active {
      border-color: rgba(0, 229, 255, 0.52);
      background: rgba(0, 229, 255, 0.10);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.10), 0 12px 30px rgba(0, 0, 0, 0.22);
      transform: none;
    }

    .methodology-stage-card.missing {
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.42);
      box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.12);
    }

    .methodology-stage-card.missing.active {
      background: rgba(245, 158, 11, 0.18);
      border-color: rgba(245, 158, 11, 0.62);
    }

    .methodology-stage-name {
      font-size: 12px;
      font-weight: 800;
      line-height: 1.1;
    }

    .methodology-stage-meta {
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.35;
    }

    .methodology-adjust-btn {
      align-self: flex-start;
      border: 1px solid rgba(245, 158, 11, 0.45);
      background: rgba(245, 158, 11, 0.14);
      color: #fde68a;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }

    .node-row {
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      max-width: min(1280px, 100%);
      min-width: 0;
      z-index: 2;
    }

    .node-row.stage-highlight .node-card {
      border-color: rgba(0, 229, 255, 0.65);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.16), 0 0 32px rgba(0, 229, 255, 0.14);
    }

    .node-card {
      width: 100%;
      min-width: 0;
      background: var(--bg-glass);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      gap: 16px;
      flex-direction: column;
      transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      cursor: pointer;
    }

    .node-card:hover {
      transform: scale(1.01) translateY(-2px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      border-color: rgba(255,255,255,0.15);
    }

    /* Status indicators */
    .node-card.status-Pending {
      border-left: 5px solid #64748b;
    }
    .node-card.status-Running {
      border-left: 5px solid #00e5ff;
      animation: pulse-border 2s infinite;
    }
    .node-card.status-In-Progress {
      border-left: 5px solid #facc15;
      box-shadow: 0 0 15px rgba(250, 204, 21, 0.08);
    }
    .node-card.status-Completed {
      border-left: 5px solid #00e676;
      box-shadow: 0 0 15px rgba(0, 230, 118, 0.1);
    }
    .node-card.status-Failed {
      border-left: 5px solid #ff1744;
      box-shadow: 0 0 15px rgba(255, 23, 68, 0.1);
    }

    @keyframes pulse-border {
      0% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0.4); }
      70% { box-shadow: 0 0 0 10px rgba(0, 229, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0); }
    }

    .node-badge {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 4px 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-muted);
      align-self: flex-start;
    }

    .stage-Business-Planning { color: #818cf8; }
    .stage-Brand---Setup { color: #f472b6; }
    .stage-Product---MVP { color: #38bdf8; }
    .stage-Marketing---Growth { color: #34d399; }

    .node-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }

    .node-summary {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      justify-content: space-between;
      min-width: 0;
    }

    .node-headline {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .node-expand-icon {
      color: var(--text-muted);
      font-size: 12px;
      margin-right: 2px;
    }

    .node-expanded-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 10px;
      padding-top: 12px;
      border-top: 1px solid var(--border-glass);
      min-width: 0;
      max-width: 100%;
    }

    .node-title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.2px;
    }

    .node-desc {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .node-agent-prompt {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 6px;
      padding: 8px 12px;
      font-family: monospace;
      font-size: 11px;
      color: #38bdf8;
      border-left: 2px solid #38bdf8;
      margin-top: 6px;
    }

    .completion-criteria {
      margin-top: 8px;
      background: rgba(0, 229, 255, 0.06);
      border: 1px solid rgba(0, 229, 255, 0.16);
      border-radius: 8px;
      padding: 9px 10px;
    }

    .completion-criteria-title {
      font-size: 11px;
      font-weight: 800;
      color: #67e8f9;
      margin-bottom: 6px;
    }

    .completion-criteria-list {
      margin: 0;
      padding-left: 18px;
      color: #cbd5e1;
      font-size: 12px;
      line-height: 1.45;
    }

    .completion-criteria-list li + li {
      margin-top: 4px;
    }

    .node-actions {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: flex-end;
      gap: 10px;
      flex-shrink: 0;
    }

    .status-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 12px;
    }

    .status-badge.Pending { background: rgba(100, 116, 139, 0.15); color: #94a3b8; }
    .status-badge.Running { background: rgba(0, 229, 255, 0.15); color: #00e5ff; }
    .status-badge.In-Progress { background: rgba(250, 204, 21, 0.15); color: #facc15; }
    .status-badge.Completed { background: rgba(0, 230, 118, 0.15); color: #00e676; }
    .status-badge.Failed { background: rgba(255, 23, 68, 0.15); color: #ff1744; }

    .btn-run {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
      padding: 6px 12px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-run:hover {
      background: #00e5ff;
      color: #000;
      border-color: #00e5ff;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.3);
    }

    .conversation-panel {
      background: rgba(0, 0, 0, 0.16);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }

    .conversation-pagination {
      display: flex;
      justify-content: center;
      padding-top: 10px;
    }

    .conversation-load-more {
      border: 1px solid var(--border-glass);
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-main);
      padding: 6px 14px;
      cursor: pointer;
    }

    .conversation-load-more:disabled {
      opacity: 0.55;
      cursor: default;
    }

    .conversation-composer {
      background: rgba(0, 0, 0, 0.20);
      border: 1px solid var(--border-glass);
      border-radius: 10px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .conversation-compose {
      display: flex;
      gap: 8px;
      align-items: stretch;
      min-width: 0;
    }

    .conversation-compose-main {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr) auto;
      align-items: center;
    }

    .conversation-compose-meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .conversation-compose input {
      flex: 1;
      width: auto;
      min-width: 0;
      min-height: 34px;
    }

    .conversation-tool-btn {
      width: 34px;
      min-height: 34px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-main);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      flex-shrink: 0;
    }

    .conversation-tool-btn:hover {
      color: #000;
      background: #00e5ff;
      border-color: #00e5ff;
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.25);
    }

    .conversation-agent-select {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      font-size: 12px;
      flex-shrink: 0;
    }

    .conversation-model-select {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      font-size: 12px;
      flex-shrink: 0;
    }

    .btn-send-conversation {
      min-width: 42px;
      min-height: 34px;
      padding: 0 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
    }

    .conversation-compose input:disabled,
    .btn-send-conversation:disabled,
    .conversation-tool-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .conversation-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .conversation-attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 4px 7px;
      border-radius: 999px;
      border: 1px solid var(--border-glass);
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      font-size: 11px;
    }

    .conversation-attachment-chip span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: min(360px, 48vw);
    }

    .conversation-attachment-remove {
      width: 16px;
      height: 16px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.10);
      color: var(--text-main);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .conversation-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 8px;
    }

    .conversation-empty {
      color: var(--text-muted);
      font-size: 12px;
      padding: 8px 0;
    }

    .conversation-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .onboarding-panel {
      width: min(560px, calc(100vw - 48px));
      margin: 48px auto 0;
      border: 1px solid rgba(0, 229, 255, 0.18);
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(0, 229, 255, 0.08), rgba(124, 77, 255, 0.08));
      padding: 18px;
      box-sizing: border-box;
    }

    .onboarding-kicker {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #7dd3fc;
      font-size: 11px;
      font-weight: 800;
      margin-bottom: 9px;
    }

    .onboarding-title {
      color: var(--text-main);
      font-size: 20px;
      font-weight: 800;
      line-height: 1.22;
      margin-bottom: 8px;
    }

    .onboarding-copy {
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 14px;
    }

    .onboarding-steps {
      display: grid;
      gap: 9px;
      margin-bottom: 16px;
    }

    .onboarding-step {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      gap: 9px;
      align-items: start;
      color: var(--text-main);
      font-size: 12px;
      line-height: 1.45;
    }

    .onboarding-step-index {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: rgba(0, 229, 255, 0.12);
      border: 1px solid rgba(0, 229, 255, 0.24);
      color: #a5f3fc;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 800;
    }

    .onboarding-action {
      border: none;
      border-radius: 6px;
      padding: 9px 13px;
      background: linear-gradient(135deg, #7c4dff 0%, #00b0ff 100%);
      color: #fff;
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
    }

    .conversation-item {
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      overflow: hidden;
      min-width: 0;
      max-width: 100%;
      position: relative;
    }

    .conversation-item-child {
      margin-left: 14px;
      border-color: rgba(124, 77, 255, 0.24);
      background: rgba(124, 77, 255, 0.05);
    }

    .conversation-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 10px;
      cursor: pointer;
      font-size: 12px;
    }

    .conversation-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1 1 auto;
    }

    .conversation-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
      flex-shrink: 0;
    }

    .conversation-retry-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }

    .conversation-retry-btn:hover {
      background: rgba(255, 23, 68, 0.16);
      border-color: rgba(255, 23, 68, 0.4);
      color: #ffd7df;
      box-shadow: none;
      transform: none;
    }

    .conversation-control-btn {
      background: rgba(56, 189, 248, 0.10);
      border: 1px solid rgba(56, 189, 248, 0.28);
      color: #d7f3ff;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }

    .conversation-control-btn.stop {
      background: rgba(255, 23, 68, 0.10);
      border-color: rgba(255, 23, 68, 0.32);
      color: #ffd7df;
    }

    .conversation-control-btn:hover {
      background: rgba(56, 189, 248, 0.20);
    }

    .conversation-control-btn.stop:hover {
      background: rgba(255, 23, 68, 0.20);
    }

    .conversation-control-btn.rollback-btn {
      background: rgba(244, 67, 54, 0.10);
      border-color: rgba(244, 67, 54, 0.32);
      color: #ffb4ab;
    }

    .conversation-control-btn.rollback-btn:hover {
      background: rgba(244, 67, 54, 0.20);
      border-color: rgba(244, 67, 54, 0.48);
    }

    .conversation-cli {
      color: #38bdf8;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .conversation-time {
      color: var(--text-muted);
      font-size: 11px;
    }

    .conversation-runtime {
      color: #38bdf8;
      font-size: 11px;
    }

    .conversation-summary {
      color: var(--text-main);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }

    .conversation-detail {
      border-top: 1px solid var(--border-glass);
      padding: 10px;
      color: var(--text-muted);
      font-size: 12px;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }

    .conversation-detail-wrap {
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .conversation-detail-continue {
      background: rgba(0, 176, 255, 0.06);
    }

    .conversation-compose-inline {
      margin-top: 8px;
    }

    .conversation-children {
      border-top: 1px solid var(--border-glass);
      padding: 12px 10px 10px 18px;
      background:
        linear-gradient(90deg, rgba(56, 189, 248, 0.14), transparent 42px),
        rgba(7, 12, 20, 0.32);
      position: relative;
    }

    .conversation-children::before {
      content: '';
      position: absolute;
      top: 36px;
      bottom: 12px;
      left: 18px;
      width: 1px;
      background: linear-gradient(to bottom, rgba(56, 189, 248, 0.5), rgba(56, 189, 248, 0.04));
    }

    .conversation-children-title {
      color: #93c5fd;
      font-size: 11px;
      font-weight: 700;
      margin: 0 0 10px 14px;
      letter-spacing: 0.04em;
    }

    .conversation-list-children {
      display: flex;
      flex-direction: column;
      gap: 8px;
      position: relative;
    }

    .conversation-item-child {
      margin-left: 14px;
      border: 1px solid rgba(56, 189, 248, 0.18);
      background: rgba(15, 23, 42, 0.46);
      border-radius: 10px;
    }

    .conversation-item-child::before {
      content: '';
      position: absolute;
      top: 20px;
      left: -14px;
      width: 14px;
      height: 1px;
      background: rgba(56, 189, 248, 0.42);
    }

    .conversation-outcome {
      margin: 0 0 10px;
      padding: 8px 9px;
      border-radius: 6px;
      background: rgba(56, 189, 248, 0.08);
      color: var(--text-main);
      line-height: 1.45;
    }

    .conversation-outcome.failed {
      background: rgba(255, 23, 68, 0.10);
      color: #ffd7df;
    }

    .rollback-btn {
      border: 1px solid rgba(244, 67, 54, 0.4);
      border-radius: 4px;
      background: rgba(244, 67, 54, 0.08);
      color: #ff8a80;
      padding: 3px 6px;
      font-size: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      line-height: 1;
      transition: background 0.2s, border-color 0.2s;
    }
    .rollback-btn:hover {
      background: rgba(244, 67, 54, 0.18);
      border-color: rgba(244, 67, 54, 0.6);
    }
    .rollback-btn .codicon {
      font-size: 11px;
    }

    .conversation-log-pre {
      white-space: pre;
      word-break: normal;
      overflow-wrap: normal;
      max-height: 320px;
      overflow: auto !important;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      touch-action: pan-x pan-y;
      margin: 6px 0 0;
      font-size: 11px;
      color: #cbd5e1;
      max-width: 100%;
      display: block;
      cursor: text;
    }

    .conversation-files {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 8px 0 12px;
    }

    .conversation-file-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid var(--border-glass);
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      text-decoration: none;
      font-size: 11px;
      cursor: pointer;
    }

    .conversation-file-link:hover {
      background: rgba(56, 189, 248, 0.16);
    }

    /* Settings Overlay Styles */
    .settings-overlay,
    .feedback-overlay {
      position: absolute;
      top: 75px;
      right: 24px;
      width: 320px;
      background: rgba(15, 17, 26, 0.95);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 16px;
      z-index: 100;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      display: none;
      flex-direction: column;
      gap: 12px;
      max-height: calc(100vh - 110px);
      overflow-y: auto;
      animation: slide-down 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .feedback-type-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }

    .feedback-type-btn {
      border: 1px solid var(--border-glass);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-muted);
      border-radius: 6px;
      padding: 8px 6px;
      font-size: 11px;
      cursor: pointer;
    }

    .feedback-type-btn.active {
      color: #00e5ff;
      border-color: rgba(0, 229, 255, 0.55);
      background: rgba(0, 229, 255, 0.08);
    }

    .roadmap-revision-popover {
      position: absolute;
      top: 75px;
      bottom: 24px;
      right: 24px;
      width: clamp(340px, 42vw, 560px);
      max-width: calc(100vw - 32px);
      box-sizing: border-box;
      background: rgba(15, 17, 26, 0.96);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 14px;
      z-index: 100;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.52);
      display: none;
      flex-direction: column;
      gap: 12px;
      max-height: none;
      overflow-y: hidden;
      overflow-x: hidden;
      animation: slide-down 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .roadmap-revision-body {
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      overflow-y: auto;
      max-width: 100%;
      overflow-x: hidden;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }

    .roadmap-revision-body > * {
      flex: 0 0 auto;
    }

    .roadmap-revision-body .conversation-compose {
      min-width: 0;
      max-width: 100%;
      flex-wrap: wrap;
    }

    .roadmap-revision-body .conversation-input {
      min-width: 0;
    }

    .roadmap-revision-popover.open {
      display: flex;
    }

    .roadmap-revision-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--border-glass);
      padding-bottom: 8px;
    }

    .roadmap-revision-header h3 {
      margin: 0;
      font-size: 14px;
      color: #00e5ff;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .btn-close-revision {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .btn-close-revision:hover {
      color: #ff1744;
      box-shadow: none;
      transform: none;
    }

    @keyframes slide-down {
      from { transform: translateY(-10px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .settings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-glass);
      padding-bottom: 8px;
    }

    .settings-header h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 14px;
      margin: 0;
      font-weight: 800;
      color: #00e5ff;
    }

    .btn-close-settings {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 20px;
      font-weight: bold;
      padding: 0 4px;
    }

    .btn-close-settings:hover {
      color: #ff1744;
    }

    .settings-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .settings-card {
      border: 1px solid rgba(255, 255, 255, 0.10);
      background: rgba(255, 255, 255, 0.035);
      border-radius: 8px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 9px;
    }

    .settings-card-title {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      font-weight: 800;
      color: var(--text-main);
    }

    .enhancement-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }

    .enhancement-card {
      border: 1px solid var(--border-glass);
      background: rgba(255, 255, 255, 0.04);
      border-radius: 7px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .enhancement-card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .enhancement-title {
      color: var(--text-main);
      font-size: 11px;
      font-weight: 800;
    }

    .enhancement-desc {
      color: var(--text-muted);
      font-size: 8.5px;
      line-height: 1.35;
      margin-top: 2px;
    }

    .enhancement-status {
      flex: 0 0 auto;
      border: 1px solid rgba(56, 189, 248, 0.28);
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      border-radius: 999px;
      padding: 2px 6px;
      font-size: 8.5px;
      font-weight: 800;
      white-space: nowrap;
    }

    .enhancement-status.failed,
    .enhancement-status.unavailable {
      border-color: rgba(255, 23, 68, 0.32);
      background: rgba(255, 23, 68, 0.10);
      color: #ffd7df;
    }

    .enhancement-meta {
      color: var(--text-muted);
      font-size: 8.5px;
    }

    .enhancement-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }

    .settings-lbl-title {
      font-size: 9.5px;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: 0.5px;
    }

    .settings-input {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 8px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }

    .settings-textarea {
      min-height: 76px;
      resize: vertical;
      line-height: 1.45;
    }

    .project-description-input {
      min-height: 68px;
    }

    .project-notes-input {
      min-height: 92px;
    }

    .settings-input:focus, .settings-textarea:focus {
      border-color: #00e5ff;
    }

    .impact-panel {
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.035);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .impact-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .impact-metric {
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 6px;
      padding: 8px;
      background: rgba(0, 0, 0, 0.12);
      min-width: 0;
    }

    .impact-metric-value {
      font-size: 18px;
      font-weight: 800;
      color: var(--text-main);
      line-height: 1.1;
    }

    .impact-metric-label {
      margin-top: 3px;
      font-size: 9px;
      color: var(--text-muted);
    }

    .agent-impact-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .impact-agent-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-start;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 7px;
    }

    .impact-agent-row:first-child {
      border-top: 0;
      padding-top: 0;
    }

    .impact-agent-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .impact-agent-name {
      font-size: 11px;
      font-weight: 800;
      color: var(--text-main);
    }

    .impact-agent-detail {
      font-size: 9px;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .impact-status {
      flex-shrink: 0;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 9px;
      font-weight: 800;
      border: 1px solid var(--border-glass);
      color: var(--text-muted);
    }

    .impact-status.ready {
      border-color: rgba(0, 230, 118, 0.25);
      color: #00e676;
      background: rgba(0, 230, 118, 0.08);
    }

    .impact-status.unknown {
      border-color: rgba(255, 183, 77, 0.28);
      color: #ffcc80;
      background: rgba(255, 183, 77, 0.08);
    }

    .impact-status.missing {
      border-color: rgba(255, 82, 82, 0.24);
      color: #ff8a80;
      background: rgba(255, 82, 82, 0.08);
    }

    .settings-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }

    .settings-action-btn {
      flex: 1;
      padding: 8px;
      font-size: 11px;
      font-weight: 700;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.2s;
    }

    .settings-action-btn.test-btn {
      border: 1px solid var(--border-glass);
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-main);
    }

    .settings-action-btn.test-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .settings-action-btn.save-btn {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
    }

    .settings-action-btn.save-btn:hover {
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.3);
    }

    .cli-badge {
      margin-top: 8px;
      font-size: 11px;
      padding: 6px 8px;
      border-radius: 6px;
      font-weight: 600;
      text-align: center;
      line-height: 1.3;
    }

    .cli-badge.success {
      background: rgba(0, 230, 118, 0.1);
      color: #00e676;
      border: 1px solid rgba(0, 230, 118, 0.15);
    }

    .cli-badge.error {
      background: rgba(255, 23, 68, 0.1);
      color: #ff1744;
      border: 1px solid rgba(255, 23, 68, 0.15);
    }

    .btn-gear {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      padding: 4px;
      width: 34px;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      flex-shrink: 0;
    }

    .btn-gear:hover {
      color: #00e5ff;
      transform: rotate(30deg) scale(1.1);
    }

    @media (max-width: 720px) {
      header {
        padding: 12px 14px;
        flex-wrap: wrap;
        align-items: flex-start;
      }

      .controls {
        width: 100%;
        gap: 8px;
        justify-content: flex-end;
      }

      .project-select {
        flex: 1 1 160px;
        width: auto;
      }

      .roadmap-canvas {
        padding: 18px 12px;
        gap: 22px;
      }

      .methodology-overview {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .node-summary,
      .conversation-row {
        flex-direction: column;
        align-items: stretch;
      }

      .node-actions {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        width: 100%;
      }

      .conversation-compose input {
        flex: 1 1 auto;
      }

      .btn-send-conversation {
        flex: 0 0 42px;
      }

      .conversation-actions {
        justify-content: flex-start;
      }

      .settings-overlay,
      .feedback-overlay,
      .roadmap-revision-popover {
        top: 118px;
        bottom: 12px;
        left: 12px;
        right: 12px;
        width: auto;
        max-width: none;
      }
    }

    @media (max-width: 430px) {
      h1 {
        font-size: 18px;
      }

      .controls {
        justify-content: flex-start;
      }

      .btn-project-add,
      .btn-project-remove,
      .btn-solo,
      .btn-roadmap-revision {
        width: 34px;
        min-width: 34px;
      }

      .node-card {
        padding: 16px;
      }

      .methodology-overview {
        grid-template-columns: 1fr;
      }

      .node-title {
        font-size: 14px;
      }

      .status-badge,
      .btn-run {
        max-width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <header>
      <div class="brand-title">
        <img class="brand-wordmark" src="${wordmarkUri}" width="132" height="34" alt="SoloMap">
        <div class="header-divider"></div>
        <div class="page-heading" id="roadmap-page-title">项目路线图</div>
      </div>
      <div class="controls">
        <div class="solo-select project-select" id="project-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label></span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox"></div>
        </div>
        <button class="btn-project-remove" id="btn-remove-project" title="Remove project"><span class="codicon codicon-trash"></span></button>
        <button class="btn-roadmap-revision" id="btn-toggle-roadmap-revision" title="Revise Roadmap"><span class="codicon codicon-git-compare"></span></button>
        <button class="btn-gear" id="btn-toggle-feedback" title="Feedback"><span class="codicon codicon-comment-discussion"></span></button>
        <button class="btn-gear" id="btn-toggle-settings" title="Project Settings"><span class="codicon codicon-settings-gear"></span></button>
      </div>
    </header>

    <div class="view-tabs" role="tablist">
      <button class="view-tab active" id="btn-toggle-roadmap-view" type="button"><span class="codicon codicon-map"></span><span id="roadmap-view-tab-label">环节推进</span></button>
      <button class="view-tab solo-tab" id="btn-toggle-solo" type="button"><span class="codicon codicon-comment-discussion"></span><span id="solo-view-tab-label">自由研讨</span></button>
      <button class="view-tab flow-tab" id="btn-toggle-flow" type="button"><span class="codicon codicon-debug-alt-small"></span><span id="flow-view-tab-label">自动闭环</span></button>
    </div>

    <div class="roadmap-canvas view-panel active" id="canvas">
      <div class="flow-line"></div>
      <!-- Nodes are injected here -->
    </div>

    <div class="solo-view view-panel" id="solo-panel">
      <div class="solo-view-inner">
        <div class="solo-conversation-body" id="solo-body"></div>
      </div>
    </div>

    <div class="solo-view view-panel" id="flow-panel">
      <div class="solo-view-inner">
        <div class="solo-conversation-body" id="flow-body"></div>
      </div>
    </div>
  </div>

  <div class="roadmap-revision-popover" id="roadmap-revision-panel">
    <div class="roadmap-revision-header">
      <h3><span class="codicon codicon-git-compare"></span><span id="roadmap-revision-title">Revise Roadmap</span></h3>
      <button class="btn-close-revision" id="btn-close-roadmap-revision" title="Close"><span class="codicon codicon-close"></span></button>
    </div>
    <div class="roadmap-revision-body" id="roadmap-revision-body"></div>
  </div>

  <div class="feedback-overlay" id="feedback-panel">
    <div class="settings-header">
      <h3><span class="codicon codicon-comment-discussion"></span> <span id="feedback-title">Feedback</span></h3>
      <button class="btn-close-settings" id="btn-close-feedback"><span class="codicon codicon-close"></span></button>
    </div>
    <div class="feedback-type-row">
      <button class="feedback-type-btn active" type="button" data-feedback-type="not_working" id="feedback-type-not-working">Not working</button>
      <button class="feedback-type-btn" type="button" data-feedback-type="next_step" id="feedback-type-next-step">Next step unclear</button>
      <button class="feedback-type-btn" type="button" data-feedback-type="feature_request" id="feedback-type-feature">Feature request</button>
    </div>
    <div class="settings-field">
      <input
        type="text"
        class="settings-input"
        id="setting-feedback-title"
        placeholder="What should be improved?"
      >
      <textarea class="settings-input settings-textarea" id="setting-feedback-body" placeholder="Add what happened and what you expected." style="min-height: 84px; margin-top: 5px;"></textarea>
      <button class="settings-action-btn test-btn" id="btn-open-feedback" style="margin-top: 6px; width: 100%;"><span class="codicon codicon-github"></span><span id="text-open-feedback">Send Feedback</span></button>
    </div>
  </div>

  <!-- Settings Panel Overlay -->
  <div class="settings-overlay" id="settings-panel">
    <div class="settings-header">
      <h3><span class="codicon codicon-settings-gear"></span> <span id="settings-title">Project Settings</span></h3>
      <button class="btn-close-settings" id="btn-close-settings"><span class="codicon codicon-close"></span></button>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-folder"></span><span id="settings-section-basic">Project Profile</span></div>
      <div class="settings-field">
        <label class="settings-lbl-title" id="label-project-name">Project Name</label>
        <input type="text" class="settings-input" id="project-name-input" placeholder="Project name">
      </div>
      <div class="settings-field">
        <label class="settings-lbl-title" id="label-project-description">One-line Description</label>
        <textarea class="settings-input settings-textarea project-description-input" id="project-description-input" placeholder="What is this project for?"></textarea>
      </div>
      <div class="settings-field">
        <label class="settings-lbl-title" id="label-project-notes">Notes</label>
        <textarea class="settings-input settings-textarea project-notes-input" id="project-notes-input" placeholder="Useful context, constraints, or reminders."></textarea>
      </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-symbol-class"></span><span id="settings-section-data">Project Shape</span></div>
      <div class="settings-field">
        <label class="settings-lbl-title" id="label-project-type">Category</label>
        <div class="solo-select settings-select" id="project-type-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label></span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox"></div>
        </div>
      </div>
      <div class="settings-field">
        <label class="settings-lbl-title" id="label-project-priority">Priority</label>
        <div class="solo-select settings-select" id="project-priority-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label></span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox"></div>
        </div>
      </div>
    </div>

    <div class="settings-actions">
      <button class="settings-action-btn save-btn" id="btn-save-settings"><span class="codicon codicon-save"></span><span id="text-save-settings">Save</span></button>
    </div>
    <div class="cli-badge" id="cli-test-badge" style="display:none;"></div>
  </div>

  <script>
    ${getSharedWebviewRuntimeScript()}
    const vscode = acquireVsCodeApi();
    const {
      escapeHtml,
      statusClass,
      extractNativeSessionId,
      closeSoloSelects,
      setSoloSelectValue,
      getSoloSelectValue,
      setSoloSelectOptions,
      renderSoloSelect,
      bindSoloSelect,
      bindSoloSelects,
      buildAgentOption,
      normalizeAgentOptionLabel
    } = SoloMapWebview;
    const canvas = document.getElementById('canvas');
    const projectSelect = document.getElementById('project-select');
    const btnRemoveProject = document.getElementById('btn-remove-project');
    const btnToggleRoadmapView = document.getElementById('btn-toggle-roadmap-view');
    const btnToggleSolo = document.getElementById('btn-toggle-solo');
    const btnToggleFlow = document.getElementById('btn-toggle-flow');
    const soloPanel = document.getElementById('solo-panel');
    const soloBody = document.getElementById('solo-body');
    const flowPanel = document.getElementById('flow-panel');
    const flowBody = document.getElementById('flow-body');
    const btnToggleRoadmapRevision = document.getElementById('btn-toggle-roadmap-revision');
    const btnCloseRoadmapRevision = document.getElementById('btn-close-roadmap-revision');
    const roadmapRevisionPanel = document.getElementById('roadmap-revision-panel');
    const roadmapRevisionBody = document.getElementById('roadmap-revision-body');

    // Settings Panel elements
    const btnToggleFeedback = document.getElementById('btn-toggle-feedback');
    const btnCloseFeedback = document.getElementById('btn-close-feedback');
    const feedbackPanel = document.getElementById('feedback-panel');
    const btnToggleSettings = document.getElementById('btn-toggle-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const settingsPanel = document.getElementById('settings-panel');
    const settingCliSelect = document.getElementById('setting-cli-select');
    const settingAgentModelSelect = document.getElementById('setting-agent-model-select');
    const settingCliPathCustom = document.getElementById('setting-clipath-custom');
    const settingLanguage = document.getElementById('setting-language');
    const settingGlobalPrompt = document.getElementById('setting-global-prompt');
    const settingGlobalDataPath = document.getElementById('setting-global-data-path');
    const settingReviewerCliSelect = document.getElementById('setting-reviewer-cli-select');
    const settingReviewerCliPathCustom = document.getElementById('setting-reviewer-clipath-custom');
    const settingCollaborationReviewMode = document.getElementById('setting-collaboration-review-mode');
    const proAccountPanel = document.getElementById('pro-account-panel');
    const btnOpenProAuthorization = document.getElementById('btn-open-pro-authorization');
    const settingAbilitySelect = document.getElementById('setting-ability-select');
    const settingsAbilityUrlInputContainer = document.getElementById('settings-ability-url-input-container');
    const settingAbilityUrlInput = document.getElementById('setting-ability-url-input');
    const helpAbilityUrlInput = document.getElementById('help-ability-url-input');
    const abilityDetailCard = document.getElementById('ability-detail-card');
    const abilityDetailTitle = document.getElementById('ability-detail-title');
    const abilityDetailDesc = document.getElementById('ability-detail-desc');
    const abilityDetailStatus = document.getElementById('ability-detail-status');
    const abilityDetailMeta = document.getElementById('ability-detail-meta');
    const btnInstallAbility = document.getElementById('btn-install-ability');
    const btnUninstallAbility = document.getElementById('btn-uninstall-ability');
    const abilityActionBadge = document.getElementById('ability-action-badge');
    const settingFeedbackTitle = document.getElementById('setting-feedback-title');
    const settingFeedbackBody = document.getElementById('setting-feedback-body');
    const btnOpenFeedback = document.getElementById('btn-open-feedback');
    const btnTestCli = document.getElementById('btn-test-cli');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const cliTestBadge = document.getElementById('cli-test-badge');
    const btnRefreshAgentImpact = document.getElementById('btn-refresh-agent-impact');
    const agentImpactList = document.getElementById('agent-impact-list');
    const projectTypeSelect = document.getElementById('project-type-select');
    const projectPrioritySelect = document.getElementById('project-priority-select');
    const projectNameInput = document.getElementById('project-name-input');
    const projectDescriptionInput = document.getElementById('project-description-input');
    const projectNotesInput = document.getElementById('project-notes-input');
    let currentLanguage = 'zh';
    let currentNodes = [];
    let expandedNodeId = '';
    let pendingFocusedNodeId = '';
    let activeMethodologyStage = '';
    let activeConversationId = '';
    let activeProjectPath = '';
    let currentCliPath = 'agy';
    let currentFeedbackType = 'not_working';
    let activeMainView = 'roadmap';
    let currentSettings = {};
    let settingsFormDirty = false;
    let settingsSavePending = false;
    let settingsRequestSeq = 0;
    let currentRoadmapLoading = false;
    let currentRoadmapError = '';
    let selectedEnhancementId = '';
    const roadmapRevisionId = '__roadmap_revision__';
    const soloConversationId = '__solo__';
    let roadmapRevisionExpanded = false;
    let soloExpanded = false;
    let flowExpanded = false;
    let soloPanelDirty = true;
    let flowPanelDirty = true;
    const nodeConversations = {};
    const nodeConversationPaging = {};
    const nodeSupplementFiles = {};
    const pendingPastedAttachments = {};
    const conversationDrafts = {};
    let conversationChildrenMap = {};
    const conversationLogScrollPositions = {};
    const nodeAgentSelections = {};
    const agentModelCatalogs = {};
    const conversationModelSelections = {};
    const agentModelPreferenceMap = {};
    let soloAgentSelection = '';
    let flowAgentSelection = '';
    let roadmapRevisionAgentSelection = '';
    let soloDraft = '';
    let roadmapRevisionDraft = '';
    let currentFlowState = { hasProAccess: false, flow: null, history: [] };
    let agentModelRequestSeq = 0;
    const i18n = {
      zh: {
        title: 'SoloMap',
        addProject: '添加项目文件夹',
        settingsTitle: '项目设置',
        language: '界面语言',
        removeProject: '删除项目',
        projectName: '项目名称',
        projectNamePlaceholder: '用于在项目列表里识别这个项目',
        projectDescription: '一句话简介',
        projectDescriptionPlaceholder: '这个项目服务谁，解决什么问题？',
        projectNotes: '备注',
        projectNotesPlaceholder: '补充边界、目标、提醒或协作上下文...',
        projectType: '项目类别',
        projectPriority: '项目优先级',
        cliPath: 'Agent CLI 命令或路径',
        cliPathHelp: '填写全局安装的 CLI 命令（如 agy、codex、cursor、claude、copilot、opencode）或可执行文件绝对路径。',
        globalPrompt: '全局默认提示词',
        globalPromptPlaceholder: '例如：始终保持改动范围最小，并运行最相关的验证。',
        globalPromptHelp: '会注入每一次任务对话；环节内本次补充要求优先级更高。',
        globalDataPath: '跨项目数据目录',
        globalDataPathPlaceholder: '例如：/home/ubuntu/project/.solomap-global',
        globalDataPathHelp: '保存跨项目组合、依赖、学习候选和指标；可填 .solomap-global 目录路径，或填其父目录。',
        reviewerCliPath: '复核 Agent',
        reviewerCliPathPlaceholder: '留空则使用主 Agent',
        reviewerCliPathHelp: '可选的副 Agent CLI，只读复核任务结果，不直接改文件。',
        collaborationReviewMode: '自动复核',
        collaborationReviewHelp: '复核会折叠在被复核的主对话下方。',
        reviewerSame: '跟随主 Agent',
        followupRecords: '后续记录',
        continuationCount: '续聊',
        reviewCount: '复核',
        settingsSectionBasic: '基础',
        settingsSectionAccount: 'SoloMap 账号',
        settingsSectionAgent: 'Agent 协作',
        settingsSectionData: '项目数据',
        settingsSectionInstructions: '默认指令',
        settingsSectionAbilities: '能力扩展',
        proFeatureName: '战略金字塔',
        proUnlocked: '已解锁',
        proLocked: '未解锁',
        proAccountAnonymous: '未登录',
        proValidUntil: '有效期至',
        proExpirationHelp: '注：此为本地授权缓存过期时间。每次联网或执行任务时，系统都会静默刷新授权，为您顺延有效期（如购买的是年会员请放心使用）。',
        proLogin: '登录 / 升级 Pro',
        proPasteCode: '粘贴授权码',
        proAccountHelp: '登录后即可打开 Pro 功能；本地项目数据仍留在你的工作区。',
        accountName: 'SoloMap 账号',
        accountFree: '免费账号',
        accountLogin: '登录 SoloMap',
        proUpgrade: '升级 Pro',
        accountSignedOutHelp: '登录后可使用账号功能；本地项目数据仍留在你的工作区。',
        accountSignedInHelp: '已登录，可使用 SoloMap 免费功能。',
        accountProHelp: 'Pro 权限已生效。',
        reviewHighRisk: '高风险任务',
        reviewAll: '每次任务',
        reviewOff: '关闭',
        agentImpact: 'Agent 贡献',
        impactMinutes: '工作分钟',
        impactFiles: '改动文件',
        impactProgress: '项目推进',
        refreshAgentImpact: '刷新贡献',
        impactLoading: '正在统计贡献...',
        impactEmpty: '还没有可统计的 Agent 贡献。',
        impactRunUnit: '次',
        impactMinuteUnit: '分钟',
        impactFileUnit: '个文件',
        skillInstall: '安装技能',
        skillInstallPlaceholder: '例如：https://skills.sh/owner/repo 或 owner/repo@skill',
        skillInstallHelp: '粘贴 skills.sh 或 GitHub 技能链接，SoloMap 会安装到全局技能库。',
        installSkill: '安装技能',
        installingSkill: '正在启动安装...',
        mcpInstall: '安装连接器',
        mcpInstallPlaceholder: '例如：GitHub MCP server、npm 包名或配置片段',
        mcpInstallHelp: '粘贴 MCP 来源，SoloMap 会注册到全局能力连接器库。',
        installMcp: '安装连接器',
        installingMcp: '正在启动安装...',
        enhancementToggles: '执行增强',
        enhancementTogglesHelp: '选择一个执行增强后安装或卸载。SoloMap 会让 Agent CLI 完成用户环境里的真实安装和彻底卸载；状态会自动检测。',
        abilityManagerLabel: '能力扩展与执行增强',
        abilityManagerHelp: '在这里管理您的已安装技能 (Skills)、连接器 (MCP Connectors) 与内置的执行增强 (Enhancements)。',
        abilitySelectPlaceholder: '请选择能力或增强...',
        abilityGroupSkills: '技能 (Skills)',
        abilityGroupConnectors: '连接器 (MCP Connectors)',
        abilityGroupEnhancements: '执行增强 (Enhancements)',
        addSkill: '➕ 新增技能...',
        addSkillDescription: '安装外部技能以扩展能力',
        addConnector: '➕ 新增连接器...',
        addConnectorDescription: '集成外部 MCP 服务生态',
        installedStatus: '已安装',
        readyStatus: '已就绪',
        notInstalledStatus: '未安装',
        skillMetaPrefix: '技能路径：',
        connectorMetaPrefix: '连接器类型：',
        enhancementMetaPrefix: '内置增强 · 版本：',
        skillInstallInputHelp: '粘贴 skills.sh 或 GitHub 技能仓库链接。SoloMap 会将其安装到全局技能库中。',
        mcpInstallInputHelp: '粘贴 MCP 连接器源。SoloMap 将其注册为全局连接器。',
        skillInputRequired: '请先输入要安装的技能链接。',
        mcpInputRequired: '请先输入要安装的连接器源。',
        installingSkillMessage: '正在安装技能...',
        installingMcpMessage: '正在安装连接器...',
        installingEnhancementMessage: '正在安装执行增强...',
        uninstallingSkillMessage: '正在卸载技能...',
        uninstallingMcpMessage: '正在卸载连接器...',
        uninstallingEnhancementMessage: '正在卸载执行增强...',
        selectEnhancement: '选择增强功能',
        installingEnhancement: '正在启动安装...',
        uninstallingEnhancement: '正在启动卸载...',
        installEnhancement: '安装',
        repairEnhancement: '修复',
        enableEnhancement: '启用',
        disableEnhancement: '禁用',
        uninstallEnhancement: '卸载',
        checkEnhancement: '重新检测',
        enhancementVersion: '版本',
        enhancementStateEnabled: '已启用',
        enhancementStateDisabled: '未启用',
        feedback: '建议反馈',
        feedbackNotWorking: '没跑通',
        feedbackNextStep: '不懂下一步',
        feedbackFeature: '想要能力',
        feedbackPanelTitle: '反馈',
        feedbackTitlePlaceholder: '一句话说明想反馈的问题...',
        feedbackBodyPlaceholder: '补充现象、期望结果或改进建议...',
        openFeedback: '提交到 GitHub Issue',
        testCli: '测试 CLI',
        save: '保存',
        chooseProject: '选择项目文件夹',
        emptyRoadmap: '还没有路线图。请添加项目文件夹，或重新打开当前项目。',
        onboardingKicker: '新手开始',
        onboardingTitle: '先把一个项目交给 SoloMap',
        onboardingCopy: '选择一个本地项目文件夹。SoloMap 会带你确认项目类型，然后生成第一张可推进路线图。',
        onboardingStepProject: '添加本地项目文件夹',
        onboardingStepType: '选择这个项目更像哪一类',
        onboardingStepRoadmap: '在“生成初始路线图”里输入目标，让 Agent 产出第一版路线图',
        onboardingAction: '添加第一个项目',
        startConversation: '发起 Agent 对话',
        conversationHistory: 'Agent 对话历史',
        noConversations: '这个环节还没有 Agent 对话。',
        conversationPlaceholder: '补充这次要 Agent 注意的要求...',
        agentSelector: '选择 Agent',
        attachFiles: '选择补充文件',
        attachedFiles: '补充文件',
        addingScreenshot: '正在添加截图…',
        removeAttachment: '移除',
        send: '发送',
        retry: '重试',
        continueNative: '继续',
        openTerminal: '打开终端',
        stopRun: '停止',
        rollbackChange: '撤销修改',
        rollbackConfirm: '确认撤销这次对话带来的项目修改吗？接下来还会有一次正式确认。',
        elapsed: '已运行',
        duration: '耗时',
        runResult: '本轮结果',
        stillWorking: 'Agent 正在执行这次对话。',
        continuationRecorded: '续聊已记录。',
        awaitingNextConversation: '本轮已结束，环节仍可继续推进。',
        stepCompleted: 'Agent 判断该环节已完成。',
        changedCount: '本轮修改文件数',
        agentConclusion: 'Agent 结论',
        failureLabel: '失败原因',
        completionCriteria: '完成标准',
        roadmapView: '环节推进',
        soloTitle: '自由研讨',
        flowTitle: '自动闭环',
        flowPlaceholder: '描述你想让 Flow 自动推进完成的目标...',
        flowHistory: '执行轨迹',
        flowStart: '启动 Flow',
        flowLocked: 'Flow 为 Pro 用户提供目标驱动的自动滚动执行。',
        flowUpgrade: '登录 / 升级 Pro',
        flowEmpty: '还没有 Flow 运行。写下目标后，系统会先规划微循环，再持续推进直到完成。',
        soloPlaceholder: '描述你现在想处理的问题或想法...',
        soloHistory: 'Solo 对话历史',
        noSoloConversations: '还没有 Solo 对话。',
        loadMoreConversations: '加载更多对话',
        loadingMoreConversations: '正在加载…',
        sendSolo: '发送',
        soloCompleted: '本次 Solo 对话已结束。',
        soloClosure: '这次对话是否需要进入路线图？',
        linkToStep: '关联到环节',
        keepInSolo: '无需关联时，这次对话会保留在 Solo。',
        adjustRoadmap: '调整路线图',
        chooseStep: '选择关联环节',
        linkedFromSolo: '这是一条从 Solo 关联的参考记录，不会改变环节状态。',
        failureCategories: {
          cli_not_found: '未找到所选 Agent CLI。',
          stopped_by_user: '任务已由用户停止。',
          no_deliverable_changes: 'Agent 已退出，但没有检测到文件修改或完成判断。',
          roadmap_validation_failed: '生成的路线图未通过结构校验。',
          roadmap_not_updated: 'Agent 未更新路线图，原路线图保持不变。',
          completion_state_invalid: 'Agent 返回的完成状态无法读取。',
          agent_exit_failed: 'Agent CLI 在交付任务前退出。'
        },
        command: '命令',
        output: '输出',
        changedFiles: '修改文件',
        openFile: '打开',
        testing: '正在测试连接...',
        connectionOk: '连接正常：',
        connectionFailed: '连接失败：',
        markComplete: '完成环节',
        reviseRoadmap: '调整路线图',
        reviseRoadmapPlaceholder: '描述目标、优先级或方向发生了什么变化...',
        revisionHistory: '路线图调整历史',
        noRevisionConversations: '还没有路线图调整记录。',
        sendRevision: '发送调整',
        roadmapLoading: '正在打开路线图...',
        methodologyBuild: '打造',
        methodologySell: '触达',
        methodologyLearn: '学习',
        methodologyImprove: '改进',
        methodologyMissing: '缺少对应环节',
        methodologyCompleted: '已完成',
        status: { Pending: '待处理', 'In Progress': '推进中', Running: '对话中', Completed: '已完成', Failed: '失败', Linked: '已关联', Recorded: '已记录' }
      },
      en: {
        title: 'SoloMap',
        addProject: 'Add project folder',
        settingsTitle: 'Project Settings',
        language: 'Language',
        removeProject: 'Remove project',
        projectName: 'Project name',
        projectNamePlaceholder: 'Name used to recognize this project',
        projectDescription: 'One-line description',
        projectDescriptionPlaceholder: 'Who is this for, and what problem does it solve?',
        projectNotes: 'Notes',
        projectNotesPlaceholder: 'Add boundaries, goals, reminders, or collaboration context...',
        projectType: 'Category',
        projectPriority: 'Priority',
        cliPath: 'CLI Command or Path',
        cliPathHelp: 'Name of a globally installed CLI such as agy, codex, cursor, claude, copilot, or opencode, or an absolute executable path.',
        globalPrompt: 'Default Agent Instructions',
        globalPromptPlaceholder: 'e.g. Keep changes minimal and run the narrowest relevant test.',
        globalPromptHelp: 'Injected into every task conversation; guidance in the current conversation takes priority.',
        globalDataPath: 'Global Data Directory',
        globalDataPathPlaceholder: 'e.g. /home/ubuntu/project/.solomap-global',
        globalDataPathHelp: 'Stores cross-project portfolio, dependencies, learning candidates, and metrics. Use the .solomap-global path or its parent directory.',
        reviewerCliPath: 'Review Agent',
        reviewerCliPathPlaceholder: 'Leave empty to use the main Agent',
        reviewerCliPathHelp: 'Optional secondary CLI for read-only review after task runs.',
        collaborationReviewMode: 'Auto Review',
        collaborationReviewHelp: 'Review runs are folded under the task conversation they check.',
        reviewerSame: 'Same as main Agent',
        followupRecords: 'Follow-up Records',
        continuationCount: 'Continuations',
        reviewCount: 'Reviews',
        settingsSectionBasic: 'Basics',
        settingsSectionAccount: 'SoloMap Account',
        settingsSectionAgent: 'Agent Collaboration',
        settingsSectionData: 'Project Data',
        settingsSectionInstructions: 'Instructions',
        settingsSectionAbilities: 'Abilities',
        proFeatureName: 'Strategy Pyramid',
        proUnlocked: 'Unlocked',
        proLocked: 'Locked',
        proAccountAnonymous: 'Not signed in',
        proValidUntil: 'Valid until',
        proExpirationHelp: 'Note: This is the local authorization cache expiration. The system will automatically and silently refresh the authorization to extend this date whenever you are online.',
        proLogin: 'Sign in / Upgrade Pro',
        proPasteCode: 'Paste authorization code',
        proAccountHelp: 'Sign in to open Pro features; local project data stays in your workspace.',
        accountName: 'SoloMap Account',
        accountFree: 'Free account',
        accountLogin: 'Sign in to SoloMap',
        proUpgrade: 'Upgrade to Pro',
        accountSignedOutHelp: 'Sign in to use account features; local project data stays in your workspace.',
        accountSignedInHelp: 'Signed in with access to SoloMap free features.',
        accountProHelp: 'Your Pro access is active.',
        reviewHighRisk: 'High-risk tasks',
        reviewAll: 'Every task',
        reviewOff: 'Off',
        agentImpact: 'Agent Impact',
        impactMinutes: 'Minutes',
        impactFiles: 'Files changed',
        impactProgress: 'Project progress',
        refreshAgentImpact: 'Refresh Impact',
        impactLoading: 'Collecting impact...',
        impactEmpty: 'No Agent impact recorded yet.',
        impactRunUnit: 'runs',
        impactMinuteUnit: 'min',
        impactFileUnit: 'files',
        skillInstall: 'Install Skill',
        skillInstallPlaceholder: 'e.g. https://skills.sh/owner/repo or owner/repo@skill',
        skillInstallHelp: 'Paste a skills.sh or GitHub skill link. SoloMap installs it into the global skill library.',
        installSkill: 'Install Skill',
        installingSkill: 'Starting install...',
        mcpInstall: 'Install Connector',
        mcpInstallPlaceholder: 'e.g. GitHub MCP server, npm package, or config snippet',
        mcpInstallHelp: 'Paste an MCP source. SoloMap registers it in the global connector library.',
        installMcp: 'Install Connector',
        installingMcp: 'Starting install...',
        enhancementToggles: 'Harness Enhancements',
        enhancementTogglesHelp: 'Choose one enhancement, then install or uninstall it. SoloMap asks the Agent CLI to perform the real user-environment install or full uninstall; status is detected automatically.',
        abilityManagerLabel: 'Ability Extensions & Execution Enhancements',
        abilityManagerHelp: 'Manage installed Skills, MCP Connectors, and built-in execution enhancements here.',
        abilitySelectPlaceholder: 'Select an ability or enhancement...',
        abilityGroupSkills: 'Skills',
        abilityGroupConnectors: 'MCP Connectors',
        abilityGroupEnhancements: 'Execution Enhancements',
        addSkill: '➕ Add Skill...',
        addSkillDescription: 'Install an external skill to extend SoloMap.',
        addConnector: '➕ Add Connector...',
        addConnectorDescription: 'Connect an external MCP service.',
        installedStatus: 'Installed',
        readyStatus: 'Ready',
        notInstalledStatus: 'Not installed',
        skillMetaPrefix: 'Skill path: ',
        connectorMetaPrefix: 'Connector type: ',
        enhancementMetaPrefix: 'Built-in enhancement · Version: ',
        skillInstallInputHelp: 'Paste a skills.sh or GitHub skill repository link. SoloMap installs it into the global skill library.',
        mcpInstallInputHelp: 'Paste an MCP connector source. SoloMap registers it as a global connector.',
        skillInputRequired: 'Enter a skill link before installing.',
        mcpInputRequired: 'Enter a connector source before installing.',
        installingSkillMessage: 'Installing skill...',
        installingMcpMessage: 'Installing connector...',
        installingEnhancementMessage: 'Installing execution enhancement...',
        uninstallingSkillMessage: 'Uninstalling skill...',
        uninstallingMcpMessage: 'Uninstalling connector...',
        uninstallingEnhancementMessage: 'Uninstalling execution enhancement...',
        selectEnhancement: 'Select enhancement',
        installingEnhancement: 'Starting install...',
        uninstallingEnhancement: 'Starting uninstall...',
        installEnhancement: 'Install',
        repairEnhancement: 'Repair',
        enableEnhancement: 'Enable',
        disableEnhancement: 'Disable',
        uninstallEnhancement: 'Uninstall',
        checkEnhancement: 'Check',
        enhancementVersion: 'Version',
        enhancementStateEnabled: 'Enabled',
        enhancementStateDisabled: 'Disabled',
        feedback: 'Feedback',
        feedbackNotWorking: 'Not working',
        feedbackNextStep: 'Next step unclear',
        feedbackFeature: 'Feature request',
        feedbackPanelTitle: 'Feedback',
        feedbackTitlePlaceholder: 'Summarize the issue or idea...',
        feedbackBodyPlaceholder: 'Add what happened, what you expected, or the suggestion...',
        openFeedback: 'Open GitHub Issue',
        testCli: 'Test CLI',
        save: 'Save',
        chooseProject: 'Choose project folder',
        emptyRoadmap: 'No roadmap yet. Add a project folder or reopen the current project.',
        onboardingKicker: 'Get started',
        onboardingTitle: 'Give SoloMap one local project first',
        onboardingCopy: 'Choose a local project folder. SoloMap will ask for its type, then help create the first actionable roadmap.',
        onboardingStepProject: 'Add a local project folder',
        onboardingStepType: 'Choose what kind of project it is',
        onboardingStepRoadmap: 'Use "Generate Initial Roadmap" to describe the goal and let the Agent create the first roadmap',
        onboardingAction: 'Add first project',
        startConversation: 'Start Agent Conversation',
        conversationHistory: 'Agent Conversation History',
        noConversations: 'No Agent conversations for this step yet.',
        conversationPlaceholder: 'Add guidance for this Agent run...',
        agentSelector: 'Choose Agent',
        attachFiles: 'Attach files',
        attachedFiles: 'Attached files',
        addingScreenshot: 'Adding screenshot…',
        removeAttachment: 'Remove',
        send: 'Send',
        retry: 'Retry',
        continueNative: 'Continue',
        openTerminal: 'Open terminal',
        stopRun: 'Stop',
        rollbackChange: 'Undo changes',
        rollbackConfirm: 'Undo the project changes from this conversation? You will still see one more final confirmation.',
        elapsed: 'Elapsed',
        duration: 'Duration',
        runResult: 'Run result',
        stillWorking: 'The Agent is running this conversation.',
        continuationRecorded: 'Continuation recorded.',
        awaitingNextConversation: 'This run ended; the step can continue.',
        stepCompleted: 'The Agent marked this step complete.',
        changedCount: 'Files changed in this run',
        agentConclusion: 'Agent conclusion',
        failureLabel: 'Failure reason',
        completionCriteria: 'Completion criteria',
        roadmapView: 'Step Progress',
        soloTitle: 'Free Work',
        flowTitle: 'Auto Loop',
        flowPlaceholder: 'Describe the goal you want Flow to drive to completion...',
        flowHistory: 'Execution trace',
        flowStart: 'Start Flow',
        flowLocked: 'Flow is a Pro mode for goal-driven automatic execution.',
        flowUpgrade: 'Sign in / Upgrade Pro',
        flowEmpty: 'No Flow run yet. Enter a goal and SoloMap will plan micro loops, then keep rolling until the task is closed.',
        soloPlaceholder: 'Describe the issue or idea you want to handle...',
        soloHistory: 'Solo conversation history',
        noSoloConversations: 'No Solo conversations yet.',
        loadMoreConversations: 'Load more conversations',
        loadingMoreConversations: 'Loading…',
        sendSolo: 'Send',
        soloCompleted: 'This Solo conversation has finished.',
        soloClosure: 'Should this conversation be connected to the roadmap?',
        linkToStep: 'Link to step',
        keepInSolo: 'Leave unlinked to keep this conversation in Solo.',
        adjustRoadmap: 'Revise roadmap',
        chooseStep: 'Choose a step',
        linkedFromSolo: 'This is a reference linked from Solo and does not change the step state.',
        failureCategories: {
          cli_not_found: 'The selected Agent CLI was not found.',
          stopped_by_user: 'The task was stopped by the user.',
          no_deliverable_changes: 'The Agent exited without detected file changes or a completion decision.',
          roadmap_validation_failed: 'The generated roadmap failed structure validation.',
          roadmap_not_updated: 'The Agent did not update the roadmap; the previous roadmap was kept.',
          completion_state_invalid: 'The Agent completion state could not be read.',
          agent_exit_failed: 'The Agent CLI exited before delivering the task.'
        },
        command: 'Command',
        output: 'Output',
        changedFiles: 'Changed Files',
        openFile: 'Open',
        testing: 'Testing connection...',
        connectionOk: 'Connection OK: ',
        connectionFailed: 'Connection Failed: ',
        markComplete: 'Complete Step',
        reviseRoadmap: 'Revise Roadmap',
        reviseRoadmapPlaceholder: 'Describe what changed in your goal, priority, or direction...',
        revisionHistory: 'Roadmap Revision History',
        noRevisionConversations: 'No roadmap revisions yet.',
        sendRevision: 'Send revision',
        roadmapLoading: 'Opening roadmap...',
        methodologyBuild: 'Build',
        methodologySell: 'Sell',
        methodologyLearn: 'Learn',
        methodologyImprove: 'Improve',
        methodologyMissing: 'Missing step',
        methodologyCompleted: 'completed',
        status: { Pending: 'Pending', 'In Progress': 'In Progress', Running: 'Running', Completed: 'Completed', Failed: 'Failed', Linked: 'Linked', Recorded: 'Recorded' }
      }
    };

    function t(key) {
      return i18n[currentLanguage][key] || i18n.en[key] || key;
    }

    function statusText(status) {
      return (i18n[currentLanguage].status || {})[status] || status;
    }

    function conversationStatusText(status) {
      if (status === 'Completed') {
        return currentLanguage === 'zh' ? '已结束' : 'Finished';
      }
      return statusText(status);
    }

    function failureCategoryText(category) {
      return (i18n[currentLanguage].failureCategories || {})[category] || '';
    }

    function playAutomationTone() {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        const audioContext = new AudioContextClass();
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.08, audioContext.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.28);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.3);
      } catch (error) {
        console.warn('SoloMap automation sound failed:', error);
      }
    }

    function captureComposerInputState(container, selector) {
      const input = container && container.querySelector ? container.querySelector(selector) : null;
      if (!input) return null;
      return {
        value: input.value || '',
        wasFocused: document.activeElement === input,
        selectionStart: typeof input.selectionStart === 'number' ? input.selectionStart : null,
        selectionEnd: typeof input.selectionEnd === 'number' ? input.selectionEnd : null,
        scrollLeft: typeof input.scrollLeft === 'number' ? input.scrollLeft : 0
      };
    }

    function restoreComposerInputState(container, selector, state) {
      if (!state || !container || !container.querySelector) return;
      const input = container.querySelector(selector);
      if (!input) return;
      input.value = state.value;
      if (typeof input.scrollLeft === 'number') {
        input.scrollLeft = state.scrollLeft || 0;
      }
      if (state.wasFocused && typeof input.focus === 'function') {
        input.focus();
        if (
          typeof input.setSelectionRange === 'function'
          && state.selectionStart !== null
          && state.selectionEnd !== null
        ) {
          input.setSelectionRange(state.selectionStart, state.selectionEnd);
        }
      }
    }

    function extractContinuationParentConversationId(conversation) {
      return Number(conversation && conversation.continuationParentConversationId || 0);
    }

    function extractReviewParentConversationId(conversation) {
      return Number(conversation && conversation.reviewParentConversationId || 0);
    }

    function isReviewConversation(conversation) {
      return Boolean(extractReviewParentConversationId(conversation));
    }

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function resetProjectScopedState(projectPath, clearNodes) {
      activeProjectPath = projectPath || '';
      expandedNodeId = '';
      activeMethodologyStage = '';
      roadmapRevisionExpanded = false;
      soloExpanded = false;
      flowExpanded = false;
      activeConversationId = '';
      if (soloPanel) soloPanel.classList.remove('open');
      if (soloPanel) soloPanel.classList.remove('active');
      if (flowPanel) flowPanel.classList.remove('active');
      if (canvas) canvas.classList.add('active');
      if (btnToggleRoadmapView) btnToggleRoadmapView.classList.add('active');
      if (btnToggleSolo) btnToggleSolo.classList.remove('active');
      if (btnToggleFlow) btnToggleFlow.classList.remove('active');
      if (soloBody) soloBody.innerHTML = '';
      if (flowBody) flowBody.innerHTML = '';
      soloPanelDirty = true;
      flowPanelDirty = true;
      if (roadmapRevisionPanel) roadmapRevisionPanel.classList.remove('open');
      if (btnToggleRoadmapRevision) btnToggleRoadmapRevision.classList.remove('active');
      if (roadmapRevisionBody) roadmapRevisionBody.innerHTML = '';
      Object.keys(nodeConversations).forEach(key => delete nodeConversations[key]);
      Object.keys(nodeConversationPaging).forEach(key => delete nodeConversationPaging[key]);
      Object.keys(nodeSupplementFiles).forEach(key => delete nodeSupplementFiles[key]);
      Object.keys(conversationDrafts).forEach(key => delete conversationDrafts[key]);
      Object.keys(nodeAgentSelections).forEach(key => delete nodeAgentSelections[key]);
      if (clearNodes) {
        currentNodes = [];
      }
    }

    function applyLanguage() {
      setText('app-title', t('title'));
      setText('roadmap-page-title', currentLanguage === 'zh' ? '项目路线图' : 'Project Roadmap');
      if (btnRemoveProject) btnRemoveProject.title = t('removeProject');
      if (btnToggleSolo) btnToggleSolo.title = t('soloTitle');
      if (btnToggleFlow) btnToggleFlow.title = t('flowTitle');
      if (btnToggleFeedback) btnToggleFeedback.title = t('feedbackPanelTitle');
      if (btnToggleSettings) btnToggleSettings.title = t('settingsTitle');
      setText('roadmap-view-tab-label', t('roadmapView'));
      setText('solo-view-tab-label', t('soloTitle'));
      setText('flow-view-tab-label', t('flowTitle'));
      if (btnToggleRoadmapRevision) btnToggleRoadmapRevision.title = t('reviseRoadmap');
      setText('settings-title', t('settingsTitle'));
      setText('feedback-title', t('feedbackPanelTitle'));
      setText('feedback-type-not-working', t('feedbackNotWorking'));
      setText('feedback-type-next-step', t('feedbackNextStep'));
      setText('feedback-type-feature', t('feedbackFeature'));
      setText('roadmap-revision-title', t('reviseRoadmap'));
      setText('solo-title', t('soloTitle'));
      setText('label-language', t('language'));
      setText('label-cli-path', t('cliPath'));
      setText('help-cli-path', t('cliPathHelp'));
      setText('label-agent-model', currentLanguage === 'zh' ? '默认模型' : 'Default Model');
      setText('help-agent-model', currentLanguage === 'zh'
        ? '默认跟随当前 Agent 系列的自动模型；固定后会优先使用该模型。'
        : 'Uses the selected Agent family default unless you pin a specific model.');
      setText('label-global-prompt', t('globalPrompt'));
      if (settingGlobalPrompt) settingGlobalPrompt.placeholder = t('globalPromptPlaceholder');
      setText('help-global-prompt', t('globalPromptHelp'));
      setText('label-global-data-path', t('globalDataPath'));
      if (settingGlobalDataPath) settingGlobalDataPath.placeholder = t('globalDataPathPlaceholder');
      setText('help-global-data-path', t('globalDataPathHelp'));
      setText('label-reviewer-cli-path', t('reviewerCliPath'));
      if (settingReviewerCliPathCustom) settingReviewerCliPathCustom.placeholder = t('reviewerCliPathPlaceholder');
      setText('help-reviewer-cli-path', t('reviewerCliPathHelp'));
      setText('label-collaboration-review-mode', t('collaborationReviewMode'));
      setText('help-collaboration-review-mode', t('collaborationReviewHelp'));
      setText('option-reviewer-same', t('reviewerSame'));
      if (settingReviewerCliSelect) setSoloSelectValue(settingReviewerCliSelect, getSoloSelectValue(settingReviewerCliSelect));
      setText('settings-section-basic', t('settingsSectionBasic'));
      setText('settings-section-account', t('settingsSectionAccount'));
      setText('settings-section-agent', t('settingsSectionAgent'));
      setText('settings-section-data', t('settingsSectionData'));
      setText('settings-section-instructions', t('settingsSectionInstructions'));
      setText('settings-section-abilities', t('settingsSectionAbilities'));
      setText('option-review-high-risk', t('reviewHighRisk'));
      setText('option-review-all', t('reviewAll'));
      setText('option-review-off', t('reviewOff'));
      if (settingCollaborationReviewMode) setSoloSelectValue(settingCollaborationReviewMode, getSoloSelectValue(settingCollaborationReviewMode) || 'high_risk');
      setText('label-agent-impact', t('agentImpact'));
      setText('impact-minutes-label', t('impactMinutes'));
      setText('impact-files-label', t('impactFiles'));
      setText('impact-progress-label', t('impactProgress'));
      setText('text-refresh-agent-impact', t('refreshAgentImpact'));
      setText('text-open-pro-authorization', t('proLogin'));
      setText('label-enhancement-toggles', t('abilityManagerLabel'));
      setText('help-enhancement-toggles', t('abilityManagerHelp'));
      setText('text-install-ability', t('installEnhancement'));
      setText('text-uninstall-ability', t('uninstallEnhancement'));
      if (settingFeedbackTitle) settingFeedbackTitle.placeholder = t('feedbackTitlePlaceholder');
      if (settingFeedbackBody) settingFeedbackBody.placeholder = t('feedbackBodyPlaceholder');
      setText('text-open-feedback', t('openFeedback'));
      setText('text-test-cli', t('testCli'));
      setText('text-save-settings', t('save'));
      setText('label-project-name', t('projectName'));
      setText('label-project-description', t('projectDescription'));
      setText('label-project-notes', t('projectNotes'));
      setText('label-project-type', t('projectType'));
      setText('label-project-priority', t('projectPriority'));
      if (projectNameInput) projectNameInput.placeholder = t('projectNamePlaceholder');
      if (projectDescriptionInput) projectDescriptionInput.placeholder = t('projectDescriptionPlaceholder');
      if (projectNotesInput) projectNotesInput.placeholder = t('projectNotesPlaceholder');
      renderProjects(currentProjects.projects, currentProjects.selectedProjectPath);
      renderRoadmap(currentNodes);
      renderSoloPanel(currentNodes);
      renderFlowPanel();
      renderRoadmapRevisionPanel(currentNodes);
      renderProAccount(currentSettings);
    }

    const currentProjects = { projects: [], selectedProjectPath: '' };

    function requestSoloConversationPage(page) {
      const current = nodeConversationPaging[soloConversationId] || { page: -1, hasMore: true, loading: false, initialized: false };
      if (current.loading || (page > 0 && !current.hasMore)) return;
      nodeConversationPaging[soloConversationId] = { ...current, loading: true };
      vscode.postMessage({ command: 'conversation.getHistory', nodeId: soloConversationId, page, pageSize: 20 });
    }

    function setMainView(view) {
      activeMainView = view === 'solo' ? 'solo' : view === 'flow' ? 'flow' : 'roadmap';
      soloExpanded = activeMainView === 'solo';
      flowExpanded = activeMainView === 'flow';
      if (canvas) canvas.classList.toggle('active', activeMainView === 'roadmap');
      if (soloPanel) soloPanel.classList.toggle('active', activeMainView === 'solo');
      if (flowPanel) flowPanel.classList.toggle('active', activeMainView === 'flow');
      if (btnToggleRoadmapView) btnToggleRoadmapView.classList.toggle('active', activeMainView === 'roadmap');
      if (btnToggleSolo) btnToggleSolo.classList.toggle('active', activeMainView === 'solo');
      if (btnToggleFlow) btnToggleFlow.classList.toggle('active', activeMainView === 'flow');
      const soloPaging = nodeConversationPaging[soloConversationId];
      if (activeMainView === 'solo' && (!soloPaging || !soloPaging.initialized)) {
        requestSoloConversationPage(0);
      }
      if (activeMainView === 'solo') {
        ensureAgentModelsLoaded(soloAgentSelection || currentCliPath || 'agy', soloConversationId);
      }
      if (activeMainView === 'flow') {
        ensureAgentModelsLoaded(flowAgentSelection || currentCliPath || 'agy', 'flow');
        vscode.postMessage({ command: 'getFlowState' });
      }
      if (activeMainView === 'solo' && (soloPanelDirty || !soloBody || !soloBody.innerHTML)) {
        renderSoloPanel(currentNodes);
      }
      if (activeMainView === 'flow' && (flowPanelDirty || !flowBody || !flowBody.innerHTML)) {
        renderFlowPanel();
      }
    }

    if (btnToggleFeedback) {
      btnToggleFeedback.addEventListener('click', () => {
        if (feedbackPanel.style.display === 'flex') {
          feedbackPanel.style.display = 'none';
        } else {
          roadmapRevisionExpanded = false;
          roadmapRevisionPanel.classList.remove('open');
          btnToggleRoadmapRevision.classList.remove('active');
          settingsPanel.style.display = 'none';
          feedbackPanel.style.display = 'flex';
        }
      });
    }

    if (btnCloseFeedback) {
      btnCloseFeedback.addEventListener('click', () => {
        feedbackPanel.style.display = 'none';
      });
    }

    // Toggle Settings panel visibility
    btnToggleSettings.addEventListener('click', () => {
      if (settingsPanel.style.display === 'flex') {
        settingsPanel.style.display = 'none';
      } else {
        roadmapRevisionExpanded = false;
        roadmapRevisionPanel.classList.remove('open');
        btnToggleRoadmapRevision.classList.remove('active');
        feedbackPanel.style.display = 'none';
        settingsPanel.style.display = 'flex';
        settingsFormDirty = false;
        renderProjectSettings();
        requestSettings();
      }
    });

    btnCloseSettings.addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      if (cliTestBadge) cliTestBadge.style.display = 'none';
    });

    btnToggleRoadmapView.addEventListener('click', () => {
      setMainView('roadmap');
    });

    btnToggleSolo.addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      if (cliTestBadge) cliTestBadge.style.display = 'none';
      roadmapRevisionExpanded = false;
      roadmapRevisionPanel.classList.remove('open');
      btnToggleRoadmapRevision.classList.remove('active');
      setMainView('solo');
    });

    if (btnToggleFlow) {
      btnToggleFlow.addEventListener('click', () => {
        settingsPanel.style.display = 'none';
        if (cliTestBadge) cliTestBadge.style.display = 'none';
        roadmapRevisionExpanded = false;
        roadmapRevisionPanel.classList.remove('open');
        btnToggleRoadmapRevision.classList.remove('active');
        if (!currentFlowState.hasProAccess) {
          vscode.postMessage({ command: 'entitlement.upgrade' });
          return;
        }
        setMainView('flow');
      });
    }

    btnToggleRoadmapRevision.addEventListener('click', () => {
      roadmapRevisionExpanded = !roadmapRevisionExpanded;
      activeConversationId = '';
      roadmapRevisionPanel.classList.toggle('open', roadmapRevisionExpanded);
      btnToggleRoadmapRevision.classList.toggle('active', roadmapRevisionExpanded);
      if (roadmapRevisionExpanded) {
        settingsPanel.style.display = 'none';
        feedbackPanel.style.display = 'none';
        if (cliTestBadge) cliTestBadge.style.display = 'none';
        setMainView('roadmap');
        if (!nodeConversations[roadmapRevisionId]) {
          vscode.postMessage({ command: 'conversation.getHistory', nodeId: roadmapRevisionId });
        }
      }
      renderRoadmapRevisionPanel(currentNodes);
    });

    btnCloseRoadmapRevision.addEventListener('click', () => {
      roadmapRevisionExpanded = false;
      activeConversationId = '';
      roadmapRevisionPanel.classList.remove('open');
      btnToggleRoadmapRevision.classList.remove('active');
      renderRoadmapRevisionPanel(currentNodes);
    });

    bindSoloSelect(settingLanguage, (value) => {
      currentLanguage = value;
      applyLanguage();
    });

    bindSoloSelect(settingCliSelect, () => {
      // Toggle custom input visibility; the label is handled by solo-select itself.
      const selected = getSoloSelectValue(settingCliSelect);
      if (settingCliPathCustom) settingCliPathCustom.style.display = selected === 'custom' ? 'block' : 'none';
      currentCliPath = selected === 'custom' ? getEffectiveSettingCliPath() : selected || 'agy';
      ensureAgentModelsLoaded(currentCliPath, 'settings');
      syncSettingAgentModelSelect();
    });
    if (settingCliPathCustom) {
      const refreshCustomCliModels = () => {
        if (getSoloSelectValue(settingCliSelect) !== 'custom') return;
        currentCliPath = getEffectiveSettingCliPath();
        ensureAgentModelsLoaded(currentCliPath, 'settings');
        syncSettingAgentModelSelect();
      };
      settingCliPathCustom.addEventListener('input', refreshCustomCliModels);
      settingCliPathCustom.addEventListener('change', refreshCustomCliModels);
    }
    bindSoloSelect(settingAgentModelSelect, (value) => {
      const family = getAgentFamilyKey(getEffectiveSettingCliPath());
      if (!family) return;
      agentModelPreferenceMap[family] = value || 'auto';
      conversationModelSelections.settings = value || 'auto';
    });
    bindSoloSelect(settingReviewerCliSelect, () => {
      const selected = getSoloSelectValue(settingReviewerCliSelect);
      if (settingReviewerCliPathCustom) {
        settingReviewerCliPathCustom.style.display = selected === 'custom' ? 'block' : 'none';
      }
    });
    bindSoloSelect(settingCollaborationReviewMode, () => {});

    if (btnOpenProAuthorization) {
      btnOpenProAuthorization.addEventListener('click', () => {
        const authenticated = Boolean(currentSettings && currentSettings.proAccount && currentSettings.proAccount.authenticated);
        vscode.postMessage({ command: authenticated ? 'entitlement.upgrade' : 'account.login' });
      });
    }

    function showAbilityActionMessage(message, isError = false) {
      if (!abilityActionBadge) return;
      abilityActionBadge.style.display = 'block';
      abilityActionBadge.className = isError ? 'cli-badge error' : 'cli-badge';
      abilityActionBadge.style.background = isError ? '' : 'rgba(255,255,255,0.05)';
      abilityActionBadge.style.color = isError ? '' : 'var(--text-muted)';
      abilityActionBadge.textContent = message;
    }

    const getCliPresetFromCliPath = SoloMapWebview.getCliPresetFromCliPath;
    const modelController = SoloMapWebview.createModelController({
      catalogs: agentModelCatalogs,
      preferences: agentModelPreferenceMap,
      selections: conversationModelSelections,
      getCurrentCliPath: () => currentCliPath,
      getEffectiveSettingCliPath: () => getEffectiveSettingCliPath(),
      nextRequestId: () => 'models-' + (++agentModelRequestSeq),
      postMessage: message => vscode.postMessage(message)
    });
    const {
      getAgentFamilyKey,
      getAutoOnlyModelCatalog,
      getAgentModelCatalog,
      getAgentModelOptions,
      sanitizeModelValue,
      getStoredModelPreference,
      getTargetModelValue,
      setTargetModelValue,
      ensureAgentModelsLoaded
    } = modelController;

    function renderModelSelect(className, attributes, agentCli, targetId) {
      return renderSoloSelect(
        className,
        attributes,
        getAgentModelOptions(agentCli),
        false,
        getTargetModelValue(targetId, agentCli)
      );
    }

    function syncSettingAgentModelSelect() {
      if (!settingAgentModelSelect) return;
      const agentCli = getEffectiveSettingCliPath();
      setSoloSelectOptions(settingAgentModelSelect, getAgentModelOptions(agentCli), getStoredModelPreference(agentCli));
    }

    function getEffectiveSettingCliPath() {
      return SoloMapWebview.getEffectiveSettingCliPath(settingCliSelect, settingCliPathCustom, currentCliPath);
    }

    function applySettingCliPath(cliPath) {
      currentCliPath = SoloMapWebview.applySettingCliPath(settingCliSelect, settingCliPathCustom, cliPath);
    }

    function getEffectiveReviewerCliPath() {
      return SoloMapWebview.getEffectiveReviewerCliPath(settingReviewerCliSelect, settingReviewerCliPathCustom);
    }

    function applyReviewerCliPath(cliPath) {
      SoloMapWebview.applyReviewerCliPath(settingReviewerCliSelect, settingReviewerCliPathCustom, cliPath);
    }

    function hasStrategyPyramidPro(settings) {
      return SoloMapWebview.hasProEntitlement(settings, 'strategy_pyramid');
    }

    function renderProAccount(settings) {
      SoloMapWebview.renderProAccount(proAccountPanel, settings, t, currentLanguage);
      if (!btnOpenProAuthorization) return;
      const authenticated = Boolean(settings && settings.proAccount && settings.proAccount.authenticated);
      const unlocked = hasStrategyPyramidPro(settings);
      btnOpenProAuthorization.style.display = unlocked ? 'none' : '';
      const actionText = btnOpenProAuthorization.querySelector('span:last-child');
      if (actionText) actionText.textContent = authenticated ? t('proUpgrade') : t('accountLogin');
      const actionIcon = btnOpenProAuthorization.querySelector('.codicon');
      if (actionIcon) actionIcon.className = 'codicon ' + (authenticated ? 'codicon-rocket' : 'codicon-sign-in');
    }

    const abilityController = SoloMapWebview.createAbilityController({
      t,
      showMessage: showAbilityActionMessage,
      postMessage: message => vscode.postMessage(message),
      elements: {
        select: settingAbilitySelect,
        urlContainer: settingsAbilityUrlInputContainer,
        urlInput: settingAbilityUrlInput,
        urlHelp: helpAbilityUrlInput,
        detailCard: abilityDetailCard,
        detailTitle: abilityDetailTitle,
        detailDescription: abilityDetailDesc,
        detailStatus: abilityDetailStatus,
        detailMeta: abilityDetailMeta,
        installButton: btnInstallAbility,
        uninstallButton: btnUninstallAbility
      }
    });

    function renderAbilitiesAndEnhancements(settings) {
      abilityController.render(settings);
    }

    document.addEventListener('click', event => {
      const rollbackBtn = event.target.closest('.rollback-btn');
      if (rollbackBtn) {
        event.stopPropagation();
        if (typeof window.confirm === 'function' && !window.confirm(t('rollbackConfirm'))) {
          return;
        }
        const gitHash = rollbackBtn.getAttribute('data-rollback-hash');
        if (gitHash) {
          vscode.postMessage({
            command: 'conversation.rollback',
            gitHash: gitHash,
            projectPath: activeProjectPath
          });
        }
      }
    });

    function requestSettings() {
      vscode.postMessage({
        command: 'settings.get',
        requestId: 'roadmap-settings-' + (++settingsRequestSeq)
      });
    }

    if (settingsPanel) {
      settingsPanel.addEventListener('input', () => {
        settingsFormDirty = true;
      });
      settingsPanel.addEventListener('change', () => {
        settingsFormDirty = true;
      });
      settingsPanel.addEventListener('click', event => {
        if (event.target && event.target.closest && event.target.closest('[data-solo-option-value]')) {
          settingsFormDirty = true;
        }
      });
    }

    // Request nodes and settings on load
    vscode.postMessage({ command: 'getNodes' });
    requestSettings();
    vscode.postMessage({ command: 'project.getAll' });
    vscode.postMessage({ command: 'getFlowState' });
    if (typeof setInterval === 'function') {
      setInterval(() => {
        updateRunningConversationDurations(canvas, nodeConversations);
        updateRunningConversationDurations(roadmapRevisionBody, {
          [roadmapRevisionId]: nodeConversations[roadmapRevisionId] || []
        });
        updateRunningConversationDurations(soloBody, {
          [soloConversationId]: nodeConversations[soloConversationId] || []
        });
        if (flowExpanded && currentFlowState.flow && currentFlowState.flow.status === 'running') {
          renderFlowPanel();
        }
      }, 1000);
    }

    // Handle messages from Extension Host
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'roadmapLoading':
          currentRoadmapLoading = true;
          currentRoadmapError = '';
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            resetProjectScopedState(message.projectPath, true);
          }
          renderRoadmap(currentNodes);
          break;
        case 'roadmapLoadFailed':
          currentRoadmapLoading = false;
          currentRoadmapError = message.message || '';
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            resetProjectScopedState(message.projectPath, true);
          }
          renderRoadmap([]);
          break;
        case 'nodesUpdated':
          currentRoadmapLoading = false;
          currentRoadmapError = '';
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            resetProjectScopedState(message.projectPath, false);
          }
          currentNodes = message.nodes || [];
          if (pendingFocusedNodeId && currentNodes.some(node => node.id === pendingFocusedNodeId)) {
            expandedNodeId = pendingFocusedNodeId;
          }
          renderRoadmap(message.nodes);
          if (pendingFocusedNodeId) {
            const focusedCard = document.querySelector('[data-node-card-id="' + cssEscape(pendingFocusedNodeId) + '"]');
            if (focusedCard) {
              focusedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
              focusedCard.focus({ preventScroll: true });
              pendingFocusedNodeId = '';
            }
          }
          soloPanelDirty = true;
          flowPanelDirty = true;
          renderSoloPanel(currentNodes);
          renderFlowPanel();
          renderRoadmapRevisionPanel(currentNodes);
          break;
        case 'settingsLoaded':
          if (settingsSavePending && !message.requestId) {
            settingsSavePending = false;
            settingsFormDirty = false;
          }
          if (settingsSavePending || (settingsFormDirty && settingsPanel && settingsPanel.style.display === 'flex')) {
            currentSettings = { ...currentSettings, ...(message.settings || {}) };
            renderProAccount(currentSettings);
            renderAbilitiesAndEnhancements(currentSettings);
            break;
          }
          currentSettings = message.settings || {};
          Object.keys(agentModelPreferenceMap).forEach(key => delete agentModelPreferenceMap[key]);
          Object.assign(agentModelPreferenceMap, (message.settings && message.settings.agentModelPreferences) || {});
          applySettingCliPath(message.settings.cliPath || 'agy');
          soloAgentSelection = getEffectiveSettingCliPath();
          flowAgentSelection = getEffectiveSettingCliPath();
          roadmapRevisionAgentSelection = getEffectiveSettingCliPath();
          if (settingGlobalPrompt) settingGlobalPrompt.value = message.settings.globalPrompt || '';
          if (settingGlobalDataPath) settingGlobalDataPath.value = message.settings.globalDataPath || '';
          applyReviewerCliPath(message.settings.reviewerCliPath || '');
          if (settingCollaborationReviewMode) setSoloSelectValue(settingCollaborationReviewMode, message.settings.collaborationReviewMode || 'high_risk');
          syncSettingAgentModelSelect();
          ensureAgentModelsLoaded(getEffectiveSettingCliPath(), 'settings');
          renderProAccount(currentSettings);
          renderAbilitiesAndEnhancements(message.settings);
          if (settingLanguage) setSoloSelectValue(settingLanguage, message.settings.language || 'zh');
          currentLanguage = getSoloSelectValue(settingLanguage) || currentLanguage;
          applyLanguage();
          renderFlowPanel();
          break;
        case 'settingsSaved':
          settingsSavePending = false;
          settingsFormDirty = false;
          currentSettings = message.settings || currentSettings;
          break;
        case 'agentModelsLoaded': {
          const catalog = message.catalog || getAutoOnlyModelCatalog(message.targetId || '');
          const family = String(catalog.family || getAgentFamilyKey(message.agentCli || currentCliPath || 'agy')).toLowerCase();
          agentModelCatalogs[family] = catalog;
          syncSettingAgentModelSelect();
          if (message.targetId === soloConversationId) {
            renderSoloPanel(currentNodes);
          } else if (message.targetId === 'flow') {
            renderFlowPanel();
          } else if (message.targetId && message.targetId !== 'settings') {
            renderRoadmap(currentNodes);
          }
          break;
        }
        case 'flowStateLoaded':
          currentFlowState = message.state || { hasProAccess: false, flow: null, history: [] };
          flowPanelDirty = true;
          renderFlowPanel();
          break;
        case 'automationPlaySound':
          playAutomationTone();
          break;
        case 'setMainView':
          if (message.view === 'flow' && !currentFlowState.hasProAccess) {
            setMainView('roadmap');
            break;
          }
          setMainView(message.view || 'roadmap');
          break;
        case 'focusRoadmapNode':
          pendingFocusedNodeId = String(message.nodeId || '');
          setMainView('roadmap');
          if (pendingFocusedNodeId && currentNodes.some(node => node.id === pendingFocusedNodeId)) {
            expandedNodeId = pendingFocusedNodeId;
            renderRoadmap(currentNodes);
            const focusedCard = document.querySelector('[data-node-card-id="' + cssEscape(pendingFocusedNodeId) + '"]');
            if (focusedCard) {
              focusedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
              focusedCard.focus({ preventScroll: true });
              pendingFocusedNodeId = '';
            }
          }
          break;
        case 'projectsLoaded':
          if (
            message.projects.selectedProjectPath &&
            activeProjectPath &&
            message.projects.selectedProjectPath !== activeProjectPath
          ) {
            resetProjectScopedState(message.projects.selectedProjectPath, true);
            renderRoadmap(currentNodes);
          } else if (message.projects.selectedProjectPath && !activeProjectPath) {
            activeProjectPath = message.projects.selectedProjectPath;
          }
          currentProjects.projects = message.projects.projects || [];
          currentProjects.selectedProjectPath = message.projects.selectedProjectPath || '';
          renderProjects(message.projects.projects, message.projects.selectedProjectPath);
          break;
        case 'nodeConversationsLoaded':
          if (message.projectPath && message.projectPath !== activeProjectPath) {
            return;
          }
          if (message.nodeId === soloConversationId && message.pagination) {
            const incoming = message.conversations || [];
            const previous = message.pagination.append ? (nodeConversations[message.nodeId] || []) : [];
            const seen = new Set();
            nodeConversations[message.nodeId] = [...previous, ...incoming].filter((conversation) => {
              const id = String(conversation && conversation.id || '');
              if (!id || seen.has(id)) return false;
              seen.add(id);
              return true;
            });
            nodeConversationPaging[message.nodeId] = {
              page: Number(message.pagination.page || 0),
              pageSize: Number(message.pagination.pageSize || 20),
              hasMore: Boolean(message.pagination.hasMore),
              loading: false,
              initialized: true
            };
          } else {
            nodeConversations[message.nodeId] = message.conversations || [];
          }
          if (message.nodeId === soloConversationId) {
            soloPanelDirty = true;
            renderSoloPanel(currentNodes);
          } else if (message.nodeId === roadmapRevisionId) {
            renderRoadmapRevisionPanel(currentNodes);
          } else {
            renderRoadmap(currentNodes);
          }
          break;
        case 'supplementFilesSelected':
          if (message.nodeId && pendingPastedAttachments[message.nodeId]) {
            pendingPastedAttachments[message.nodeId].delete(String(message.requestId || ''));
          }
          const soloDraft = message.nodeId === soloConversationId
            ? (soloBody.querySelector('[data-solo-input]')?.value || '')
            : '';
          const revisionDraft = message.nodeId === roadmapRevisionId
            ? (roadmapRevisionBody.querySelector('[data-roadmap-revision-input]')?.value || '')
            : '';
          if (message.nodeId && message.nodeId !== soloConversationId && message.nodeId !== roadmapRevisionId) {
            const input = canvas.querySelector('[data-conversation-input-id="' + cssEscape(message.nodeId) + '"]');
            conversationDrafts[message.nodeId] = input ? input.value : (conversationDrafts[message.nodeId] || '');
          }
          nodeSupplementFiles[message.nodeId] = mergeSupplementFiles(
            nodeSupplementFiles[message.nodeId] || [],
            message.files || []
          );
          renderRoadmap(currentNodes);
          if (message.nodeId === soloConversationId) {
            renderSoloPanel(currentNodes);
            const input = soloBody.querySelector('[data-solo-input]');
            if (input) {
              input.value = soloDraft;
            }
          }
          if (message.nodeId === roadmapRevisionId) {
            renderRoadmapRevisionPanel(currentNodes);
            const input = roadmapRevisionBody.querySelector('[data-roadmap-revision-input]');
            if (input) {
              input.value = revisionDraft;
            }
          }
          break;
        case 'cliTestResult':
          cliTestBadge.style.display = 'block';
          if (message.success) {
            cliTestBadge.className = 'cli-badge success';
            cliTestBadge.textContent = t('connectionOk') + message.message;
          } else {
            cliTestBadge.className = 'cli-badge error';
            cliTestBadge.textContent = t('connectionFailed') + message.message;
          }
          break;
        case 'agentImpactLoaded':
          renderAgentImpact(message.status || {});
          break;
        case 'skillInstallResult':
          if (abilityActionBadge) {
            abilityActionBadge.style.display = 'block';
            abilityActionBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            abilityActionBadge.textContent = message.message || '';
          }
          if (message.settings) renderAbilitiesAndEnhancements(message.settings);
          break;
        case 'mcpInstallResult':
          if (abilityActionBadge) {
            abilityActionBadge.style.display = 'block';
            abilityActionBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            abilityActionBadge.textContent = message.message || '';
          }
          if (message.settings) renderAbilitiesAndEnhancements(message.settings);
          break;
        case 'enhancementInstallResult':
          if (abilityActionBadge) {
            abilityActionBadge.style.display = 'block';
            abilityActionBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            abilityActionBadge.textContent = message.message || '';
          }
          if (message.settings) renderAbilitiesAndEnhancements(message.settings);
          break;
      }
    });

    // Save configurations
    btnSaveSettings.addEventListener('click', () => {
      const projectPath = getSoloSelectValue(projectSelect);
      if (!projectPath) return;
      settingsSavePending = true;
      vscode.postMessage({
        command: 'project.updateMetadata',
        projectPath,
        name: projectNameInput ? projectNameInput.value.trim() : '',
        description: projectDescriptionInput ? projectDescriptionInput.value.trim() : '',
        notes: projectNotesInput ? projectNotesInput.value.trim() : '',
        projectType: getSoloSelectValue(projectTypeSelect),
        priority: getSoloSelectValue(projectPrioritySelect)
      });
      vscode.postMessage({
        command: 'settings.update',
        requestId: 'roadmap-settings-save-' + (++settingsRequestSeq),
        cliPath: getEffectiveSettingCliPath(),
        agentModelPreferences: agentModelPreferenceMap,
        language: getSoloSelectValue(settingLanguage) || currentLanguage,
        globalPrompt: settingGlobalPrompt ? settingGlobalPrompt.value : (currentSettings.globalPrompt || ''),
        globalDataPath: settingGlobalDataPath ? settingGlobalDataPath.value : (currentSettings.globalDataPath || ''),
        reviewerCliPath: getEffectiveReviewerCliPath(),
        collaborationReviewMode: settingCollaborationReviewMode ? getSoloSelectValue(settingCollaborationReviewMode) : (currentSettings.collaborationReviewMode || 'high_risk')
      });
      settingsPanel.style.display = 'none';
      if (cliTestBadge) cliTestBadge.style.display = 'none';
    });

    // Test CLI path
    if (btnTestCli) btnTestCli.addEventListener('click', () => {
      cliTestBadge.style.display = 'block';
      cliTestBadge.className = 'cli-badge';
      cliTestBadge.style.background = 'rgba(255,255,255,0.05)';
      cliTestBadge.style.color = 'var(--text-muted)';
      cliTestBadge.textContent = t('testing');

      vscode.postMessage({
        command: 'agent.testCli',
        cliPath: getEffectiveSettingCliPath()
      });
    });

    if (btnRefreshAgentImpact) {
      btnRefreshAgentImpact.addEventListener('click', () => {
        requestAgentImpact();
      });
    }

    function requestAgentImpact() {
      setAgentImpactPending();
      vscode.postMessage({
        command: 'agentImpact.get',
        cliPath: getEffectiveSettingCliPath()
      });
    }

    function setAgentImpactPending() {
      setText('impact-minutes', '...');
      setText('impact-files', '...');
      setText('impact-progress', '...');
      if (agentImpactList) {
        agentImpactList.innerHTML = '<div class="impact-agent-detail">' + escapeHtml(t('impactLoading')) + '</div>';
      }
    }

    function renderAgentImpact(status) {
      const impact = status.impact || {};
      setText('impact-minutes', String(impact.totalMinutes || 0));
      setText('impact-files', String(impact.changedFiles || 0));
      setText('impact-progress', String(impact.projectProgressPercent || 0) + '%');
      if (!agentImpactList) return;
      const agents = Array.isArray(impact.byAgent) ? impact.byAgent : [];
      if (!agents.length) {
        agentImpactList.innerHTML = '<div class="impact-agent-detail">' + escapeHtml(t('impactEmpty')) + '</div>';
        return;
      }
      agentImpactList.innerHTML = agents.map((agent) => {
        const detail = [
          (agent.runs || 0) + ' ' + t('impactRunUnit'),
          (agent.minutes || 0) + ' ' + t('impactMinuteUnit'),
          (agent.changedFiles || 0) + ' ' + t('impactFileUnit')
        ].join(' · ');
        return \`
          <div class="impact-agent-row">
            <div class="impact-agent-main">
              <div class="impact-agent-name">\${escapeHtml(agent.agent || '')}</div>
              <div class="impact-agent-detail">\${escapeHtml(detail)}</div>
            </div>
            <span class="impact-status ready">\${escapeHtml(String(agent.changedFiles || 0))}</span>
          </div>
        \`;
      }).join('');
    }

    if (btnOpenFeedback) {
      btnOpenFeedback.addEventListener('click', () => {
        vscode.postMessage({
          command: 'feedback.open',
          title: settingFeedbackTitle ? settingFeedbackTitle.value.trim() : '',
          body: settingFeedbackBody ? settingFeedbackBody.value.trim() : '',
          category: currentFeedbackType
        });
      });
    }

    document.querySelectorAll('[data-feedback-type]').forEach(button => {
      button.addEventListener('click', () => {
        currentFeedbackType = button.getAttribute('data-feedback-type') || 'not_working';
        document.querySelectorAll('[data-feedback-type]').forEach(item => {
          item.classList.toggle('active', item === button);
        });
      });
    });

    bindSoloSelect(projectSelect, (value) => {
      vscode.postMessage({
        command: 'project.select',
        projectPath: value
      });
    });

    bindSoloSelect(projectTypeSelect, () => {});
    bindSoloSelect(projectPrioritySelect, () => {});

    btnRemoveProject.addEventListener('click', () => {
      const projectPath = getSoloSelectValue(projectSelect);
      if (!projectPath) return;
      vscode.postMessage({ command: 'project.remove', projectPath });
    });

    function renderProjects(projects, selectedProjectPath) {
      if (!projects || projects.length === 0) {
        setSoloSelectOptions(projectSelect, [{ value: '', label: t('chooseProject') }], '');
        setSoloSelectOptions(projectTypeSelect, [{ value: '', label: 'Type' }], '');
        setSoloSelectOptions(projectPrioritySelect, [{ value: '', label: 'Priority' }], '');
        renderProjectSettings(null);
        return;
      }

      const selectedProject = projects.find(project => project.path === selectedProjectPath) || projects[0];
      setSoloSelectOptions(projectSelect, projects.map(project => ({
        value: project.path,
        label: project.name,
        title: project.path
      })), selectedProjectPath);
      setSoloSelectOptions(projectTypeSelect, getProjectTypeOptions(), selectedProject && selectedProject.type ? selectedProject.type : 'core_product');
      setSoloSelectOptions(projectPrioritySelect, getProjectPriorityOptions(), selectedProject && selectedProject.priority ? selectedProject.priority : '');
      renderProjectSettings(selectedProject);
    }

    function getSelectedProject() {
      const selectedPath = getSoloSelectValue(projectSelect) || currentProjects.selectedProjectPath || '';
      return (currentProjects.projects || []).find(project => project.path === selectedPath) || (currentProjects.projects || [])[0] || null;
    }


    function renderProjectSettings(project = getSelectedProject()) {
      if (!project) {
        if (projectNameInput) projectNameInput.value = '';
        if (projectDescriptionInput) projectDescriptionInput.value = '';
        if (projectNotesInput) projectNotesInput.value = '';
        setSoloSelectOptions(projectTypeSelect, getProjectTypeOptions(), 'core_product');
        setSoloSelectOptions(projectPrioritySelect, getProjectPriorityOptions(), '');
        return;
      }
      if (projectNameInput) projectNameInput.value = project.name || '';
      if (projectDescriptionInput) projectDescriptionInput.value = project.description || '';
      if (projectNotesInput) projectNotesInput.value = project.notes || '';
      setSoloSelectOptions(projectTypeSelect, getProjectTypeOptions(), project.type || 'core_product');
      setSoloSelectOptions(projectPrioritySelect, getProjectPriorityOptions(), project.priority || '');
    }

    function getProjectTypeOptions() {
      return [
        { value: 'core_product', label: '核心产品' },
        { value: 'infra', label: '基础设施' },
        { value: 'content', label: '内容产品' },
        { value: 'experiment', label: '试验研究' },
        { value: 'tool', label: '工具脚手架' },
        { value: 'daily_work', label: '日常工作处理' },
        { value: 'archive', label: '归档维护' }
      ];
    }

    function getProjectPriorityOptions() {
      return [
        { value: '', label: '自动优先级' },
        { value: 'P0', label: 'P0' },
        { value: 'P1', label: 'P1' },
        { value: 'P2', label: 'P2' },
        { value: 'P99', label: 'P99 冻结' }
      ];
    }

    document.addEventListener('click', () => closeSoloSelects());

    function getCompletionCriteria(node) {
      const criteria = Array.isArray(node.completionCriteria)
        ? node.completionCriteria.map(item => String(item || '').trim()).filter(Boolean)
        : [];
      if (criteria.length > 0) return criteria;
      return [node.description || node.agentPrompt || ''];
    }

    function renderCompletionCriteria(node) {
      const criteria = getCompletionCriteria(node).filter(Boolean);
      if (!criteria.length) return '';
      return \`
        <div class="completion-criteria" data-completion-criteria-id="\${escapeHtml(node.id)}">
          <div class="completion-criteria-title">\${escapeHtml(t('completionCriteria'))}</div>
          <ol class="completion-criteria-list">
            \${criteria.map(item => \`<li>\${escapeHtml(item)}</li>\`).join('')}
          </ol>
        </div>
      \`;
    }

    function renderOnboardingPanel() {
      return SoloMapWebview.renderOnboardingPanel(t);
    }

    function bindOnboardingActions(container) {
      SoloMapWebview.bindOnboardingActions(container, message => vscode.postMessage(message));
    }

    const methodologyStages = [
      { key: 'build', labelKey: 'methodologyBuild' },
      { key: 'sell', labelKey: 'methodologySell' },
      { key: 'learn', labelKey: 'methodologyLearn' },
      { key: 'improve', labelKey: 'methodologyImprove' }
    ];

    function inferMethodologyStage(node) {
      const text = String((node && node.stage) || '') + ' ' + String((node && node.title) || '');
      const normalized = text.toLowerCase();
      if (/营销|销售|分发|品牌|官网|发布|外联|获客|转化|sell|sales|market|launch|growth|distribution|outreach/.test(normalized)) {
        return 'sell';
      }
      if (/产品|mvp|构建|实现|开发|交付|源码|页面|功能|build|ship|implement|code|feature/.test(normalized)) {
        return 'build';
      }
      if (/调整|改进|复盘|规模化|路线图|优先级|下一轮|improve|iterate|iteration|roadmap|scale|optimi[sz]e/.test(normalized)) {
        return 'improve';
      }
      if (/问题|客户|发现|反馈|学习|访谈|指标|数据|issue|learn|feedback|customer|discovery|analytics|support/.test(normalized)) {
        return 'learn';
      }
      return 'build';
    }

    function getMethodologyStageCounts(nodes) {
      const counts = {
        build: { total: 0, completed: 0 },
        sell: { total: 0, completed: 0 },
        learn: { total: 0, completed: 0 },
        improve: { total: 0, completed: 0 }
      };
      (nodes || []).forEach(node => {
        const key = inferMethodologyStage(node);
        counts[key].total += 1;
        if (node.status === 'Completed') counts[key].completed += 1;
      });
      return counts;
    }

    function renderMethodologyOverview(nodes) {
      const counts = getMethodologyStageCounts(nodes);
      return \`
        <div class="methodology-overview" aria-label="Build Sell Learn Improve">
          \${methodologyStages.map(stage => {
            const item = counts[stage.key] || { total: 0, completed: 0 };
            const missing = Number(item.total || 0) === 0;
            const active = activeMethodologyStage === stage.key;
            return \`
              <div class="methodology-stage-card\${missing ? ' missing' : ''}\${active ? ' active' : ''}" role="button" tabindex="0" data-methodology-stage="\${escapeHtml(stage.key)}">
                <div>
                  <div class="methodology-stage-name">\${escapeHtml(t(stage.labelKey))}</div>
                  <div class="methodology-stage-meta">\${missing ? escapeHtml(t('methodologyMissing')) : escapeHtml(item.completed + ' / ' + item.total + ' ' + t('methodologyCompleted'))}</div>
                </div>
                \${missing ? \`<button class="methodology-adjust-btn" type="button" data-open-roadmap-revision>\${escapeHtml(t('reviseRoadmap'))}</button>\` : ''}
              </div>
            \`;
          }).join('')}
        </div>
      \`;
    }

    function bindMethodologyOverview(container) {
      container.querySelectorAll('[data-methodology-stage]').forEach(card => {
        const selectStage = () => {
          const stage = card.getAttribute('data-methodology-stage') || '';
          activeMethodologyStage = activeMethodologyStage === stage ? '' : stage;
          renderRoadmap(currentNodes);
          if (activeMethodologyStage) {
            setTimeout(() => {
              const target = canvas.querySelector('[data-methodology-row-stage="' + cssEscape(activeMethodologyStage) + '"]');
              if (target && typeof target.scrollIntoView === 'function') {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }, 0);
          }
        };
        card.addEventListener('click', (event) => {
          if (event.target.closest('[data-open-roadmap-revision]')) return;
          selectStage();
        });
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectStage();
          }
        });
      });
      container.querySelectorAll('[data-open-roadmap-revision]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          roadmapRevisionExpanded = true;
          if (settingsPanel) settingsPanel.style.display = 'none';
          roadmapRevisionPanel.classList.add('open');
          btnToggleRoadmapRevision.classList.add('active');
          renderRoadmapRevisionPanel(currentNodes);
        });
      });
    }

    function renderRoadmap(nodes) {
      captureConversationLogScrollPositions();
      // Clear canvas keeping the flow line
      const flowLine = canvas.querySelector('.flow-line');
      canvas.innerHTML = '';
      if (flowLine) canvas.appendChild(flowLine);

      if (!nodes || nodes.length === 0) {
        const placeholder = document.createElement('div');
        if (currentRoadmapLoading) {
          placeholder.innerHTML = '<div class="onboarding-panel"><div class="onboarding-title">' + escapeHtml(t('roadmapLoading')) + '</div></div>';
        } else if (currentRoadmapError) {
          placeholder.innerHTML = '<div class="onboarding-panel"><div class="onboarding-title">' + escapeHtml(currentRoadmapError) + '</div></div>';
        } else {
          placeholder.innerHTML = renderOnboardingPanel();
        }
        canvas.appendChild(placeholder);
        bindOnboardingActions(placeholder);
        return;
      }

      const overview = document.createElement('div');
      overview.className = 'methodology-shell';
      overview.innerHTML = renderMethodologyOverview(nodes);
      canvas.appendChild(overview);
      bindMethodologyOverview(overview);

      nodes.forEach(node => {
        const row = document.createElement('div');
        const methodologyStage = inferMethodologyStage(node);
        row.className = 'node-row methodology-' + methodologyStage + (activeMethodologyStage === methodologyStage ? ' stage-highlight' : '');
        row.setAttribute('data-methodology-row-stage', methodologyStage);

        const cleanStage = node.stage.replace(/[^a-zA-Z0-9]/g, '-');
        const expanded = expandedNodeId === node.id;
        const conversations = nodeConversations[node.id] || [];
        const supplementFiles = nodeSupplementFiles[node.id] || [];
        const conversationDisabled = '';
        const selectedAgentCli = nodeAgentSelections[node.id] || node.agentCli || currentCliPath || 'agy';
        const promptHtml = expanded ? \`
          <div class="node-expanded-body">
            <div class="node-desc">\${escapeHtml(node.description)}</div>
            <div class="node-agent-prompt">
              <strong>\${escapeHtml(node.agentCli)}:</strong> \${escapeHtml(node.agentPrompt)}
            </div>
            \${renderCompletionCriteria(node)}
            <div class="conversation-composer">
              <div class="conversation-compose conversation-compose-main">
                <button class="conversation-tool-btn" data-attach-node-id="\${escapeHtml(node.id)}" title="\${t('attachFiles')}" \${conversationDisabled}>
                  <span class="codicon codicon-attach"></span>
                </button>
                <input type="text" class="conversation-input" data-conversation-input-id="\${escapeHtml(node.id)}" placeholder="\${t('conversationPlaceholder')}" value="\${escapeHtml(conversationDrafts[node.id] || '')}" \${conversationDisabled}>
                <button class="btn-send-conversation" data-send-node-id="\${escapeHtml(node.id)}" title="\${t('send')}" \${conversationDisabled}>
                  <span class="codicon codicon-send"></span>
                </button>
              </div>
              <div class="conversation-compose conversation-compose-meta">
                \${renderSoloSelect('conversation-agent-select', 'data-agent-select-id="' + escapeHtml(node.id) + '" title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions(node), false, selectedAgentCli)}
                \${renderModelSelect('conversation-model-select', 'data-model-select-id="' + escapeHtml(node.id) + '" title="Model"', selectedAgentCli, node.id)}
              </div>
              \${renderSupplementFiles(node.id, supplementFiles)}
            </div>
            <div class="conversation-panel">
              <div class="conversation-title">\${t('conversationHistory')}</div>
              \${renderConversations(node.id, conversations)}
            </div>
          </div>
        \` : '';

        row.innerHTML = \`
          <div class="node-card status-\${statusClass(node.status)} \${expanded ? 'expanded' : 'collapsed'}" data-node-card-id="\${escapeHtml(node.id)}" tabindex="-1">
            <div class="node-summary">
              <div class="node-content">
                <div class="node-headline">
                  <span class="node-expand-icon">\${expanded ? '▾' : '▸'}</span>
                  <span class="node-badge stage-\${cleanStage}">\${escapeHtml(node.stage)}</span>
                  <span class="node-title">\${escapeHtml(node.title)}</span>
                </div>
                \${promptHtml}
              </div>
              <div class="node-actions">
                <span class="status-badge \${statusClass(node.status)}">\${statusText(node.status)}</span>
                \${node.status !== 'Completed' ? \`<button class="btn-run" data-complete-node-id="\${escapeHtml(node.id)}">\${t('markComplete')}</button>\` : ''}
              </div>
            </div>
          </div>
        \`;
        const card = row.querySelector('[data-node-card-id]');
        if (card) {
          card.addEventListener('click', (event) => {
            if (event.target.closest('button') || event.target.closest('input') || event.target.closest('[data-solo-select]') || event.target.closest('[data-conversation-id]')) {
              return;
            }
            toggleNode(node.id);
          });
        }
        const sendButton = row.querySelector('[data-send-node-id]');
        if (sendButton) {
          sendButton.addEventListener('click', (event) => {
            event.stopPropagation();
            const input = row.querySelector('[data-conversation-input-id="' + cssEscape(node.id) + '"]');
            const agentSelect = row.querySelector('[data-agent-select-id="' + cssEscape(node.id) + '"]');
            const modelSelect = row.querySelector('[data-model-select-id="' + cssEscape(node.id) + '"]');
            triggerRun(node.id, input ? input.value : '', getSoloSelectValue(agentSelect), getSoloSelectValue(modelSelect), nodeSupplementFiles[node.id] || []);
            if (input) input.value = '';
            conversationDrafts[node.id] = '';
            nodeSupplementFiles[node.id] = [];
            renderRoadmap(currentNodes);
          });
        }
        row.querySelectorAll('[data-conversation-input-id]').forEach(input => {
          input.addEventListener('input', () => {
            conversationDrafts[node.id] = input.value;
          });
        });
        row.querySelectorAll('[data-attach-node-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'attachment.choose', nodeId: node.id });
          });
        });
        row.querySelectorAll('[data-conversation-input-id]').forEach(input => {
          bindPastedImageAttachments(input, node.id, () => renderRoadmap(currentNodes));
        });
        const agentSelect = row.querySelector('[data-agent-select-id="' + cssEscape(node.id) + '"]');
        const modelSelect = row.querySelector('[data-model-select-id="' + cssEscape(node.id) + '"]');
        if (agentSelect) {
          bindSoloSelect(agentSelect, (value) => {
            nodeAgentSelections[node.id] = value || currentCliPath || 'agy';
            const nextCli = nodeAgentSelections[node.id];
            setTargetModelValue(node.id, nextCli, getTargetModelValue(node.id, nextCli), false);
            ensureAgentModelsLoaded(nextCli, node.id);
            renderRoadmap(currentNodes);
          });
        }
        if (modelSelect) {
          bindSoloSelect(modelSelect, (value) => {
            const cli = nodeAgentSelections[node.id] || node.agentCli || currentCliPath || 'agy';
            setTargetModelValue(node.id, cli, value, true);
          });
        }
        row.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            const file = item.getAttribute('data-remove-supplement-file');
            nodeSupplementFiles[node.id] = (nodeSupplementFiles[node.id] || []).filter(candidate => candidate !== file);
            renderRoadmap(currentNodes);
          });
        });
        bindSoloSelects(row);
        const completeButton = row.querySelector('[data-complete-node-id]');
        if (completeButton) {
          completeButton.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'completeNode', nodeId: node.id });
          });
        }
        row.querySelectorAll('[data-conversation-id] .conversation-row').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            const conversationItem = item.closest('[data-conversation-id]');
            const conversationId = conversationItem ? conversationItem.getAttribute('data-conversation-id') : '';
            activeConversationId = activeConversationId === conversationId
              ? ''
              : conversationId;
            renderRoadmap(currentNodes);
          });
        });
        row.querySelectorAll('.conversation-detail, .conversation-log-pre').forEach(item => {
          item.addEventListener('click', (event) => event.stopPropagation());
          item.addEventListener('mousedown', (event) => event.stopPropagation());
          item.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
          item.addEventListener('pointerdown', (event) => event.stopPropagation());
          item.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
        });
        row.querySelectorAll('[data-retry-conversation-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            const conversationId = item.getAttribute('data-retry-conversation-id');
            if (!conversationId) return;
            vscode.postMessage({
              command: 'conversation.retry',
              nodeId: node.id,
              conversationId
            });
          });
        });
        row.querySelectorAll('[data-show-agent-terminal]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({
              command: 'conversation.openTerminal',
              conversationId: item.getAttribute('data-show-agent-terminal')
            });
          });
        });
        row.querySelectorAll('[data-continue-native-conversation-id]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({
              command: 'conversation.continue',
              nodeId: item.getAttribute('data-continue-native-node-id') || node.id,
              conversationId: item.getAttribute('data-continue-native-conversation-id')
            });
          });
        });
        row.querySelectorAll('[data-stop-agent-run]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({
              command: 'conversation.stop',
              nodeId: node.id,
              conversationId: item.getAttribute('data-stop-agent-run')
            });
          });
        });
        row.querySelectorAll('[data-open-file-path]').forEach(item => {
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            const relativePath = item.getAttribute('data-open-file-path');
            if (!relativePath) return;
            vscode.postMessage({ command: 'project.openFile', relativePath });
          });
        });
        bindSoloSelects(row);
        canvas.appendChild(row);
      });
      restoreConversationLogScrollPositions();
    }

    function renderSoloClosure(conversation) {
      const options = (currentNodes || []).map(node => ({ value: node.id, label: node.title }));
      return \`
        <div class="solo-closure" data-solo-closure-id="\${escapeHtml(conversation.id)}">
          <div class="solo-closure-title">\${escapeHtml(t('soloClosure'))}</div>
          <div class="solo-closure-actions">
            \${options.length ? renderSoloSelect('solo-link-select', 'data-solo-link-select', options, false) : ''}
            \${options.length ? \`<button class="solo-action-btn" data-link-solo-id="\${escapeHtml(conversation.id)}">\${escapeHtml(t('linkToStep'))}</button>\` : ''}
            <button class="solo-action-btn secondary" data-open-revision-from-solo>\${escapeHtml(t('adjustRoadmap'))}</button>
          </div>
          <div class="conversation-runtime">\${escapeHtml(t('keepInSolo'))}</div>
        </div>
      \`;
    }

    function renderSoloPanel(nodes) {
      if (!soloPanel || !soloBody) {
        return;
      }
      const preservedInputState = captureComposerInputState(soloBody, '[data-solo-input]');
      if (preservedInputState) {
        soloDraft = preservedInputState.value;
      }
      const conversations = nodeConversations[soloConversationId] || [];
      const conversationPaging = nodeConversationPaging[soloConversationId] || { page: -1, hasMore: false, loading: false, initialized: false };
      const supplementFiles = nodeSupplementFiles[soloConversationId] || [];
      const disabled = '';
      const selectedAgentCli = soloAgentSelection || currentCliPath || 'agy';
      soloPanel.classList.toggle('active', soloExpanded);
      btnToggleSolo.classList.toggle('active', soloExpanded);
      if (!soloExpanded) {
        soloPanelDirty = true;
        return;
      }
      soloBody.innerHTML = \`
        <div class="conversation-composer">
          <div class="conversation-compose conversation-compose-main">
            <button class="conversation-tool-btn" data-attach-solo title="\${escapeHtml(t('attachFiles'))}" \${disabled}>
              <span class="codicon codicon-attach"></span>
            </button>
            <input type="text" class="conversation-input" data-solo-input placeholder="\${escapeHtml(t('soloPlaceholder'))}" value="\${escapeHtml(soloDraft)}" \${disabled}>
            <button class="btn-send-conversation" data-send-solo title="\${escapeHtml(t('sendSolo'))}" \${disabled}>
              <span class="codicon codicon-send"></span>
            </button>
          </div>
          <div class="conversation-compose conversation-compose-meta">
            \${renderSoloSelect('conversation-agent-select', 'data-solo-agent title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions({ agentCli: currentCliPath || 'agy' }), false, selectedAgentCli)}
            \${renderModelSelect('conversation-model-select', 'data-solo-model title="Model"', selectedAgentCli, soloConversationId)}
          </div>
          \${renderSupplementFiles(soloConversationId, supplementFiles)}
        </div>
        <div class="conversation-panel">
          <div class="conversation-title">\${escapeHtml(t('soloHistory'))}</div>
          \${renderConversations(soloConversationId, conversations, t('noSoloConversations'))}
          \${conversationPaging.hasMore ? \`
            <div class="conversation-pagination">
              <button type="button" class="conversation-load-more" data-load-more-solo \${conversationPaging.loading ? 'disabled' : ''}>
                \${escapeHtml(t(conversationPaging.loading ? 'loadingMoreConversations' : 'loadMoreConversations'))}
              </button>
            </div>
          \` : ''}
        </div>
      \`;
      const sendButton = soloBody.querySelector('[data-send-solo]');
      const attachButton = soloBody.querySelector('[data-attach-solo]');
      const loadMoreButton = soloBody.querySelector('[data-load-more-solo]');
      if (loadMoreButton) {
        loadMoreButton.addEventListener('click', () => {
          loadMoreButton.setAttribute('disabled', 'true');
          loadMoreButton.textContent = t('loadingMoreConversations');
          requestSoloConversationPage(Number(conversationPaging.page || 0) + 1);
        });
      }
      if (attachButton) {
        attachButton.addEventListener('click', () => {
          vscode.postMessage({ command: 'attachment.choose', nodeId: soloConversationId });
        });
      }
      if (sendButton) {
        sendButton.addEventListener('click', () => {
          const input = soloBody.querySelector('[data-solo-input]');
          const agentSelect = soloBody.querySelector('[data-solo-agent]');
          const modelSelect = soloBody.querySelector('[data-solo-model]');
          const request = input ? input.value.trim() : '';
          if (!request) return;
          vscode.postMessage({
            command: 'conversation.runSolo',
            projectPath: activeProjectPath,
            userMessage: request,
            agentCli: getSoloSelectValue(agentSelect),
            model: getSoloSelectValue(modelSelect),
            supplementFiles: nodeSupplementFiles[soloConversationId] || []
          });
          input.value = '';
          soloDraft = '';
          nodeSupplementFiles[soloConversationId] = [];
          renderSoloPanel(currentNodes);
        });
      }
      soloBody.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
        item.addEventListener('click', () => {
          const file = item.getAttribute('data-remove-supplement-file');
          nodeSupplementFiles[soloConversationId] = (nodeSupplementFiles[soloConversationId] || []).filter(candidate => candidate !== file);
          renderSoloPanel(currentNodes);
        });
      });
      const soloInput = soloBody.querySelector('[data-solo-input]');
      if (soloInput) {
        soloInput.addEventListener('input', () => {
          soloDraft = soloInput.value || '';
        });
      }
      bindPastedImageAttachments(soloInput, soloConversationId, () => renderSoloPanel(currentNodes));
      const soloAgentSelect = soloBody.querySelector('[data-solo-agent]');
      const soloModelSelect = soloBody.querySelector('[data-solo-model]');
      if (soloAgentSelect) {
        bindSoloSelect(soloAgentSelect, (value) => {
          soloAgentSelection = value || currentCliPath || 'agy';
          ensureAgentModelsLoaded(soloAgentSelection, soloConversationId);
          renderSoloPanel(currentNodes);
        });
      }
      if (soloModelSelect) {
        bindSoloSelect(soloModelSelect, (value) => {
          setTargetModelValue(soloConversationId, soloAgentSelection || currentCliPath || 'agy', value, true);
        });
      }
      bindSoloSelects(soloBody);
      bindConversationActions(soloBody, soloConversationId);
      restoreComposerInputState(soloBody, '[data-solo-input]', preservedInputState);
      soloPanelDirty = false;
    }

    function renderFlowPanel() {
      if (!flowPanel || !flowBody) {
        return;
      }
      flowPanel.classList.toggle('active', flowExpanded);
      if (!flowExpanded) {
        flowPanelDirty = true;
        return;
      }
      const flow = currentFlowState.flow || null;
      const hasProAccess = Boolean(currentFlowState.hasProAccess);
      const flowTargetId = 'flow';
      const supplementFiles = nodeSupplementFiles[flowTargetId] || [];
      if (!hasProAccess) {
        flowBody.innerHTML = \`
          <div class="conversation-panel">
            <div class="conversation-title">\${escapeHtml(t('flowTitle'))}</div>
            <div class="empty-state">\${escapeHtml(t('flowLocked'))}</div>
            <div class="conversation-compose conversation-compose-main" style="margin-top: 12px;">
              <button class="btn-send-conversation" data-open-flow-pro><span class="codicon codicon-lock"></span><span>\${escapeHtml(t('flowUpgrade'))}</span></button>
            </div>
          </div>
        \`;
        const upgradeButton = flowBody.querySelector('[data-open-flow-pro]');
        if (upgradeButton) {
          upgradeButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'entitlement.upgrade' });
          });
        }
        return;
      }
      const selectedAgentCli = flowAgentSelection || currentCliPath || 'agy';
      const latestLoops = Array.isArray(flow?.loops) ? flow.loops.slice().sort((a, b) => Number(a.index || 0) - Number(b.index || 0)) : [];
      
      // Helper function to render touched files in the panel
      function getEvidenceFilesHtml(loop) {
        if (!loop.evidence) return '';
        const touched = loop.evidence.touchedFilesSummary || '';
        const changed = loop.evidence.changedFilesSummary || '';
        const files = Array.from(new Set(
          [...touched.split('\\n'), ...changed.split('\\n')]
            .map(f => f.trim())
            .filter(f => f && !f.includes(':') && !f.startsWith('M ') && !f.startsWith('A ') && !f.startsWith('D '))
        ));
        if (files.length === 0) return '';
        return \`
          <div style="margin-top:6px; color: var(--text-muted);">
            <strong>📂 Touched Files:</strong>
            \${files.map(file => \`<span class="file-link" data-open-file-path="\${escapeHtml(file)}" style="color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; margin-right: 8px;">\${escapeHtml(file)}</span>\`).join('')}
          </div>
        \`;
      }

      flowBody.innerHTML = \`
        <div class="conversation-composer">
          <div class="conversation-compose conversation-compose-main">
            <button class="conversation-tool-btn" data-attach-flow title="\${escapeHtml(t('attachFiles'))}">
              <span class="codicon codicon-attach"></span>
            </button>
            <input type="text" class="conversation-input" data-flow-goal-input placeholder="\${escapeHtml(t('flowPlaceholder'))}">
            <button class="btn-send-conversation" data-send-flow title="\${escapeHtml(t('flowStart'))}">
              <span class="codicon codicon-send"></span>
            </button>
          </div>
          <div class="conversation-compose conversation-compose-meta">
            \${renderSoloSelect('flow-agent-select', 'data-flow-agent title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions({ agentCli: currentCliPath || 'agy' }), false, selectedAgentCli)}
            \${renderModelSelect('flow-model-select', 'data-flow-model title="Model"', selectedAgentCli, 'flow')}
          </div>
          \${renderSupplementFiles(flowTargetId, supplementFiles)}
        </div>
        <div class="conversation-panel">
          <div class="conversation-title">\${escapeHtml(t('flowHistory'))}</div>
          \${flow ? \`
            <div class="conversation-runtime">Flow: \${escapeHtml(flow.goal || '')}</div>
            <div class="conversation-runtime">Status: \${escapeHtml(flow.status || '')}</div>
            \${flow.latestSummary ? \`<div class="conversation-result">\${escapeHtml(flow.latestSummary)}</div>\` : ''}
            
            \${(flow.status === 'running') ? \`
              <div style="margin-top: 8px; margin-bottom: 8px; display: flex; gap: 8px;">
                <button class="conversation-control-btn" data-pause-flow="\${escapeHtml(flow.flowId)}" style="background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 4px 8px; font-size: 11px;">⏸ 暂停推进</button>
                <button class="conversation-control-btn stop" data-abandon-flow="\${escapeHtml(flow.flowId)}" style="padding: 4px 8px; font-size: 11px;">🚫 放弃 Flow</button>
              </div>
            \` : ''}

            <div class="conversation-output">\${latestLoops.map(loop => \`
              <div style="padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
                <div><strong>Loop \${escapeHtml(String(loop.index || ''))}</strong> · \${escapeHtml(loop.status || '')}</div>
                <div style="opacity:0.85; margin-top:4px;">\${escapeHtml(loop.goal || '')}</div>
                <div style="margin-top:6px; color: var(--text-muted);">
                  Planner: <span class="role-status \${escapeHtml(loop.planner?.status || 'pending')}" data-show-audit-role="planner" data-loop-index="\${loop.index}" style="cursor: pointer; text-decoration: underline;">\${escapeHtml(loop.planner?.status || 'pending')}</span> · 
                  Builder: <span class="role-status \${escapeHtml(loop.builder?.status || 'pending')}" data-show-audit-role="builder" data-loop-index="\${loop.index}" style="cursor: pointer; text-decoration: underline;">\${escapeHtml(loop.builder?.status || 'pending')}</span> · 
                  Verifier: <span class="role-status \${escapeHtml(loop.verifier?.status || 'pending')}" data-show-audit-role="verifier" data-loop-index="\${loop.index}" style="cursor: pointer; text-decoration: underline;">\${escapeHtml(loop.verifier?.status || 'pending')}</span>
                </div>
                
                <div id="audit-details-\${loop.index}" class="audit-details" style="display: none; margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.25); border-radius: 4px; border-left: 3px solid var(--vscode-focusBorder);">
                  <div style="font-weight: bold; font-size: 10px; margin-bottom: 4px; color: var(--vscode-textPreformat-foreground);">📋 执行轨迹审计 (<span id="audit-role-name-\${loop.index}"></span>)</div>
                  <pre id="audit-content-\${loop.index}" style="font-family: monospace; white-space: pre-wrap; margin: 0; font-size: 10px; max-height: 200px; overflow-y: auto; color: var(--vscode-editor-foreground);"></pre>
                </div>

                \${loop.summary ? \`<div style="margin-top:6px; color: var(--text-muted);">\${escapeHtml(loop.summary)}</div>\` : ''}
                \${getEvidenceFilesHtml(loop)}
                \${loop.scoring && Array.isArray(loop.scoring.reasons) && loop.scoring.reasons.length ? \`
                  <div style="margin-top:6px; color: var(--text-muted);">
                    <strong>🎯 H/I/J 评估:</strong> 
                    <span style="color: \${loop.scoring.hardEvidencePass ? '#388a34' : '#cf222e'}; font-weight: bold;">H:\${loop.scoring.hardEvidencePass?'Pass':'Fail'}</span> | 
                    <span style="color: \${loop.scoring.intentPass ? '#388a34' : '#cf222e'}; font-weight: bold;">I:\${loop.scoring.intentPass?'Pass':'Fail'}</span> | 
                    <span style="color: \${loop.scoring.judgmentPass ? '#388a34' : '#cf222e'}; font-weight: bold;">J:\${loop.scoring.judgmentPass?'Pass':'Fail'}</span>
                    <div style="font-size: 11px; margin-top: 2px;">\${escapeHtml(loop.scoring.reasons.join(' | '))}</div>
                  </div>
                \` : ''}
              </div>
            \`).join('')}</div>
            \${currentFlowState.history && currentFlowState.history.length > 1 ? \`<div class="conversation-result" style="margin-top:12px;">Recent flows: \${escapeHtml(currentFlowState.history.slice(1, 4).map(item => item.goal).join(' | '))}</div>\` : ''}
          \` : \`<div class="empty-state">\${escapeHtml(t('flowEmpty'))}</div>\`}
        </div>
      \`;
      const sendButton = flowBody.querySelector('[data-send-flow]');
      const attachButton = flowBody.querySelector('[data-attach-flow]');
      if (attachButton) {
        attachButton.addEventListener('click', () => {
          vscode.postMessage({ command: 'attachment.choose', nodeId: flowTargetId });
        });
      }
      if (sendButton) {
        sendButton.addEventListener('click', () => {
          const input = flowBody.querySelector('[data-flow-goal-input]');
          const agentSelect = flowBody.querySelector('[data-flow-agent]');
          const modelSelect = flowBody.querySelector('[data-flow-model]');
          const goal = input ? input.value.trim() : '';
          if (!goal) return;
          vscode.postMessage({
            command: 'flow.run',
            goal,
            agentCli: getSoloSelectValue(agentSelect),
            model: getSoloSelectValue(modelSelect),
            supplementFiles: nodeSupplementFiles[flowTargetId] || []
          });
          if (input) input.value = '';
          nodeSupplementFiles[flowTargetId] = [];
          renderFlowPanel();
        });
      }
      flowBody.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
        item.addEventListener('click', () => {
          const file = item.getAttribute('data-remove-supplement-file');
          nodeSupplementFiles[flowTargetId] = (nodeSupplementFiles[flowTargetId] || []).filter(candidate => candidate !== file);
          renderFlowPanel();
        });
      });
      const flowInput = flowBody.querySelector('[data-flow-goal-input]');
      bindPastedImageAttachments(flowInput, flowTargetId, () => renderFlowPanel());
      const flowAgentSelect = flowBody.querySelector('[data-flow-agent]');
      const flowModelSelect = flowBody.querySelector('[data-flow-model]');
      if (flowAgentSelect) {
        bindSoloSelect(flowAgentSelect, (value) => {
          flowAgentSelection = value || currentCliPath || 'agy';
          ensureAgentModelsLoaded(flowAgentSelection, 'flow');
          renderFlowPanel();
        });
      }
      if (flowModelSelect) {
        bindSoloSelect(flowModelSelect, (value) => {
          setTargetModelValue('flow', flowAgentSelection || currentCliPath || 'agy', value, true);
        });
      }

      // Bind pause and abandon action buttons
      const pauseBtn = flowBody.querySelector('[data-pause-flow]');
      if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
          const flowId = pauseBtn.getAttribute('data-pause-flow');
          vscode.postMessage({ command: 'flow.pause', flowId });
        });
      }
      const abandonBtn = flowBody.querySelector('[data-abandon-flow]');
      if (abandonBtn) {
        abandonBtn.addEventListener('click', () => {
          const flowId = abandonBtn.getAttribute('data-abandon-flow');
          vscode.postMessage({ command: 'flow.abandon', flowId });
        });
      }

      // Bind audit toggle buttons
      flowBody.querySelectorAll('[data-show-audit-role]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const role = item.getAttribute('data-show-audit-role');
          const loopIndex = Number(item.getAttribute('data-loop-index') || 0);
          const detailsDiv = flowBody.querySelector(\`#audit-details-\${loopIndex}\`);
          const contentPre = flowBody.querySelector(\`#audit-content-\${loopIndex}\`);
          const roleSpan = flowBody.querySelector(\`#audit-role-name-\${loopIndex}\`);
          if (!detailsDiv || !contentPre) return;
          
          const loop = latestLoops.find(l => l.index === loopIndex);
          const roleData = loop ? loop[role] : null;
          if (!roleData) return;
          
          if (detailsDiv.style.display === 'none') {
            detailsDiv.style.display = 'block';
            if (roleSpan) roleSpan.textContent = role.toUpperCase();
            contentPre.textContent = JSON.stringify({
              role: role,
              status: roleData.status,
              validationErrors: roleData.validationErrors || [],
              data: roleData.data || {}
            }, null, 2);
          } else {
            detailsDiv.style.display = 'none';
          }
        });
      });

      bindSoloSelects(flowBody);
      bindConversationActions(flowBody, 'flow');
      flowPanelDirty = false;
    }
    function renderRoadmapRevisionPanel(nodes) {
      if (!roadmapRevisionPanel || !roadmapRevisionBody) {
        return;
      }
      const preservedInputState = captureComposerInputState(roadmapRevisionBody, '[data-roadmap-revision-input]');
      if (preservedInputState) {
        roadmapRevisionDraft = preservedInputState.value;
      }
      const conversations = nodeConversations[roadmapRevisionId] || [];
      const disabled = '';
      roadmapRevisionPanel.classList.toggle('open', roadmapRevisionExpanded);
      btnToggleRoadmapRevision.classList.toggle('active', roadmapRevisionExpanded);
      if (!roadmapRevisionExpanded) {
        roadmapRevisionBody.innerHTML = '';
        return;
      }
      roadmapRevisionBody.innerHTML = \`
        <div class="conversation-composer">
          <div class="conversation-compose conversation-compose-main">
            <button class="conversation-tool-btn" data-attach-roadmap-revision title="\${escapeHtml(t('attachFiles'))}" \${disabled}>
              <span class="codicon codicon-attach"></span>
            </button>
            <input type="text" class="conversation-input" data-roadmap-revision-input placeholder="\${escapeHtml(t('reviseRoadmapPlaceholder'))}" value="\${escapeHtml(roadmapRevisionDraft)}" \${disabled}>
            <button class="btn-send-conversation" data-send-roadmap-revision title="\${escapeHtml(t('sendRevision'))}" \${disabled}>
              <span class="codicon codicon-send"></span>
            </button>
          </div>
          <div class="conversation-compose conversation-compose-meta">
            \${renderSoloSelect('conversation-agent-select', 'data-roadmap-revision-agent title="' + escapeHtml(t('agentSelector')) + '"', getAgentOptions({ agentCli: currentCliPath || 'agy' }), false, roadmapRevisionAgentSelection || currentCliPath || 'agy')}
            \${renderModelSelect('conversation-model-select', 'data-roadmap-revision-model title="Model"', roadmapRevisionAgentSelection || currentCliPath || 'agy', roadmapRevisionId)}
          </div>
          \${renderSupplementFiles(roadmapRevisionId, nodeSupplementFiles[roadmapRevisionId] || [])}
        </div>
        <div class="conversation-panel">
          <div class="conversation-title">\${escapeHtml(t('revisionHistory'))}</div>
          \${renderConversations(roadmapRevisionId, conversations, t('noRevisionConversations'))}
        </div>
      \`;
      const attachButton = roadmapRevisionBody.querySelector('[data-attach-roadmap-revision]');
      if (attachButton) {
        attachButton.addEventListener('click', () => {
          vscode.postMessage({ command: 'attachment.choose', nodeId: roadmapRevisionId });
        });
      }
      const sendButton = roadmapRevisionBody.querySelector('[data-send-roadmap-revision]');
      if (sendButton) {
        sendButton.addEventListener('click', () => {
          const input = roadmapRevisionBody.querySelector('[data-roadmap-revision-input]');
          const agentSelect = roadmapRevisionBody.querySelector('[data-roadmap-revision-agent]');
          const modelSelect = roadmapRevisionBody.querySelector('[data-roadmap-revision-model]');
          const request = input ? input.value.trim() : '';
          if (!request) return;
          vscode.postMessage({
            command: 'conversation.runRoadmapRevision',
            userMessage: request,
            agentCli: getSoloSelectValue(agentSelect),
            model: getSoloSelectValue(modelSelect),
            supplementFiles: nodeSupplementFiles[roadmapRevisionId] || []
          });
          input.value = '';
          roadmapRevisionDraft = '';
          nodeSupplementFiles[roadmapRevisionId] = [];
          renderRoadmapRevisionPanel(currentNodes);
        });
      }
      const revisionInput = roadmapRevisionBody.querySelector('[data-roadmap-revision-input]');
      if (revisionInput) {
        revisionInput.addEventListener('input', () => {
          roadmapRevisionDraft = revisionInput.value || '';
        });
      }
      bindPastedImageAttachments(revisionInput, roadmapRevisionId, () => renderRoadmapRevisionPanel(currentNodes));
      const revisionAgentSelect = roadmapRevisionBody.querySelector('[data-roadmap-revision-agent]');
      const revisionModelSelect = roadmapRevisionBody.querySelector('[data-roadmap-revision-model]');
      if (revisionAgentSelect) {
        bindSoloSelect(revisionAgentSelect, (value) => {
          roadmapRevisionAgentSelection = value || currentCliPath || 'agy';
          ensureAgentModelsLoaded(roadmapRevisionAgentSelection, roadmapRevisionId);
          renderRoadmapRevisionPanel(currentNodes);
        });
      }
      if (revisionModelSelect) {
        bindSoloSelect(revisionModelSelect, (value) => {
          setTargetModelValue(roadmapRevisionId, roadmapRevisionAgentSelection || currentCliPath || 'agy', value, true);
        });
      }
      roadmapRevisionBody.querySelectorAll('[data-remove-supplement-file]').forEach(item => {
        item.addEventListener('click', () => {
          const file = item.getAttribute('data-remove-supplement-file');
          nodeSupplementFiles[roadmapRevisionId] = (nodeSupplementFiles[roadmapRevisionId] || []).filter(candidate => candidate !== file);
          renderRoadmapRevisionPanel(currentNodes);
        });
      });
      bindSoloSelects(roadmapRevisionBody);
      bindConversationActions(roadmapRevisionBody, roadmapRevisionId);
      restoreComposerInputState(roadmapRevisionBody, '[data-roadmap-revision-input]', preservedInputState);
    }

    function bindConversationActions(container, nodeId) {
      container.querySelectorAll('[data-link-solo-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const closure = item.closest('[data-solo-closure-id]');
          const select = closure ? closure.querySelector('[data-solo-link-select]') : null;
          const targetNodeId = getSoloSelectValue(select);
          if (!targetNodeId) return;
          vscode.postMessage({
            command: 'conversation.linkToStep',
            conversationId: item.getAttribute('data-link-solo-id'),
            nodeId: targetNodeId
          });
        });
      });
      container.querySelectorAll('[data-open-revision-from-solo]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          setMainView('roadmap');
          roadmapRevisionExpanded = true;
          roadmapRevisionPanel.classList.add('open');
          btnToggleRoadmapRevision.classList.add('active');
          if (!nodeConversations[roadmapRevisionId]) {
            vscode.postMessage({ command: 'conversation.getHistory', nodeId: roadmapRevisionId });
          }
          renderRoadmapRevisionPanel(currentNodes);
        });
      });
      container.querySelectorAll('[data-conversation-id] .conversation-row').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const conversationItem = item.closest('[data-conversation-id]');
          const conversationId = conversationItem ? conversationItem.getAttribute('data-conversation-id') : '';
          activeConversationId = activeConversationId === conversationId
            ? ''
            : conversationId;
          renderRoadmap(currentNodes);
          if (nodeId === roadmapRevisionId) {
            renderRoadmapRevisionPanel(currentNodes);
          } else if (nodeId === soloConversationId) {
            renderSoloPanel(currentNodes);
          }
        });
      });
      container.querySelectorAll('.conversation-detail, .conversation-log-pre').forEach(item => {
        item.addEventListener('click', (event) => event.stopPropagation());
        item.addEventListener('mousedown', (event) => event.stopPropagation());
        item.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
        item.addEventListener('pointerdown', (event) => event.stopPropagation());
        item.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
      });
      container.querySelectorAll('[data-retry-conversation-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({
            command: 'conversation.retry',
            nodeId,
            conversationId: item.getAttribute('data-retry-conversation-id')
          });
        });
      });
      container.querySelectorAll('[data-show-agent-terminal]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({
            command: 'conversation.openTerminal',
            conversationId: item.getAttribute('data-show-agent-terminal')
          });
        });
      });
      container.querySelectorAll('[data-continue-native-conversation-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
            vscode.postMessage({
              command: 'conversation.continue',
              nodeId: item.getAttribute('data-continue-native-node-id') || nodeId,
              conversationId: item.getAttribute('data-continue-native-conversation-id')
            });
          });
      });
      container.querySelectorAll('[data-stop-agent-run]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({
            command: 'conversation.stop',
            nodeId,
            conversationId: item.getAttribute('data-stop-agent-run')
          });
        });
      });
      container.querySelectorAll('[data-open-file-path]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const relativePath = item.getAttribute('data-open-file-path');
          if (relativePath) {
            vscode.postMessage({
              command: 'project.openFile',
              relativePath,
              gitHash: item.getAttribute('data-open-file-hash') || ''
            });
          }
        });
      });
    }

    function renderConversationChildren(nodeId, conversation, children) {
      if (!children || children.length === 0) {
        return '';
      }
      return \`
        <div class="conversation-children">
          <div class="conversation-children-title">\${escapeHtml(t('followupRecords'))}</div>
          <div class="conversation-list conversation-list-children">
            \${children.map(child => renderConversationItem(nodeId, child, true)).join('')}
          </div>
        </div>
      \`;
    }

    function renderConversationItem(nodeId, conversation, nested = false) {
      const conversationId = nodeId + ':' + conversation.id;
      const children = (conversationChildrenMap[String(conversation.id || '')] || []);
      const continuationChildrenCount = children.filter(child => !isReviewConversation(child)).length;
      const reviewChildrenCount = children.filter(child => isReviewConversation(child)).length;
      const rootConversationId = conversation.continuationRootConversationId || findConversationRootId(conversation);
      const open = activeConversationId === conversationId || hasActiveConversationDescendant(nodeId, conversation);
      const when = conversation.timestamp ? new Date(conversation.timestamp).toLocaleString() : '';
      const summary = summarizeConversation(conversation);
      const duration = formatConversationDuration(conversation);
      const runtimeLabel = duration
        ? (conversation.status === 'Running' ? t('elapsed') : t('duration')) + ': ' + duration
        : '';
      const preGitHash = extractConversationPreGitHash(conversation);
      const rollbackButton = (preGitHash && conversation.status !== 'Running')
        ? \`<button class="conversation-control-btn rollback-btn" data-rollback-hash="\${escapeHtml(preGitHash)}" title="\${escapeHtml(t('rollbackChange'))}"><span class="codicon codicon-discard"></span> \${escapeHtml(t('rollbackChange'))}</button>\`
        : '';
      const retryButton = conversation.capabilities && conversation.capabilities.canRetry
        ? \`<button class="conversation-retry-btn" data-retry-conversation-id="\${escapeHtml(conversation.id)}">\${t('retry')}</button>\`
        : '';
      const continueButton = conversation.capabilities && conversation.capabilities.canContinue
        ? \`<button class="conversation-control-btn" data-continue-native-conversation-id="\${escapeHtml(rootConversationId)}" data-continue-native-node-id="\${escapeHtml(nodeId)}" title="\${escapeHtml(t('continueNative'))}">\${t('continueNative')}</button>\`
        : '';
      const runningButtons = conversation.capabilities && conversation.capabilities.canStop
        ? \`
          <button class="conversation-control-btn" data-show-agent-terminal="\${escapeHtml(conversation.id)}" title="\${escapeHtml(t('openTerminal'))}">\${t('openTerminal')}</button>
          <button class="conversation-control-btn stop" data-stop-agent-run="\${escapeHtml(conversation.id)}" title="\${escapeHtml(t('stopRun'))}">\${t('stopRun')}</button>
        \`
        : '';
      return \`
        <div class="conversation-item \${nested ? 'conversation-item-child' : ''}" data-conversation-id="\${escapeHtml(conversationId)}">
          <div class="conversation-row">
            <div class="conversation-meta">
              <span class="conversation-cli">\${escapeHtml(conversation.agentCli || '')}</span>
              <span class="conversation-summary">\${escapeHtml(summary)}</span>
              <span class="conversation-time">\${escapeHtml(when)}</span>
              \${runtimeLabel ? \`<span class="conversation-runtime" data-running-duration-node-id="\${escapeHtml(nodeId)}" data-running-duration-conversation-id="\${escapeHtml(conversation.id)}">\${escapeHtml(runtimeLabel)}</span>\` : ''}
              \${continuationChildrenCount > 0 ? \`<span class="conversation-runtime">\${escapeHtml(t('continuationCount'))} \${continuationChildrenCount}</span>\` : ''}
              \${reviewChildrenCount > 0 ? \`<span class="conversation-runtime">\${escapeHtml(t('reviewCount'))} \${reviewChildrenCount}</span>\` : ''}
            </div>
            <div class="conversation-actions">
              \${runningButtons}
              \${continueButton}
              \${retryButton}
              \${rollbackButton}
              <span class="status-badge \${statusClass(conversation.status)}">\${conversationStatusText(conversation.status)}</span>
            </div>
          </div>
          \${open ? \`
            <div class="conversation-detail-wrap">
              <div class="conversation-detail">
                \${renderConversationOutcome(conversation, nodeId)}
                \${renderConversationFiles(conversation)}
                \${nodeId === soloConversationId && conversation.status !== 'Running' ? renderSoloClosure(conversation) : ''}
                <strong>\${t('command')}</strong>
                <pre class="conversation-log-pre" data-log-scroll-key="\${escapeHtml(conversationId + ':command')}">\${escapeHtml(conversation.command)}</pre>
                <strong>\${t('output')}</strong>
                <pre class="conversation-log-pre" data-log-scroll-key="\${escapeHtml(conversationId + ':output')}">\${escapeHtml(conversation.output)}</pre>
              </div>
              \${renderConversationChildren(nodeId, conversation, children)}
            </div>
          \` : ''}
        </div>
      \`;
    }

    function renderConversations(nodeId, conversations, emptyLabel = t('noConversations')) {
      if (!conversations || conversations.length === 0) {
        return '<div class="conversation-empty">' + escapeHtml(emptyLabel) + '</div>';
      }
      conversationChildrenMap = {};
      const roots = [];
      const byId = {};
      const sessionRoots = {};
      conversations.forEach((conversation) => {
        byId[String(conversation.id || '')] = conversation;
      });
      function findRootByParent(conversation) {
        let current = conversation;
        const seen = {};
        while (current) {
          const currentId = String(current.id || '');
          if (!currentId || seen[currentId]) return current;
          seen[currentId] = true;
          const parentId = extractContinuationParentConversationId(current);
          const parent = parentId ? byId[String(parentId)] : null;
          if (!parent) return current;
          current = parent;
        }
        return conversation;
      }
      conversations.forEach((conversation) => {
        const sessionId = extractNativeSessionId(conversation);
        if (sessionId) {
          const parentId = extractContinuationParentConversationId(conversation);
          const candidateRoot = parentId && byId[String(parentId)]
            ? findRootByParent(conversation)
            : conversation;
          const currentRoot = sessionRoots[sessionId];
          const currentHasParent = currentRoot ? Boolean(extractContinuationParentConversationId(currentRoot)) : false;
          const candidateHasParent = Boolean(extractContinuationParentConversationId(candidateRoot));
          if (!currentRoot
            || (currentHasParent && !candidateHasParent)
            || (currentHasParent === candidateHasParent && Number(candidateRoot.id || 0) < Number(currentRoot.id || 0))) {
            sessionRoots[sessionId] = candidateRoot;
          }
        }
      });
      conversations.forEach((conversation) => {
        const reviewParentId = extractReviewParentConversationId(conversation);
        if (reviewParentId && byId[String(reviewParentId)]) {
          conversationChildrenMap[String(reviewParentId)] = conversationChildrenMap[String(reviewParentId)] || [];
          conversationChildrenMap[String(reviewParentId)].push(conversation);
          return;
        }
        const parentId = extractContinuationParentConversationId(conversation);
        if (parentId && byId[String(parentId)]) {
          const root = findRootByParent(conversation);
          const key = String(root.id || parentId);
          if (Number(root.id || 0) !== Number(conversation.id || 0)) {
            conversationChildrenMap[key] = conversationChildrenMap[key] || [];
            conversationChildrenMap[key].push(conversation);
            return;
          }
        }
        const sessionId = extractNativeSessionId(conversation);
        const sessionRoot = sessionId ? sessionRoots[sessionId] : null;
        if (sessionRoot && Number(sessionRoot.id || 0) !== Number(conversation.id || 0)) {
          const key = String(sessionRoot.id || '');
          conversationChildrenMap[key] = conversationChildrenMap[key] || [];
          conversationChildrenMap[key].push(conversation);
          return;
        }
        roots.push(conversation);
      });
      Object.keys(conversationChildrenMap).forEach((key) => {
        conversationChildrenMap[key].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
      });
      const items = roots.map(conversation => renderConversationItem(nodeId, conversation, false)).join('');
      return '<div class="conversation-list">' + items + '</div>';
    }

    function findConversationRootId(conversation) {
      const currentId = String(conversation && conversation.id || '');
      if (!currentId) return '';
      const rootId = Object.keys(conversationChildrenMap).find(key => {
        if (key === currentId) return true;
        return (conversationChildrenMap[key] || []).some(child => String(child.id || '') === currentId);
      });
      return rootId || currentId;
    }

    function hasActiveConversationDescendant(nodeId, conversation) {
      const children = conversationChildrenMap[String(conversation.id || '')] || [];
      return children.some(child => {
        const childId = nodeId + ':' + child.id;
        return activeConversationId === childId || hasActiveConversationDescendant(nodeId, child);
      });
    }

    function captureConversationLogScrollPositions() {
      document.querySelectorAll('.conversation-log-pre[data-log-scroll-key]').forEach(item => {
        const key = item.getAttribute('data-log-scroll-key') || '';
        if (key) {
          conversationLogScrollPositions[key] = {
            top: item.scrollTop || 0,
            left: item.scrollLeft || 0
          };
        }
      });
    }

    function restoreConversationLogScrollPositions() {
      const restore = () => {
        document.querySelectorAll('.conversation-log-pre[data-log-scroll-key]').forEach(item => {
          const key = item.getAttribute('data-log-scroll-key') || '';
          const position = key ? conversationLogScrollPositions[key] : null;
          if (position) {
            item.scrollTop = position.top || 0;
            item.scrollLeft = position.left || 0;
          }
        });
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(restore);
      } else {
        setTimeout(restore, 0);
      }
    }

    function formatDurationMs(durationMs) {
      return SoloMapWebview.formatDurationMs(durationMs, { rounding: 'floor', includeHours: true });
    }

    function formatConversationDuration(conversation) {
      if (Number.isFinite(conversation && conversation.durationMs)) {
        return formatDurationMs(Number(conversation.durationMs));
      }
      if (conversation.status !== 'Running' || !conversation.timestamp) {
        return '';
      }
      return formatDurationMs(Date.now() - new Date(conversation.timestamp).getTime());
    }

    function updateRunningConversationDurations(container, conversationsByNode) {
      if (!container || !container.querySelectorAll) return;
      container.querySelectorAll('[data-running-duration-node-id][data-running-duration-conversation-id]').forEach(element => {
        const nodeId = element.getAttribute('data-running-duration-node-id') || '';
        const conversationId = element.getAttribute('data-running-duration-conversation-id') || '';
        const conversation = (conversationsByNode[nodeId] || [])
          .find(candidate => String(candidate.id || '') === conversationId);
        if (!conversation || conversation.status !== 'Running') return;
        const duration = formatConversationDuration(conversation);
        element.textContent = duration ? t('elapsed') + ': ' + duration : '';
      });
    }

    function renderConversationOutcome(conversation, nodeId = '') {
      const failureCategory = String(conversation.failureCategory || '');
      const failureReason = String(conversation.failureReason || '');
      const files = extractConversationFiles(conversation);
      let result = '';
      if (conversation.status === 'Running') {
        result = t('stillWorking');
      } else if (conversation.status === 'Recorded') {
        result = t('continuationRecorded');
      } else if (conversation.status === 'Failed') {
        result = failureCategoryText(failureCategory.trim()) || failureReason.trim() || statusText(conversation.status);
      } else if (conversation.status === 'Linked') {
        result = t('linkedFromSolo');
      } else if (conversation.status === 'Completed' && nodeId === soloConversationId) {
        result = t('soloCompleted');
      } else if (conversation.status === 'Completed') {
        result = t('stepCompleted');
      } else {
        result = t('awaitingNextConversation');
      }
      if (files.length > 0 && conversation.status !== 'Running') {
        result += ' ' + t('changedCount') + ': ' + files.length + '.';
      }
      const label = conversation.status === 'Failed' ? t('failureLabel') : t('runResult');
      const conclusion = conversation.status === 'Running' ? '' : extractAgentConclusion(conversation);
      return \`
        <div class="conversation-outcome \${conversation.status === 'Failed' ? 'failed' : ''}">
          <div><strong>\${escapeHtml(label)}:</strong> \${escapeHtml(result)}</div>
          \${conclusion ? \`<div><strong>\${escapeHtml(t('agentConclusion'))}:</strong> \${escapeHtml(conclusion)}</div>\` : ''}
        </div>
      \`;
    }

    function extractAgentConclusion(conversation) {
      return String(conversation && conversation.conclusion || '');
    }

    function getAgentOptions(node) {
      return SoloMapWebview.getAgentOptions(currentCliPath || 'agy', node.agentCli || currentCliPath || 'agy');
    }

    function mergeSupplementFiles(existing, incoming) {
      const seen = new Set();
      return [...(existing || []), ...(incoming || [])]
        .map(file => String(file || '').trim())
        .filter(Boolean)
        .filter(file => {
          if (seen.has(file)) return false;
          seen.add(file);
          return true;
        })
        .slice(0, 10);
    }

    function bindPastedImageAttachments(input, nodeId, afterPaste) {
      SoloMapWebview.bindPastedImageAttachments(
        input,
        message => vscode.postMessage(message),
        attachments => ({
          command: 'attachment.save',
          nodeId,
          attachments
        }),
        state => {
          if (!pendingPastedAttachments[nodeId]) pendingPastedAttachments[nodeId] = new Set();
          if (state.phase === 'started') {
            pendingPastedAttachments[nodeId].add(state.requestId);
          } else {
            pendingPastedAttachments[nodeId].delete(state.requestId);
          }
          if (afterPaste) afterPaste();
        }
      );
    }

    function renderSupplementFiles(nodeId, files) {
      const pending = pendingPastedAttachments[nodeId] && pendingPastedAttachments[nodeId].size > 0;
      if ((!files || files.length === 0) && !pending) {
        return '';
      }
      return \`
        <div class="conversation-attachments" aria-label="\${escapeHtml(t('attachedFiles'))}">
          \${(files || []).map(file => \`
            <span class="conversation-attachment-chip" title="\${escapeHtml(file)}">
              <span>\${escapeHtml(file)}</span>
              <button
                class="conversation-attachment-remove"
                data-remove-supplement-file="\${escapeHtml(file)}"
                title="\${escapeHtml(t('removeAttachment'))}"
              >
                <span class="codicon codicon-close"></span>
              </button>
            </span>
          \`).join('')}
          \${pending ? \`<span class="conversation-attachment-chip"><span class="codicon codicon-loading loading-spin"></span><span>\${escapeHtml(t('addingScreenshot'))}</span></span>\` : ''}
        </div>
      \`;
    }

    function summarizeConversation(conversation) {
      return String(conversation && conversation.summary || '') || statusText(conversation.status);
    }

    function extractConversationFiles(conversation) {
      return Array.isArray(conversation && conversation.changedFiles) ? conversation.changedFiles : [];
    }

    function extractConversationPreGitHash(conversation) {
      const directHash = String(conversation && conversation.rollbackGitHash || '');
      if (directHash) return directHash;
      const match = String(conversation && conversation.output || '').match(/SoloMapPreGitHash:\s*([a-f0-9]+)/i);
      return match ? match[1] : '';
    }

    function renderConversationFiles(conversation) {
      const files = extractConversationFiles(conversation);
      if (!files.length) {
        return '';
      }
      const preGitHash = extractConversationPreGitHash(conversation);
      return \`
        <strong>\${escapeHtml(t('changedFiles'))}</strong>
        <div class="conversation-files">
          \${files.map(file => \`
            <button
              class="conversation-file-link"
              data-open-file-path="\${escapeHtml(file.path)}"
              data-open-file-hash="\${escapeHtml(preGitHash)}"
              title="\${escapeHtml(file.path)}"
            >
              <span>\${escapeHtml(file.label)}</span>
              <span>\${escapeHtml(t('openFile'))}</span>
            </button>
          \`).join('')}
        </div>
      \`;
    }

    function toggleNode(nodeId) {
      expandedNodeId = expandedNodeId === nodeId ? '' : nodeId;
      activeConversationId = '';
      if (expandedNodeId && !nodeConversations[nodeId]) {
        vscode.postMessage({ command: 'conversation.getHistory', nodeId });
      }
      if (expandedNodeId) {
        const node = (currentNodes || []).find(candidate => candidate.id === nodeId);
        ensureAgentModelsLoaded(nodeAgentSelections[nodeId] || node?.agentCli || currentCliPath || 'agy', nodeId);
      }
      renderRoadmap(currentNodes);
    }

    function cssEscape(value) {
      if (window.CSS && window.CSS.escape) {
        return window.CSS.escape(value);
      }
      return String(value).replace(/"/g, '\\"');
    }

    function triggerRun(nodeId, userMessage, agentCli, model, supplementFiles) {
      vscode.postMessage({
        command: 'conversation.runStep',
        nodeId: nodeId,
        userMessage: userMessage || '',
        agentCli: agentCli || '',
        model: model || '',
        supplementFiles: supplementFiles || []
      });
    }
  </script>
</body>
</html>`;
  roadmapHtmlCache.set(cacheKey, html);
  return html;
}
