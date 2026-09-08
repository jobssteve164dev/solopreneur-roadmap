// This function is serialized into the webview; keep its runtime dependencies inside it.
function mountGrowthReports(vscode: any, projectPath: string, isZh: boolean): void {
  const root = document.getElementById('growth-reports')!;
  const copy = (zh: string, en: string) => isZh ? zh : en;
  const allState = vscode.getState() || {};
  const persistedState = allState.growth?.[projectPath];
  const state = persistedState || { open: [], offset: 0, unmetOnly: false, moduleId: '', capabilityId: '', filterLabel: '', scroll: 0 };
  let initialized = Boolean(persistedState);
  let request = 0; let page: any = null;
  const details = new Map<string, any[]>();
  const nextTurns = new Map<string, number | null>();
  const loadErrors = new Map<string, string>();
  const pending = new Set<string>();
  let actionMessage = '';
  function save(): void {
    const current = vscode.getState() || {};
    vscode.setState({ ...current, growth: { ...current.growth, [projectPath]: state } });
  }
  function element(tag: string, text = '', parent: HTMLElement = root): HTMLElement {
    const node = document.createElement(tag); node.textContent = text; parent.appendChild(node); return node;
  }
  function button(text: string, parent: HTMLElement, action: (button: HTMLButtonElement) => void): HTMLButtonElement {
    const node = element('button', text, parent) as HTMLButtonElement; node.type = 'button';
    node.addEventListener('click', () => action(node)); return node;
  }
  function send(command: string, values: any = {}): void { vscode.postMessage({ command, projectPath, ...values }); }
  function load(): void {
    save(); request += 1; loadErrors.clear();
    send('growth.reports', { query: { offset: state.offset, unmetOnly: state.unmetOnly, moduleId: state.moduleId, capabilityId: state.capabilityId }, requestId: request });
  }
  function text(value: any): string {
    if (value == null) return '';
    if (typeof value === 'object') return Object.values(value).map(text).filter(Boolean).join('\n');
    return String(value);
  }
  function preview(value: any): string {
    const full = text(value).replace(/\s+/g, ' ').trim();
    const characters = Array.from(full);
    if (characters.length <= 120) return full;
    const firstStop = characters.findIndex(character => '。！？.!?'.includes(character));
    if (firstStop >= 0 && firstStop < 120) return characters.slice(0, firstStop + 1).join('');
    return `${characters.slice(0, 117).join('')}…`;
  }
  function action(task: any, turn: any, kind: string, values: any, node: HTMLButtonElement): void {
    const key = `${task.taskId}:${turn?.executionLogId || ''}:${turn?.turnId || ''}:${kind}`;
    if (pending.has(key)) return;
    pending.add(key); node.disabled = true;
    send('growth.reportAction', { taskId: task.taskId, executionLogId: turn?.executionLogId, turnId: turn?.turnId, kind, actionId: key, ...values });
  }
  function sections(parent: HTMLElement, report: any): void {
    for (const [key, zh, en] of [['decisions', '关键决策', 'Decisions'], ['corrections', '纠偏', 'Corrections'], ['verification', '验证说明', 'Reported verification']]) {
      if (!Array.isArray(report?.[key]) || !report[key].length) continue;
      element('h4', copy(zh, en), parent);
      for (const item of report[key]) element('p', text(item), parent);
    }
    if (report?.experienceUsage?.length || report?.lessons?.length) {
      const more = element('details', '', parent); element('summary', copy('经验与复盘材料', 'Experience and review material'), more);
      for (const key of ['experienceUsage', 'lessons']) for (const item of report[key] || []) element('p', text(item), more);
    }
  }
  function remaining(parent: HTMLElement, report: any): void {
    if (!report?.unmetRequirements?.length) return;
    element('h4', copy('尚待完成', 'Still to do'), parent);
    for (const item of report.unmetRequirements) element('p', text(item), parent);
  }
  function showTurns(task: any, parent: HTMLElement): void {
    if (loadErrors.has(task.taskId)) { element('p', loadErrors.get(task.taskId), parent); return; }
    const turns = details.get(task.taskId);
    if (!turns) {
      element('p', copy('读取汇报…', 'Loading reports…'), parent);
      send('growth.reportTurns', { taskId: task.taskId, requestId: request }); return;
    }
    if (!turns.length) element('p', copy('暂无汇报', 'No report yet'), parent);
    let earlier: HTMLElement | undefined;
    for (const [index, turn] of turns.entries()) {
      const latest = index === 0;
      if (!latest && !earlier) {
        earlier = element('details', '', parent);
        element('summary', copy('较早汇报', 'Earlier reports'), earlier);
        (earlier as HTMLDetailsElement).open = Boolean(state.history?.includes(task.taskId));
        const history = earlier as HTMLDetailsElement;
        history.addEventListener('toggle', () => {
          state.history = (state.history || []).filter((id: string) => id !== task.taskId);
          if (history.open) state.history.push(task.taskId); save();
        });
      }
      const row = element(latest ? 'div' : 'details', '', latest ? parent : earlier!);
      const turnKey = `${task.taskId}:${turn.executionLogId}:${turn.turnId}`;
      row.dataset.reportTurn = turnKey;
      if (!latest) {
        (row as HTMLDetailsElement).open = Boolean(state.turns?.includes(turnKey));
        element('summary', `${turn.createdAt ? new Date(turn.createdAt).toLocaleDateString() : ''} · ${copy('第', 'Turn ')}${turn.roundNumber || turn.sequence}${copy('轮汇报', '')}`, row);
        row.addEventListener('toggle', () => {
        state.turns = (state.turns || []).filter((key: string) => key !== turnKey);
        if ((row as HTMLDetailsElement).open) state.turns.push(turnKey); save();
        });
      }
      if (turn.availability !== 'recorded') element('p', copy('汇报暂不可读取；以下保留上次内容。', 'Report unavailable; previous content is retained below.'), row);
      if (!turn.report) continue;
      if (!latest) element('p', turn.report.summary, row);
      remaining(row, turn.report);
      if (latest && task.unmet && !turn.report.unmetRequirements?.length) {
        element('p', copy('此前事项尚未确认完成。', 'Earlier work has not been confirmed complete.'), row);
        remaining(row, turns.find(item => item.report?.unmetRequirements?.length)?.report);
      }
      const actions = element('div', '', row); actions.className = 'report-actions';
      button(copy('继续处理', 'Continue'), actions, node => action(task, turn, 'continue', {}, node));
      const evidence = element('details', '', row);
      element('summary', copy('产出与依据', 'Outputs and evidence'), evidence);
      element('p', `${turn.agent || 'Agent'} · ${copy('第', 'Turn ')}${turn.roundNumber || turn.sequence}${copy('轮', '')} · ${turn.createdAt ? new Date(turn.createdAt).toLocaleString() : ''}`, evidence);
      if (latest && preview(turn.report.summary) !== text(turn.report.summary).replace(/\s+/g, ' ').trim()) {
        element('h4', copy('原始总结', 'Original summary'), evidence);
        element('p', turn.report.summary, evidence);
      }
      sections(evidence, turn.report);
      for (const commit of turn.commits || []) {
        if (!/^[a-f0-9]{40}$/.test(commit?.sha) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(commit?.repository)) continue;
        button(`${copy('查看提交', 'View commit')} ${commit.sha.slice(0, 8)}`, evidence, node => action(task, turn, 'commit', { sha: commit.sha, repository: commit.repository }, node));
      }
      if (turn.files?.length) {
        element('h4', copy('产出', 'Outputs'), evidence);
        for (const file of turn.files) button(`${copy('查看产出', 'View output')} · ${file}`, evidence, node => action(task, turn, 'file', { file }, node));
      }
      if (turn.history?.length > 1) {
        const history = element('details', '', evidence); element('summary', copy('本轮修订记录', 'Earlier versions of this turn'), history);
        for (const old of turn.history.slice(0, -1)) { element('p', old.report?.summary || '', history); remaining(history, old.report); sections(history, old.report); }
      }
    }
    if (nextTurns.get(task.taskId) != null) button(copy('更早轮次', 'Earlier turns'), earlier || parent, node => {
      node.disabled = true; send('growth.reportTurns', { taskId: task.taskId, offset: nextTurns.get(task.taskId), requestId: request });
    });
    const facts = element('details', '', parent); element('summary', copy('查看验证记录', 'View verification records'), facts);
    button(copy('更新验证结果', 'Update verification results'), facts, node => action(task, null, 'verify', {}, node));
    if (!task.evidence?.length) element('p', copy('暂无已读取的提交检查。', 'No saved commit checks.'), facts);
    for (const commit of task.evidence || []) {
      element('h4', `${commit.repository} · ${commit.sha}`, facts);
      element('p', `${copy('最近尝试', 'Last attempted')} ${commit.observedAt || ''}`, facts);
      element('p', `${copy('检查观察时间', 'Checks observed')} ${commit.checksObservedAt || commit.statusesObservedAt || copy('未知', 'Unknown')}`, facts);
      element('p', commit.versionState === 'stale' ? copy('源码已有变化，当前版本待验证。', 'Source has changed; the current version awaits verification.') : commit.versionState === 'current' ? copy('相关源码与此提交一致；检查通过不等于功能验收。', 'Related source matches this commit; passing checks do not establish feature acceptance.') : copy('无法确认当前源码版本，以下保留原提交的检查。', 'Current source version is unconfirmed; checks below apply to the original commit.'), facts);
      for (const check of [...(commit.checks || []), ...(commit.statuses || [])]) {
        const result = check.conclusion || check.state || check.status || 'unknown';
        const labels: any = { success: copy('通过', 'Passed'), failure: copy('失败', 'Failed'), pending: copy('运行中', 'Pending'), in_progress: copy('运行中', 'In progress'), queued: copy('排队中', 'Queued'), cancelled: copy('已取消', 'Cancelled') };
        element('p', `${check.name || check.context || copy('检查', 'Check')} · ${labels[result] || result}`, facts);
        if (/^https:\/\/github\.com\//.test(check.html_url || check.target_url || '')) button(copy('查看检查来源', 'View check source'), facts, node => action(task, null, 'check', { sha: commit.sha, url: check.html_url || check.target_url }, node));
      }
      if (!commit.checks?.length && !commit.statuses?.length) element('p', copy('暂无检查结果', 'No check results'), facts);
      if (commit.gaps?.length) element('p', copy('部分结果未能更新，保留已取得的证据。', 'Some results could not be updated; available evidence is retained.'), facts);
    }
  }
  function render(): void {
    const scroll = window.scrollY;
    root.replaceChildren();
    if (!initialized && page?.tasks?.length) {
      state.open = [page.tasks[0].taskId];
      initialized = true;
      save();
    }
    const tools = element('div'); tools.className = 'report-actions';
    button(copy('全部汇报', 'All reports'), tools, () => { state.moduleId = ''; state.capabilityId = ''; state.filterLabel = ''; state.unmetOnly = false; state.offset = 0; load(); });
    const filter = button(copy('未完成事项', 'Remaining work'), tools, () => { state.unmetOnly = !state.unmetOnly; state.offset = 0; load(); });
    filter.setAttribute('aria-pressed', String(state.unmetOnly));
    if (actionMessage) element('p', actionMessage).setAttribute('role', 'status');
    if (state.filterLabel) element('span', state.filterLabel, tools);
    if (!page?.tasks.length) element('p', copy('暂无汇报', 'No reports yet'));
    for (const task of page?.tasks || []) {
      const group = element('details'); group.className = 'report-task'; group.dataset.reportTask = task.taskId;
      (group as HTMLDetailsElement).open = state.open.includes(task.taskId);
      const heading = element('summary', '', group);
      heading.className = 'report-title';
      element('span', preview(task.latestSummary) || copy('尚未收到结果总结', 'No result summary yet'), heading).className = 'report-result';
      const meta = [task.createdAt ? new Date(task.createdAt).toLocaleDateString() : '', task.unmet ? copy('有未完成事项', 'Work remains') : ''].filter(Boolean);
      if (meta.length) element('p', meta.join(' · '), heading).className = 'report-meta';
      if (task.availability !== 'recorded') element('p', task.availability === 'missing' ? copy('暂无汇报', 'No report yet') : copy('汇报暂不可读取', 'Report unavailable'), group);
      const body = element('div', '', group);
      const context = element('details', '', group);
      element('summary', copy('任务与影响范围', 'Task and affected areas'), context);
      if (task.title) element('p', task.title, context);
      const links = element('div', '', context); links.className = 'report-actions';
      for (const module of task.modules || []) button(`${copy('定位模块', 'Locate module')} · ${module.label}`, links, () => {
        const node = Array.from(document.querySelectorAll<HTMLElement>('[data-growth-module]')).find(node => node.dataset.growthModule === module.id);
        if (node) {
          const detail = node.querySelector('details'); if (detail) detail.open = true;
          node.scrollIntoView({ block: 'center' }); node.focus(); node.classList.add('report-located');
        }
      });
      for (const capability of task.capabilities || []) button(capability.label, links, () => {
        const node = Array.from(document.querySelectorAll<HTMLElement>('[data-growth-capability]')).find(node => node.dataset.growthCapability === capability.id);
        node?.scrollIntoView({ block: 'center' }); node?.focus();
      });
      if ((group as HTMLDetailsElement).open) showTurns(task, body);
      group.addEventListener('toggle', () => {
        const open = (group as HTMLDetailsElement).open;
        state.open = state.open.filter((id: string) => id !== task.taskId);
        if (open) { state.open.push(task.taskId); if (!body.childNodes.length) showTurns(task, body); }
        save();
      });
    }
    if (state.offset > 0) button(copy('上一页', 'Previous'), root, () => { state.offset = Math.max(0, state.offset - 20); load(); });
    if (page?.nextOffset != null) button(copy('下一页', 'Next'), root, () => { state.offset = page.nextOffset; load(); });
    window.scrollTo(0, scroll || state.scroll || 0);
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.projectPath !== projectPath) return;
    if (data.command === 'growth.reportsChanged') { details.clear(); load(); }
    if (data.command === 'growth.reportActionSettled') {
      pending.delete(data.actionId);
      actionMessage = data.error || ''; details.clear(); load();
    }
    if (data.requestId !== request) return;
    if (data.command === 'growth.reportsLoadFailed') {
      if (data.taskId) loadErrors.set(data.taskId, data.error);
      actionMessage = data.error; render();
    }
    if (data.command === 'growth.reportsLoaded') { page = data.page; render(); }
    if (data.command === 'growth.reportTurnsLoaded') {
      details.set(data.taskId, data.offset ? [...(details.get(data.taskId) || []), ...data.page.turns] : data.page.turns);
      nextTurns.set(data.taskId, data.page.nextOffset); render();
    }
  });
  for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-report-module], [data-report-capability]'))) node.addEventListener('click', () => {
    state.moduleId = node.dataset.reportModule || ''; state.capabilityId = node.dataset.reportCapability || '';
    state.filterLabel = node.dataset.reportLabel || ''; state.offset = 0; load(); root.scrollIntoView({ block: 'start' });
  });
  window.addEventListener('scroll', () => { state.scroll = window.scrollY; save(); }, { passive: true });
  for (const detail of Array.from(document.querySelectorAll<HTMLDetailsElement>('[data-module-details]'))) {
    detail.open = Boolean(state.moduleDetails?.includes(detail.dataset.moduleDetails));
    detail.addEventListener('toggle', () => {
      state.moduleDetails = (state.moduleDetails || []).filter((id: string) => id !== detail.dataset.moduleDetails);
      if (detail.open) state.moduleDetails.push(detail.dataset.moduleDetails); save();
    });
  }
  load();
}

export function growthReportsScript(projectPath: string, isZh: boolean): string {
  return `(${mountGrowthReports.toString()})(vscode, ${JSON.stringify(projectPath).replace(/</g, '\\u003c')}, ${isZh});`;
}

export const growthReportsStyles = `
  #growth-reports { overflow-wrap:anywhere; }
  #growth-reports p { white-space:pre-wrap; line-height:1.65; margin:10px 0; }
  #growth-reports details { padding:12px 0; border-top:1px solid var(--border); }
  #growth-reports summary { cursor:pointer; line-height:1.6; }
  #growth-reports .report-title { font-weight:500; font-size:14px; }
  #growth-reports .report-result { white-space:pre-wrap; }
  #growth-reports .report-meta { color:var(--muted); font-size:11px; font-weight:400; margin:6px 0 0; }
  #growth-reports .report-task { padding:16px 0; }
  #growth-reports h4 { font-size:12px; margin:12px 0 4px; }
  .report-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:8px 0; }
  #growth-reports button, .report-filter { color:var(--fg); background:var(--glass-bg); border:1px solid var(--border); border-radius:6px; padding:7px 10px; cursor:pointer; margin:3px; max-width:100%; overflow-wrap:anywhere; }
  #growth-reports button[aria-pressed=true], .report-located { outline:2px solid var(--accent); }
  #growth-reports button:disabled { opacity:.5; cursor:wait; }
`;
