import { isRuntimeDataTransportError } from './autonomousRuntimeControl';
import type { StorageReclamationOverview } from './db/contentLifecycleGc';

export interface DatabaseOverview {
  databaseBytes: number;
  freePageBytes: number;
  contents: { records: number | null; exact?: boolean };
  lastMaintenance: { finishedAt: number | string | null; status: string } | null;
  reclamation?: StorageReclamationOverview;
}

export interface DatabaseOverviewDependencies {
  ensureReady(root: string): Promise<void>;
  readStorage(root: string): Promise<DatabaseOverview>;
}

export async function readDatabaseOverview(root: string, dependencies: DatabaseOverviewDependencies): Promise<DatabaseOverview> {
  for (let attempt = 0; ; attempt++) {
    try {
      await dependencies.ensureReady(root);
      return await dependencies.readStorage(root);
    } catch (error) {
      if (attempt > 0 || !isRuntimeDataTransportError(error)) throw error;
    }
  }
}

export function formatDatabaseOverview(overview: DatabaseOverview, language: string): {
  databaseSize: string; contentCount: string; reusableSpace: string; status: string;
  reclamation?: { status: string; deletedContents: string; reclaimedBytes: string };
} {
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  const bytes = (value: number): string => {
    const amount = Math.max(0, Number(value) || 0);
    const units = [['TB', 1024 ** 4], ['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]] as const;
    const unit = units.find(([, size]) => amount >= size);
    if (!unit) return `${Math.round(amount).toLocaleString(locale)} B`;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(amount / unit[1])} ${unit[0]}`;
  };
  const finishedAt = overview.lastMaintenance?.finishedAt;
  const maintenanceDate = finishedAt === null || finishedAt === undefined || finishedAt === ''
    ? ''
    : new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(finishedAt));
  const maintenanceStatus = String(overview.lastMaintenance?.status || '');
  const status = maintenanceStatus === 'running'
    ? (language === 'zh' ? '维护中 · 当前数据可正常使用' : 'Maintenance in progress · Data remains available')
    : maintenanceStatus && maintenanceStatus !== 'completed'
      ? (language === 'zh' ? '可正常使用 · 上次维护未完成' : 'Available · Last maintenance incomplete')
      : maintenanceDate
      ? (language === 'zh' ? `运行正常 · 最近维护 ${maintenanceDate}` : `Healthy · Last maintained ${maintenanceDate}`)
      : (language === 'zh' ? '运行正常' : 'Healthy');
  const reclamationLabels = {
    disabled: ['尚未开启', 'Off'],
    paused: ['暂缓回收', 'Temporarily paused'],
    checkingHistory: ['正在校验历史引用', 'Checking historical references'],
    checkingReferences: ['等待引用校验', 'Waiting for reference checks'],
    pending: ['等待后台回收', 'Reclamation pending'],
    idle: ['已开启 · 暂无待回收', 'On · Nothing to reclaim']
  };
  const reclamation = overview.reclamation;
  return {
    databaseSize: bytes(overview.databaseBytes),
    contentCount: overview.contents?.records === null || overview.contents?.exact === false
      ? (language === 'zh' ? '计算中…' : 'Calculating…')
      : Math.max(0, Number(overview.contents?.records) || 0).toLocaleString(locale),
    reusableSpace: bytes(overview.freePageBytes),
    status,
    ...(reclamation && {
      reclamation: {
        status: reclamationLabels[reclamation.status]?.[language === 'zh' ? 0 : 1]
          || (language === 'zh' ? '状态暂不可用' : 'Status unavailable'),
        deletedContents: reclamation.deletedContents.toLocaleString(locale),
        reclaimedBytes: bytes(reclamation.reclaimedStoredBytes)
      }
    })
  };
}

export function getDatabaseOverviewCardHtml(): string {
  return `<section class="settings-card database-overview-card" id="database-overview-card" data-database-overview-card aria-labelledby="database-overview-title" aria-busy="false">
    <style>
      #database-overview-card { color: var(--text-main, #e2e8f0); gap: 12px; padding: 14px; overflow: hidden; flex-shrink: 0; }
      #database-overview-card .database-overview-heading { display: flex; align-items: flex-start; gap: 10px; }
      #database-overview-card .database-overview-icon { display: grid; flex: 0 0 32px; width: 32px; height: 32px; place-items: center; border-radius: 9px; color: #67e8f9; background: rgba(34, 211, 238, .11); border: 1px solid rgba(103, 232, 249, .2); }
      #database-overview-card .database-overview-copy { min-width: 0; flex: 1; }
      #database-overview-card .database-overview-title { font-size: 13px; font-weight: 750; line-height: 1.35; }
      #database-overview-card .database-overview-intro { margin: 4px 0 0; color: var(--text-muted, #94a3b8); font-size: 11px; line-height: 1.5; }
      #database-overview-card .database-overview-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
      #database-overview-card .database-overview-metric { min-width: 0; min-height: 53px; padding: 8px; border-radius: 7px; background: rgba(255, 255, 255, .035); }
      #database-overview-card .database-overview-metric strong { display: block; min-height: 18px; font-size: 15px; font-variant-numeric: tabular-nums; line-height: 1.2; overflow-wrap: anywhere; }
      #database-overview-card .database-overview-metric span { display: block; margin-top: 3px; color: var(--text-muted, #94a3b8); font-size: 11px; line-height: 1.35; }
      #database-overview-card .database-reclamation { border-top: 1px solid var(--vscode-widget-border, rgba(148, 163, 184, .2)); padding-top: 10px; }
      #database-overview-card .database-reclamation-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 10px; font-size: 12px; line-height: 1.45; }
      #database-overview-card .database-reclamation-status { color: var(--text-muted, #94a3b8); overflow-wrap: anywhere; }
      #database-overview-card .database-reclamation-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-top: 8px; }
      #database-overview-card .database-overview-footer { display: flex; align-items: center; gap: 10px; min-height: 32px; }
      #database-overview-card .database-overview-status { min-width: 0; flex: 1; color: var(--text-muted, #94a3b8); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
      #database-overview-card .database-overview-status.is-error { color: #fecaca; }
      #database-overview-card .database-overview-refresh { flex: 0 0 auto; min-height: 32px; color: var(--text-muted, #94a3b8); background: transparent; border-color: transparent; cursor: pointer; }
      #database-overview-card .database-overview-refresh:disabled { cursor: default; opacity: .5; }
      #database-overview-card .database-overview-refresh:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    </style>
    <div class="database-overview-heading">
      <span class="database-overview-icon codicon codicon-database" aria-hidden="true"></span>
      <div class="database-overview-copy">
        <div class="database-overview-title" id="database-overview-title">数据库概览</div>
        <p class="database-overview-intro" data-database-overview-intro>查看 SoloMap 当前保存的数据规模。</p>
      </div>
    </div>
    <div class="database-overview-metrics">
      <div class="database-overview-metric"><strong data-database-size>—</strong><span data-database-size-label>数据库占用</span></div>
      <div class="database-overview-metric"><strong data-database-records>—</strong><span data-database-records-label>内容条目</span></div>
      <div class="database-overview-metric"><strong data-database-reusable>—</strong><span data-database-reusable-label>可复用空间</span></div>
    </div>
    <div class="database-reclamation">
      <div class="database-reclamation-heading">
        <strong data-database-reclamation-label>自动回收</strong>
        <span class="database-reclamation-status" data-database-reclamation-status>—</span>
      </div>
      <p class="database-overview-intro" data-database-reclamation-intro>后台清理无引用内容，腾出的空间可在库内复用。</p>
      <div class="database-reclamation-metrics">
        <div class="database-overview-metric"><strong data-database-reclamation-records>—</strong><span data-database-reclamation-records-label>已回收条目</span></div>
        <div class="database-overview-metric"><strong data-database-reclamation-bytes>—</strong><span data-database-reclamation-bytes-label>累计回收内容</span></div>
      </div>
    </div>
    <div class="database-overview-footer">
      <div class="database-overview-status" data-database-overview-status role="status" aria-live="polite">打开设置后自动更新</div>
      <button type="button" class="settings-action-btn test-btn database-overview-refresh" data-database-overview-refresh>刷新</button>
    </div>
  </section>`;
}

function bindDatabaseOverviewSettings(vscode: { postMessage(message: unknown): void }, language: () => string): void {
  const card = document.getElementById('database-overview-card');
  const panel = document.getElementById('settings-panel');
  if (!card || !panel) return;
  const element = (selector: string) => card.querySelector(selector) as HTMLElement;
  const text = (zh: string, en: string) => language() === 'zh' ? zh : en;
  const refresh = element('[data-database-overview-refresh]') as HTMLButtonElement;
  let current: DatabaseOverview | undefined;
  let savedLocation: string | undefined;
  let sequence = 0;
  let latest = '';
  let busy = false;
  const visible = () => panel.style.display === 'block' || panel.style.display === 'flex';
  function render(error = ''): void {
    element('#database-overview-title').textContent = text('数据库概览', 'Database overview');
    element('[data-database-overview-intro]').textContent = text('查看 SoloMap 当前保存的数据规模。', 'See how much data SoloMap currently stores.');
    element('[data-database-size-label]').textContent = text('数据库占用', 'Database size');
    element('[data-database-records-label]').textContent = text('内容条目', 'Content records');
    element('[data-database-reusable-label]').textContent = text('可复用空间', 'Reusable space');
    element('[data-database-reclamation-label]').textContent = text('自动回收', 'Automatic reclamation');
    element('[data-database-reclamation-intro]').textContent = text('后台清理无引用内容，腾出的空间可在库内复用。', 'Unused content is cleared in the background so the database can reuse the space.');
    element('[data-database-reclamation-records-label]').textContent = text('已回收条目', 'Records reclaimed');
    element('[data-database-reclamation-bytes-label]').textContent = text('累计回收内容', 'Content reclaimed');
    refresh.textContent = busy ? text('读取中…', 'Loading…') : text('刷新', 'Refresh');
    refresh.disabled = busy;
    const values = current && formatDatabaseOverview(current, language());
    const reclamation = values?.reclamation;
    element('[data-database-reclamation-status]').textContent = reclamation?.status || (values ? text('状态暂不可用', 'Status unavailable') : '—');
    element('[data-database-reclamation-records]').textContent = reclamation?.deletedContents || '—';
    element('[data-database-reclamation-bytes]').textContent = reclamation?.reclaimedBytes || '—';
    element('[data-database-size]').textContent = values?.databaseSize || '—';
    element('[data-database-records]').textContent = values?.contentCount || '—';
    element('[data-database-reusable]').textContent = values?.reusableSpace || '—';
    if (values) {
      element('[data-database-overview-status]').textContent = error || (busy ? text('正在更新，现有数据仍可查看', 'Updating; current values remain available') : values.status);
    } else {
      element('[data-database-overview-status]').textContent = error || (busy ? text('正在读取数据库概览…', 'Loading database overview…') : text('打开设置后自动更新', 'Updates when Settings opens'));
    }
    element('[data-database-overview-status]').classList.toggle('is-error', Boolean(error));
    card!.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  function request(): void {
    if (busy || !visible()) return;
    latest = 'database-overview-' + (++sequence);
    busy = true;
    render();
    vscode.postMessage({ command: 'databaseOverview.get', requestId: latest, dataRoot: savedLocation || '' });
  }
  refresh.addEventListener('click', request);
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.command === 'settingsLoaded' || message?.command === 'settingsSaved') {
      const location = String(message.settings?.globalDataPath || '');
      if (savedLocation !== undefined && location !== savedLocation) {
        current = undefined;
        latest = '';
        busy = false;
      }
      savedLocation = location;
      render();
      if (!current && visible()) request();
      return;
    }
    if (message?.command !== 'databaseOverviewLoaded' || message.requestId !== latest) return;
    busy = false;
    if (message.overview) current = message.overview;
    render(String(message.error || ''));
  });
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (visible()) request();
  }) : undefined;
  observer?.observe(panel, { attributes: true, attributeFilter: ['style'] });
  window.addEventListener('unload', () => observer?.disconnect());
  render();
}

export function getDatabaseOverviewScript(): string {
  return `const formatDatabaseOverview = ${formatDatabaseOverview.toString()};\n(${bindDatabaseOverviewSettings.toString()})(vscode, () => currentLanguage);`;
}
