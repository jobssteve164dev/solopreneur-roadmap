export function getMigrationSettingsCardHtml(): string {
  return `<section class="settings-card" id="migration-settings-card" aria-labelledby="migration-card-title" hidden>
    <style>
      #migration-settings-card { color: var(--text-main, #e2e8f0); gap: 12px; padding: 14px; overflow: hidden; }
      #migration-settings-card .migration-heading { display: flex; align-items: flex-start; gap: 10px; }
      #migration-settings-card .migration-heading-icon { display: grid; flex: 0 0 32px; width: 32px; height: 32px; place-items: center; border-radius: 9px; color: #67e8f9; background: rgba(34, 211, 238, .11); border: 1px solid rgba(103, 232, 249, .2); }
      #migration-settings-card .migration-heading-copy { min-width: 0; flex: 1; }
      #migration-settings-card .migration-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
      #migration-settings-card .migration-title { font-size: 13px; font-weight: 750; line-height: 1.35; }
      #migration-settings-card .migration-badge { padding: 2px 6px; border-radius: 999px; font-size: 10px; font-weight: 700; color: var(--text-muted, #94a3b8); background: rgba(148, 163, 184, .1); }
      #migration-settings-card .migration-intro { margin: 4px 0 0; color: var(--text-muted, #94a3b8); font-size: 11px; line-height: 1.55; }
      #migration-settings-card .migration-state { padding: 11px 12px; border: 1px solid rgba(103, 232, 249, .16); border-radius: 8px; background: rgba(15, 23, 42, .18); }
      #migration-settings-card .migration-status { font-size: 12px; font-weight: 650; line-height: 1.5; overflow-wrap: anywhere; }
      #migration-settings-card progress { width: 100%; height: 4px; margin-top: 9px; border: 0; accent-color: var(--vscode-progressBar-background, #22d3ee); }
      #migration-settings-card .migration-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
      #migration-settings-card .migration-metric { min-width: 0; padding: 8px; border-radius: 7px; background: rgba(255, 255, 255, .035); }
      #migration-settings-card .migration-metric strong { display: block; font-size: 15px; font-variant-numeric: tabular-nums; line-height: 1.2; }
      #migration-settings-card .migration-metric span { display: block; margin-top: 3px; color: var(--text-muted, #94a3b8); font-size: 11px; line-height: 1.35; }
      #migration-settings-card .migration-detail { font-size: 11px; line-height: 1.55; margin: 7px 0; overflow-wrap: anywhere; }
      #migration-settings-card .migration-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      #migration-settings-card .migration-actions .settings-action-btn { flex: 1 1 120px; min-height: 40px; }
      #migration-settings-card .migration-actions .migration-refresh { flex: 0 1 auto; min-width: 84px; min-height: 32px; color: var(--text-muted, #94a3b8); background: transparent; border-color: transparent; }
      #migration-settings-card button { cursor: pointer; }
      #migration-settings-card button:disabled { cursor: default; opacity: .5; }
      #migration-settings-card button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
      #migration-settings-card .migration-files { max-height: 180px; margin: 8px 0 0; padding: 8px 8px 8px 26px; overflow: auto; border-radius: 6px; background: rgba(0, 0, 0, .12); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
      #migration-settings-card .migration-review { padding: 11px; border: 1px solid rgba(251, 191, 36, .24); border-radius: 8px; background: rgba(251, 191, 36, .05); }
      #migration-settings-card .migration-review-title { margin: 0; font-size: 12px; }
      #migration-settings-card details > summary { min-height: 28px; color: var(--text-main); font-size: 11px; font-weight: 650; cursor: pointer; }
      #migration-settings-card .migration-secondary { padding-top: 9px; border-top: 1px solid rgba(255, 255, 255, .07); }
      #migration-settings-card .migration-error { margin: 0; padding: 8px 10px; border-radius: 6px; color: #fecaca; background: rgba(239, 68, 68, .09); }
      #migration-settings-card .migration-danger { color: #fecaca; border-color: rgba(248, 113, 113, .35); }
      @media (max-width: 420px) { #migration-settings-card .migration-actions [data-migration-agent], #migration-settings-card .migration-actions [data-migration-preview] { flex-basis: 100%; } }
    </style>
    <div class="migration-heading">
      <span class="migration-heading-icon codicon codicon-archive" aria-hidden="true"></span>
      <div class="migration-heading-copy">
        <div class="migration-title-row"><span class="migration-title" id="migration-card-title">旧数据整理</span><span class="migration-badge" data-migration-badge>一次性整理</span></div>
        <p class="migration-intro" data-migration-intro>SoloMap 会在后台安全整理旧数据，不影响日常使用。</p>
      </div>
    </div>
    <div class="migration-state">
      <div class="migration-status" data-migration-status role="status" aria-live="polite">正在读取当前状态…</div>
      <progress data-migration-progress aria-label="旧数据整理进度" hidden></progress>
    </div>
    <div class="migration-metrics" data-migration-metrics hidden>
      <div class="migration-metric"><strong data-migration-saved>0</strong><span data-migration-saved-label>旧文件已保留</span></div>
      <div class="migration-metric"><strong data-migration-imported>0</strong><span data-migration-imported-label>已安全导入</span></div>
      <div class="migration-metric"><strong data-migration-cleanable>0</strong><span data-migration-cleanable-label>可以清理</span></div>
    </div>
    <details class="migration-secondary" data-migration-details hidden>
      <summary data-migration-details-title>查看需要处理的内容</summary>
      <div data-migration-jobs></div>
    </details>
    <div class="migration-error" data-migration-error role="alert" hidden></div>
    <div class="migration-actions">
      <button type="button" class="settings-action-btn save-btn" data-migration-agent>检查旧数据</button>
      <button type="button" class="settings-action-btn test-btn" data-migration-preview disabled>查看可清理内容</button>
      <button type="button" class="settings-action-btn test-btn migration-refresh" data-migration-refresh>更新状态</button>
    </div>
    <div class="migration-review" data-migration-plan hidden>
      <h3 class="migration-review-title" data-migration-plan-title>准备清理</h3>
      <p class="migration-detail" data-migration-plan-copy></p>
      <details data-migration-file-review open><summary data-migration-file-title>查看文件</summary><ul class="migration-files" data-migration-files></ul></details>
      <div class="migration-actions">
        <button type="button" class="settings-action-btn test-btn migration-danger" data-migration-confirm>移到回收站</button>
        <button type="button" class="settings-action-btn test-btn" data-migration-cancel>返回</button>
      </div>
    </div>
    <details class="migration-secondary" data-migration-history-section hidden><summary data-migration-history-title>已处理的文件</summary><div data-migration-history></div></details>
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
    element('#migration-card-title').textContent = text('旧数据整理', 'Old data cleanup');
    element('[data-migration-badge]').textContent = text('一次性整理', 'One-time cleanup');
    element('[data-migration-intro]').textContent = text('SoloMap 会在后台安全整理旧数据，不影响日常使用。', 'SoloMap safely organizes old data in the background without interrupting your work.');
    element('[data-migration-saved-label]').textContent = text('旧文件已保留', 'Old files kept');
    element('[data-migration-imported-label]').textContent = text('已安全导入', 'Safely imported');
    element('[data-migration-cleanable-label]').textContent = text('待检查', 'Ready to review');
    element('[data-migration-details-title]').textContent = text('查看需要处理的内容', 'Review items that need attention');
    element('[data-migration-plan-title]').textContent = text('准备清理', 'Ready to clean up');
    element('[data-migration-file-title]').textContent = text('查看文件', 'Review files');
    element('[data-migration-history-title]').textContent = text('已处理的文件', 'Processed files');
    button('[data-migration-refresh]').textContent = text('更新状态', 'Update status');
    button('[data-migration-preview]').textContent = text('查看可清理内容', 'Review cleanup');
    button('[data-migration-confirm]').textContent = text('移到回收站', 'Move to recycle bin');
    button('[data-migration-cancel]').textContent = text('返回', 'Back');
    const jobs = overview?.jobs || [];
    const maintenanceTasks = overview?.maintenanceTasks || [];
    const busyMaintenanceTaskIds = new Set([...(overview?.activeMaintenanceTaskIds || []), ...(overview?.launchingMaintenanceTaskIds || [])]);
    const isActiveMaintenance = (task: any) => ['ready', 'running'].includes(task.status) && Number(task.validUntil || 0) > Date.now();
    const activeMaintenance = maintenanceTasks.some(isActiveMaintenance);
    const activeReview = maintenanceTasks.some((task: any) => isActiveMaintenance(task) && task.kind === 'migration_review');
    const reviewAgentActive = maintenanceTasks.some((task: any) => isActiveMaintenance(task) && task.kind === 'migration_review' && busyMaintenanceTaskIds.has(task.taskId));
    const recyclingAgentActive = maintenanceTasks.some((task: any) => isActiveMaintenance(task) && task.kind === 'recycling_apply' && busyMaintenanceTaskIds.has(task.taskId));
    const activeRecyclingPlans = new Set(maintenanceTasks.filter((task: any) => isActiveMaintenance(task) && task.kind === 'recycling_apply' && busyMaintenanceTaskIds.has(task.taskId)).map((task: any) => task.targetId));
    const latestReview = maintenanceTasks.filter((task: any) => task.kind === 'migration_review').sort((left: any, right: any) => Number(right.updatedAt || right.createdAt || 0) - Number(left.updatedAt || left.createdAt || 0))[0];
    const failedMaintenance = latestReview?.status === 'failed';
    const activeJobs = jobs.some((job: any) => ['queued', 'running', 'interrupted'].includes(job.status));
    const active = activeJobs || activeMaintenance;
    const needsAttention = jobs.filter((job: any) => ['failed', 'completed_with_conflicts'].includes(job.status));
    const actionableJobs = jobs.filter((job: any) => ['failed', 'completed_with_conflicts', 'interrupted'].includes(job.status));
    const history = overview?.recycling || [];
    const unfinishedCleanup = history.filter((item: any) => ['approved', 'moving', 'held'].includes(item.status));
    card!.hidden = !plan && !active && !failedMaintenance && !needsAttention.length && !Number(overview?.reviewableFiles || overview?.recyclableFiles || 0) && !history.length;
    const migrated = Number(overview?.migratedFiles || 0);
    const count = Number(overview?.capturedFiles || 0);
    element('[data-migration-status]').textContent = !overview ? text('尚未读取当前状态。', 'Current status has not been loaded yet.')
      : reviewAgentActive ? text('正在后台整理旧数据，你可以照常使用。', 'Old data is being organized in the background. You can keep working.')
      : recyclingAgentActive ? text('正在后台清理旧文件，你可以照常使用。', 'Old files are being cleaned up in the background. You can keep working.')
      : activeReview ? text('整理已暂停，可以从这里继续。', 'Cleanup paused and can be continued here.')
      : activeJobs ? text('正在安全导入旧数据，你可以照常使用。', 'Old data is being imported safely. You can keep working.')
      : failedMaintenance ? text('有些内容尚未整理完成，可以重新检查。', 'Some items still need attention. You can check them again.')
      : needsAttention.length ? text('有些旧文件需要你确认，现有数据可正常使用。', 'Some old files need your review. Existing data is ready to use.')
      : unfinishedCleanup.length ? text('有清理操作等待继续。', 'A cleanup action is ready to continue.')
      : jobs.length ? text('旧数据已经整理完成。', 'Old data cleanup is complete.') : text('无需整理旧数据。', 'No old data needs cleanup.');
    button('[data-migration-agent]').textContent = reviewAgentActive ? text('正在整理…', 'Organizing…')
      : activeReview ? text('继续整理', 'Continue cleanup')
      : (failedMaintenance || needsAttention.length) ? text('重新检查', 'Check again') : text('检查旧数据', 'Check old data');
    const progress = element('[data-migration-progress]') as HTMLProgressElement;
    progress.hidden = !activeJobs;
    if (activeJobs && count > 0) { progress.setAttribute('max', String(count)); progress.setAttribute('value', String(Math.min(count, migrated))); }
    else { progress.removeAttribute('max'); progress.removeAttribute('value'); }
    progress.setAttribute('aria-label', text('旧数据整理进度', 'Old data cleanup progress'));
    const cleanable = Number(overview?.reviewableFiles || overview?.recyclableFiles || 0);
    element('[data-migration-metrics]').hidden = !overview;
    element('[data-migration-saved]').textContent = String(count);
    element('[data-migration-imported]').textContent = String(migrated);
    element('[data-migration-cleanable]').textContent = String(cleanable);
    element('[data-migration-details]').hidden = !actionableJobs.length;
    element('[data-migration-jobs]').innerHTML = actionableJobs.map((job: any) => {
      const name = ({
        intelligence: text('聊天记录', 'Chat history'),
        'project-growth': text('项目生长图', 'Project growth'),
        'project-journal': text('项目日志', 'Project journal'),
        'agent-runs': text('Agent 运行记录', 'Agent runs')
      } as Record<string, string>)[job.args.collection] || text('长期记忆', 'Long-term memory');
      const errors = Array.isArray(job.progress.conflicts) ? job.progress.conflicts : [];
      return '<div class="migration-detail">' + '<strong>' + name + '</strong> · ' + escape(text(({ interrupted: '等待继续', completed_with_conflicts: '有文件需要确认', failed: '尚未完成' } as any)[job.status] || '', ({ interrupted: 'Ready to continue', completed_with_conflicts: 'Files need review', failed: 'Not finished' } as any)[job.status] || ''))
        + ' <button type="button" class="settings-action-btn test-btn" data-migration-retry="' + escape(job.jobId) + '">' + text('重新处理', 'Try again') + '</button>'
        + (errors.length || job.error ? '<details><summary>' + text('查看保留的文件', 'Review kept files') + '</summary><ul class="migration-files">' + errors.map((value: any) => '<li>' + escape(value.source) + '</li>').join('') + (job.error ? '<li>' + text('这部分尚未读取完成，可以重新处理。', 'This part was not fully read and can be tried again.') + '</li>' : '') + '</ul></details>' : '') + '</div>';
    }).join('');
    element('[data-migration-plan]').hidden = !plan;
    if (plan) {
      element('[data-migration-plan-copy]').textContent = plan.files.length
        ? text('这些旧文件已安全导入。移到回收站后，仍可从这里恢复。', 'These old files were imported safely. You can restore them here after moving them to the recycle bin.')
        : text('目前没有可以清理的文件。正在使用或已经变化的文件会继续保留。', 'There are no files ready to clean. Files in use or changed will stay in place.');
      element('[data-migration-files]').innerHTML = plan.files.map((file: any) => '<li>' + escape(file.path) + '</li>').join('');
    }
    const historySection = element('[data-migration-history-section]') as HTMLDetailsElement;
    historySection.hidden = !history.length;
    historySection.open = unfinishedCleanup.length > 0;
    element('[data-migration-history-title]').textContent = unfinishedCleanup.length
      ? text(unfinishedCleanup.length + ' 个清理操作等待继续', unfinishedCleanup.length + ' cleanup actions ready to continue')
      : text('已处理的文件', 'Processed files');
    element('[data-migration-history]').innerHTML = history.map((item: any) => {
      const state = item.status === 'trashed' ? text('已移到回收站', 'Moved to recycle bin')
        : item.status === 'restored' ? text('已恢复', 'Restored')
        : item.status === 'changed' ? text('内容已变化，继续保留', 'Changed and kept in place')
        : ['approved', 'moving', 'held'].includes(item.status) ? text('清理尚未完成', 'Cleanup not finished')
        : text('已安全保留', 'Safely kept');
      return '<div class="migration-detail">' + escape(item.path) + ' · ' + state
      + (item.status !== 'approved' ? ' <button type="button" class="settings-action-btn test-btn" data-migration-restore="' + escape(item.itemId) + '">' + text('恢复文件', 'Restore file') + '</button>' : '')
      + (['approved', 'moving', 'held'].includes(item.status) ? ' <button type="button" class="settings-action-btn test-btn" data-migration-retry-recycling="' + escape(item.planId) + '"' + (activeRecyclingPlans.has(item.planId) ? ' data-action-disabled disabled' : '') + '>' + text('继续清理', 'Continue cleanup') + '</button>' : '') + '</div>';
    }).join('');
    card!.querySelectorAll('button').forEach(control => { control.disabled = busy || control.hasAttribute('data-action-disabled'); });
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
