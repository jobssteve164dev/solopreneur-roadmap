export function getMigrationSettingsCardHtml(): string {
  return `<section class="settings-card" id="migration-settings-card" aria-labelledby="migration-card-title" hidden>
    <style>
      #migration-settings-card { color: var(--text-main, #e2e8f0); }
      #migration-settings-card .migration-detail { font-size: 12px; line-height: 1.5; margin: 8px 0; overflow-wrap: anywhere; }
      #migration-settings-card .migration-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      #migration-settings-card button { min-height: 28px; cursor: pointer; }
      #migration-settings-card button:disabled { cursor: default; opacity: .5; }
      #migration-settings-card button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
      #migration-settings-card .migration-files { margin: 8px 0; padding-left: 20px; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
      #migration-settings-card .migration-history { margin-top: 12px; }
      #migration-settings-card .migration-error { color: inherit; border-left: 2px solid currentColor; padding-left: 8px; }
      #migration-settings-card progress { width: 100%; accent-color: var(--vscode-progressBar-background); }
    </style>
    <div class="settings-card-title"><span class="codicon codicon-database" aria-hidden="true"></span><span id="migration-card-title">数据迁移与回收</span></div>
    <div class="migration-detail" data-migration-status role="status" aria-live="polite">打开设置后查看进度。</div>
    <progress data-migration-progress aria-label="迁移进度" hidden></progress>
    <div class="migration-detail" data-migration-summary></div>
    <div data-migration-jobs></div>
    <div class="migration-detail migration-error" data-migration-error role="alert" hidden></div>
    <div class="migration-actions">
      <button type="button" class="settings-action-btn test-btn" data-migration-refresh>刷新进度</button>
      <button type="button" class="settings-action-btn test-btn" data-migration-agent>交给 Agent 检查</button>
      <button type="button" class="settings-action-btn test-btn" data-migration-preview disabled>查看可回收文件</button>
    </div>
    <div data-migration-plan hidden>
      <p class="migration-detail" data-migration-plan-copy></p>
      <ul class="migration-files" data-migration-files></ul>
      <div class="migration-actions">
        <button type="button" class="settings-action-btn test-btn" data-migration-confirm>确认回收</button>
        <button type="button" class="settings-action-btn test-btn" data-migration-cancel>取消</button>
      </div>
    </div>
    <div class="migration-history" data-migration-history></div>
  </section>`;
}

function bindMigrationSettings(vscode: { postMessage(message: unknown): void }, language: () => string): void {
  const card = document.getElementById('migration-settings-card');
  const panel = document.getElementById('settings-panel');
  if (!card || !panel) return;
  const element = (selector: string) => card.querySelector(selector) as HTMLElement;
  const text = (zh: string, en: string) => language() === 'zh' ? zh : en;
  const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
  let overview: any;
  let plan: any;
  let dataRoot = '';
  let savedLocation: string | undefined;
  let sequence = 0;
  let latest = '';
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => panel.style.display === 'block' || panel.style.display === 'flex';
  const button = (selector: string) => element(selector) as HTMLButtonElement;
  const error = element('[data-migration-error]');
  function request(command: string, input: Record<string, unknown> = {}): void {
    if (busy) return;
    if (timer) clearTimeout(timer);
    latest = 'migration-' + (++sequence);
    busy = command !== 'dataMigration.get';
    error.hidden = true;
    card!.setAttribute('aria-busy', 'true');
    card!.querySelectorAll('button').forEach(control => { control.disabled = true; });
    element('[data-migration-status]').textContent = text(busy ? '正在处理…' : '正在读取进度…', busy ? 'Working…' : 'Loading progress…');
    vscode.postMessage({ command, requestId: latest, dataRoot, ...input });
  }
  function render(): void {
    element('#migration-card-title').textContent = text('数据迁移与回收', 'Data migration & recycling');
    button('[data-migration-refresh]').textContent = text('刷新进度', 'Refresh progress');
    button('[data-migration-agent]').textContent = text('交给 Agent 检查', 'Ask Agent to check');
    button('[data-migration-preview]').textContent = text('查看可回收文件', 'Review recyclable files');
    button('[data-migration-confirm]').textContent = text('确认回收', 'Confirm recycling');
    button('[data-migration-cancel]').textContent = text('取消', 'Cancel');
    const jobs = overview?.jobs || [];
    const maintenanceTasks = overview?.maintenanceTasks || [];
    const busyMaintenanceTaskIds = new Set([...(overview?.activeMaintenanceTaskIds || []), ...(overview?.launchingMaintenanceTaskIds || [])]);
    const isActiveMaintenance = (task: any) => ['ready', 'running'].includes(task.status) && Number(task.validUntil || 0) > Date.now();
    const activeMaintenance = maintenanceTasks.some(isActiveMaintenance);
    const maintenanceAgentBusy = maintenanceTasks.some((task: any) => isActiveMaintenance(task) && busyMaintenanceTaskIds.has(task.taskId));
    const reviewAgentActive = maintenanceTasks.some((task: any) => isActiveMaintenance(task) && task.kind === 'migration_review' && busyMaintenanceTaskIds.has(task.taskId));
    const activeRecyclingPlans = new Set(maintenanceTasks.filter((task: any) => isActiveMaintenance(task) && task.kind === 'recycling_apply' && busyMaintenanceTaskIds.has(task.taskId)).map((task: any) => task.targetId));
    const failedMaintenance = maintenanceTasks.some((task: any) => task.status === 'failed');
    const active = jobs.some((job: any) => ['queued', 'running', 'interrupted'].includes(job.status)) || activeMaintenance;
    const needsAttention = jobs.filter((job: any) => ['failed', 'completed_with_conflicts'].includes(job.status));
    const history = overview?.recycling || [];
    card!.hidden = !plan && !active && !failedMaintenance && !needsAttention.length && !Number(overview?.reviewableFiles || overview?.recyclableFiles || 0) && !history.length;
    const migrated = Number(overview?.migratedFiles || 0);
    const count = Number(overview?.capturedFiles || 0);
    element('[data-migration-status]').textContent = !overview ? text('尚未读取进度', 'Progress not loaded')
      : maintenanceAgentBusy ? text('Agent 正在后台处理，可继续使用 SoloMap。', 'Agent is working in the background. You can keep using SoloMap.')
      : activeMaintenance ? text('上次 Agent 已中断，可从这里继续。', 'The previous Agent stopped. You can continue here.')
      : active ? text('正在后台迁移，可继续使用 SoloMap。', 'Migrating in the background. You can keep using SoloMap.')
      : failedMaintenance ? text('Agent 处理未完成，可再次交给 Agent 检查。', 'Agent did not finish. You can ask Agent to check again.')
      : needsAttention.length ? text('部分旧文件需要查看，已迁移的数据可正常使用。', 'Some old files need attention. Migrated data is ready to use.')
      : jobs.length ? text('本次迁移已完成', 'Migration complete') : text('暂无待迁移数据', 'No migration pending');
    const progress = element('[data-migration-progress]') as HTMLProgressElement;
    progress.hidden = !active;
    progress.removeAttribute('value');
    progress.setAttribute('aria-label', text('后台迁移进行中', 'Background migration in progress'));
    element('[data-migration-summary]').textContent = overview ? text(
      '已保存 ' + count + ' 个旧文件 · 已迁移 ' + migrated + ' 项 · 待检查 ' + Number(overview.reviewableFiles || 0) + ' 个文件',
      count + ' old files saved · ' + migrated + ' items migrated · ' + Number(overview.reviewableFiles || 0) + ' files ready to review') : '';
    element('[data-migration-jobs]').innerHTML = jobs.map((job: any) => {
      const name = ({
        intelligence: text('聊天记录', 'Chat history'),
        'project-growth': text('项目生长图', 'Project growth'),
        'project-journal': text('项目日志', 'Project journal'),
        'agent-runs': text('Agent 运行记录', 'Agent runs')
      } as Record<string, string>)[job.args.collection] || text('长期记忆', 'Long-term memory');
      const errors = Array.isArray(job.progress.conflicts) ? job.progress.conflicts : [];
      return '<div class="migration-detail">' + name + ' · ' + escape(text(({ queued: '等待迁移', running: '迁移中', interrupted: '等待继续', completed: '已完成', completed_with_conflicts: '需要查看', failed: '迁移未完成' } as any)[job.status] || '', ({ queued: 'Queued', running: 'Migrating', interrupted: 'Waiting to resume', completed: 'Complete', completed_with_conflicts: 'Needs attention', failed: 'Incomplete' } as any)[job.status] || ''))
        + (['failed', 'completed_with_conflicts', 'interrupted'].includes(job.status) ? ' <button type="button" class="settings-action-btn test-btn" data-migration-retry="' + escape(job.jobId) + '">' + text('重试迁移', 'Retry migration') + '</button>' : '')
        + (errors.length || job.error ? '<details><summary>' + text('查看未迁移的文件', 'Review pending files') + '</summary><ul class="migration-files">' + errors.map((value: any) => '<li>' + escape(value.source) + '</li>').join('') + (job.error ? '<li>' + text('读取未完成，可重试迁移。', 'Reading did not finish. Retry migration.') + '</li>' : '') + '</ul></details>' : '') + '</div>';
    }).join('');
    element('[data-migration-plan]').hidden = !plan;
    if (plan) {
      element('[data-migration-plan-copy]').textContent = plan.files.length
        ? text('以下文件已完整保存。确认后回收，可在此恢复。', 'These files are fully saved. Confirm to recycle them; you can restore them here.')
        : text('暂无可回收文件，仍在使用或已变化的文件会保留。', 'No files are ready to recycle. Files in use or changed are kept.');
      element('[data-migration-files]').innerHTML = plan.files.map((file: any) => '<li>' + escape(file.path) + '</li>').join('');
    }
    element('[data-migration-history]').innerHTML = history.map((item: any) => '<div class="migration-detail">' + escape(item.path) + ' · ' + (item.status === 'trashed' ? text('已回收', 'Recycled') : text('已保留，等待处理', 'Kept, awaiting action'))
      + (item.status !== 'approved' ? ' <button type="button" class="settings-action-btn test-btn" data-migration-restore="' + escape(item.itemId) + '">' + text('恢复文件', 'Restore file') + '</button>' : '')
      + (['approved', 'moving', 'held'].includes(item.status) ? ' <button type="button" class="settings-action-btn test-btn" data-migration-retry-recycling="' + escape(item.planId) + '"' + (activeRecyclingPlans.has(item.planId) ? ' disabled' : '') + '>' + text('交给 Agent 继续', 'Ask Agent to continue') + '</button>' : '') + '</div>').join('');
    card!.querySelectorAll('button').forEach(control => { control.disabled = busy; });
    button('[data-migration-preview]').disabled = busy || !Number(overview?.reviewableFiles || overview?.recyclableFiles || 0);
    button('[data-migration-agent]').disabled = busy || reviewAgentActive;
    button('[data-migration-confirm]').disabled = busy || !plan?.files.length;
    card!.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (timer) clearTimeout(timer);
    if (active && visible() && !busy && !plan) timer = setTimeout(() => request('dataMigration.get'), 2000);
  }
  card.addEventListener('click', event => {
    const target = (event.target as HTMLElement)?.closest('button');
    if (!target || target.disabled || busy) return;
    if (target.hasAttribute('data-migration-cancel')) { plan = undefined; render(); }
    else if (target.hasAttribute('data-migration-refresh')) request('dataMigration.get');
    else if (target.hasAttribute('data-migration-agent')) request('dataMigration.agent');
    else if (target.hasAttribute('data-migration-preview')) request('dataMigration.preview');
    else if (target.hasAttribute('data-migration-confirm')) request('dataMigration.recycle', { planId: plan?.planId });
    else if (target.hasAttribute('data-migration-restore')) request('dataMigration.restore', { itemId: target.getAttribute('data-migration-restore') });
    else if (target.hasAttribute('data-migration-retry-recycling')) request('dataMigration.retryRecycling', { planId: target.getAttribute('data-migration-retry-recycling') });
    else if (target.hasAttribute('data-migration-retry')) request('dataMigration.retry', { jobId: target.getAttribute('data-migration-retry') });
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.command === 'settingsLoaded' || message?.command === 'settingsSaved') {
      const location = String(message.settings?.globalDataPath || '');
      const changed = savedLocation !== undefined && location !== savedLocation;
      savedLocation = location;
      if (changed) { plan = undefined; overview = undefined; dataRoot = ''; latest = ''; busy = false; }
      render();
      if ((changed || !overview) && visible()) request('dataMigration.get');
      return;
    }
    if (message?.command !== 'dataMigrationLoaded' || message.requestId !== latest) return;
    busy = false;
    if (message.dataRoot) dataRoot = message.dataRoot;
    if (message.overview) overview = message.overview;
    plan = message.plan;
    render();
    if (message.error) { error.textContent = message.error; error.hidden = false; }
    if (message.successMessage) element('[data-migration-status]').textContent = message.successMessage;
  });
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (visible()) { render(); request('dataMigration.get'); } else if (timer) clearTimeout(timer); }) : undefined;
  observer?.observe(panel, { attributes: true, attributeFilter: ['style'] });
  window.addEventListener('unload', () => { observer?.disconnect(); if (timer) clearTimeout(timer); });
  render();
}

export function getMigrationSettingsScript(): string {
  return `(${bindMigrationSettings.toString()})(vscode, () => currentLanguage);`;
}
