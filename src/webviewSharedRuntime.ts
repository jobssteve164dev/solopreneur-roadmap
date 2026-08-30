/**
 * Browser-side primitives shared by the roadmap and sidebar Webviews.
 *
 * The extension still ships self-contained HTML, so this module serializes one
 * runtime bootstrap into both documents instead of maintaining parallel copies.
 */
function bootstrapSoloMapWebviewRuntime(): void {
  const root = globalThis as any;

  function escapeHtml(value: unknown): string {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function statusClass(status: unknown): string {
    return String(status || '').replace(/[^a-zA-Z0-9]/g, '-');
  }

  function extractNativeSessionId(conversation: any): string {
    return conversation && typeof conversation === 'object'
      ? String(conversation.resumableNativeSessionId || '')
      : '';
  }

  function formatDurationMs(durationMs: unknown, options: any = {}): string {
    const numeric = Number(durationMs);
    if (!Number.isFinite(numeric) || numeric < 0) return '';
    const rounding = options.rounding === 'floor' ? Math.floor : Math.round;
    const seconds = Math.max(options.minimumOneSecond ? 1 : 0, rounding(numeric / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (options.includeHours && hours > 0) return hours + 'h ' + minutes + 'm';
    if (minutes > 0) return minutes + 'm ' + remainder + 's';
    return remainder + 's';
  }

  function normalizeAgentOptionLabel(value: unknown): string {
    const normalized = String(value || '').trim();
    const name = (normalized.split(/[\\/]/).pop() || '').toLowerCase();
    if (name === 'codex-cli' || name === 'solomap-codex-auto') return 'codex';
    if (name === 'cursor-cli' || name === 'cursor-agent' || name === 'solomap-cursor-auto') return 'cursor';
    if (name === 'copilot-cli' || name === 'solomap-copilot-auto') return 'copilot';
    if (name === 'agy' || name === 'antigravity-cli' || name === 'solomap-antigravity-auto') return 'antigravity';
    if (name === 'claude-code' || name === 'claude-code-cli' || name === 'solomap-claude-auto') return 'claude';
    if (name === 'open-code' || name === 'open-code-cli') return 'opencode';
    if (name === 'grok') return 'grok';
    return normalized;
  }

  function getCliPresetFromCliPath(cliPath: unknown): string {
    const base = (String(cliPath || '').trim().split(/[\\/]/).pop() || '').toLowerCase();
    if (!base || ['agy', 'antigravity', 'antigravity-cli'].includes(base)) return 'agy';
    if (['codex', 'codex-cli'].includes(base)) return 'codex';
    if (['cursor', 'cursor-cli', 'cursor-agent'].includes(base)) return 'cursor';
    if (['copilot', 'copilot-cli'].includes(base)) return 'copilot';
    if (['claude', 'claude-code', 'claude-code-cli'].includes(base)) return 'claude';
    if (['opencode', 'open-code', 'open-code-cli'].includes(base)) return 'opencode';
    if (base === 'grok') return 'grok';
    return 'custom';
  }

  function buildAgentOption(value: unknown): any {
    const normalized = String(value || '').trim();
    const label = normalizeAgentOptionLabel(normalized);
    if (!label) return null;
    return {
      value: normalized.includes('/') || normalized.includes('\\') ? normalized : label,
      label
    };
  }

  function getAgentOptions(currentCliPath: unknown, nodeCliPath: unknown): any[] {
    const options: any[] = [];
    function add(value: unknown): void {
      const option = buildAgentOption(value);
      if (!option || options.some((existing) => existing.label === option.label)) return;
      options.push(option);
    }
    add(currentCliPath || 'agy');
    add(nodeCliPath || currentCliPath || 'agy');
    ['antigravity', 'cursor', 'codex', 'copilot', 'claude', 'opencode', 'grok'].forEach(add);
    return options;
  }

  function closeSoloSelects(except?: Element): void {
    document.querySelectorAll('[data-solo-select]').forEach((select) => {
      if (select === except) return;
      select.classList.remove('open');
      const trigger = select.querySelector('[data-solo-trigger]');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function setSoloSelectValue(select: Element | null, value: unknown): void {
    if (!select) return;
    const choices = Array.from(select.querySelectorAll('[data-solo-option-value]'));
    const selected = choices.find((choice) => choice.getAttribute('data-solo-option-value') === String(value || '')) || choices[0];
    const selectedValue = selected ? selected.getAttribute('data-solo-option-value') || '' : '';
    select.setAttribute('data-value', selectedValue);
    const label = select.querySelector('[data-solo-label]');
    if (label) label.textContent = selected ? selected.textContent || '' : '';
    choices.forEach((choice) => choice.setAttribute('aria-selected', choice === selected ? 'true' : 'false'));
  }

  function getSoloSelectValue(select: Element | null): string {
    return select ? select.getAttribute('data-value') || '' : '';
  }

  function setSoloSelectOptions(select: Element | null, options: any[], selectedValue: unknown): void {
    const menu = select && select.querySelector('[data-solo-menu]');
    if (!menu) return;
    menu.innerHTML = (options || []).map((option) => (
      '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(option.value) +
      '" title="' + escapeHtml(option.title || option.label) + '" aria-selected="false">' +
      escapeHtml(option.label) + '</button>'
    )).join('');
    setSoloSelectValue(select, selectedValue);
  }

  function renderSoloSelect(className: string, attributes: string, options: any[], disabled: boolean, selectedValue: unknown): string {
    const selected = options.find((option) => String(option.value || '') === String(selectedValue || '')) || options[0] || { value: '', label: '' };
    return '<div class="solo-select ' + className + (disabled ? ' is-disabled' : '') +
      '" data-solo-select data-value="' + escapeHtml(selected.value) + '" ' + attributes + '>' +
      '<button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false"' +
      (disabled ? ' disabled' : '') + '>' +
      '<span class="solo-select-trigger-label" data-solo-label>' + escapeHtml(selected.label) + '</span>' +
      '<span class="codicon codicon-chevron-down solo-select-caret"></span></button>' +
      '<div class="solo-select-menu" data-solo-menu role="listbox">' +
      options.map((option, index) => '<button type="button" class="solo-select-option" data-solo-option-value="' +
        escapeHtml(option.value) + '" aria-selected="' +
        (String(option.value || '') === String(selected.value || '') || (!selected.value && index === 0) ? 'true' : 'false') +
        '">' + escapeHtml(option.label) + '</button>').join('') +
      '</div></div>';
  }

  function bindSoloSelect(select: Element | null, onChange?: (value: string) => void): void {
    if (!select || select.getAttribute('data-solo-bound') === 'true') return;
    select.setAttribute('data-solo-bound', 'true');
    select.addEventListener('click', (rawEvent) => {
      const event = rawEvent as MouseEvent;
      event.stopPropagation();
      const target = event.target as Element;
      const option = target.closest('[data-solo-option-value]');
      if (option) {
        const previousValue = getSoloSelectValue(select);
        setSoloSelectValue(select, option.getAttribute('data-solo-option-value'));
        select.classList.remove('open');
        const trigger = select.querySelector('[data-solo-trigger]');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        if (onChange && previousValue !== getSoloSelectValue(select)) onChange(getSoloSelectValue(select));
        return;
      }
      if (target.closest('[data-solo-trigger]') && !select.classList.contains('is-disabled')) {
        const open = !select.classList.contains('open');
        closeSoloSelects(select);
        select.classList.toggle('open', open);
        const trigger = select.querySelector('[data-solo-trigger]');
        if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    });
    select.addEventListener('keydown', (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      const target = event.target as Element;
      if (event.key === 'Escape') {
        select.classList.remove('open');
        const trigger = select.querySelector('[data-solo-trigger]');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
      } else if ((event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') && target.closest('[data-solo-trigger]')) {
        event.preventDefault();
        closeSoloSelects(select);
        select.classList.add('open');
        target.setAttribute('aria-expanded', 'true');
      }
    });
  }

  function bindSoloSelects(container: Element): void {
    container.querySelectorAll('[data-solo-select]').forEach((select) => bindSoloSelect(select));
  }

  function readClipboardImage(file: File): Promise<any> {
    return new Promise((resolve) => {
      if (typeof FileReader === 'undefined' || !file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({
        name: file.name || 'pasted-image',
        mimeType: file.type || 'image/png',
        dataUrl: String(reader.result || '')
      });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  function bindPastedImageAttachments(
    input: Element | null,
    postMessage: (message: any) => void,
    buildMessage: (attachments: any[]) => any,
    onStateChange?: (state: { phase: 'started' | 'failed'; requestId: string; count: number }) => void
  ): void {
    if (!input || input.getAttribute('data-paste-image-bound') === 'true') return;
    input.setAttribute('data-paste-image-bound', 'true');
    input.addEventListener('paste', async (rawEvent) => {
      const event = rawEvent as ClipboardEvent;
      const items = Array.from(event.clipboardData?.items || []);
      const files = items
        .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(Boolean) as File[];
      if (!files.length) return;
      event.preventDefault();
      const requestId = 'paste-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      if (onStateChange) onStateChange({ phase: 'started', requestId, count: files.length });
      const attachments = (await Promise.all(files.map(readClipboardImage))).filter(Boolean);
      if (attachments.length) {
        postMessage({ ...buildMessage(attachments), requestId });
      } else if (onStateChange) {
        onStateChange({ phase: 'failed', requestId, count: files.length });
      }
    });
  }

  function createModelController(config: any): any {
    function family(agentCli: unknown): string {
      const normalized = normalizeAgentOptionLabel(agentCli || config.getEffectiveSettingCliPath() || config.getCurrentCliPath() || 'agy');
      return String(normalized || 'agy').toLowerCase();
    }
    function autoCatalog(agentCli: unknown): any {
      return { agentCli: family(agentCli), supportsDiscovery: false, models: [{ value: 'auto', label: 'Auto' }] };
    }
    function catalog(agentCli: unknown): any {
      return config.catalogs[family(agentCli)] || autoCatalog(agentCli);
    }
    function options(agentCli: unknown): any[] {
      const models = Array.isArray(catalog(agentCli).models) && catalog(agentCli).models.length
        ? catalog(agentCli).models
        : autoCatalog(agentCli).models;
      return models.map((option: any) => ({
        value: String(option.value || 'auto'),
        label: String(option.label || option.value || 'Auto'),
        title: String(option.description || option.label || option.value || 'Auto')
      }));
    }
    function sanitize(agentCli: unknown, value: unknown): string {
      const selected = String(value || 'auto');
      return options(agentCli).some((option) => option.value === selected) ? selected : 'auto';
    }
    function stored(agentCli: unknown): string {
      return sanitize(agentCli, config.preferences[family(agentCli)] || 'auto');
    }
    function target(targetId: string, agentCli: unknown): string {
      return targetId && config.selections[targetId] ? sanitize(agentCli, config.selections[targetId]) : stored(agentCli);
    }
    function setTarget(targetId: string, agentCli: unknown, value: unknown, persist: boolean): string {
      const next = sanitize(agentCli, value);
      if (targetId) config.selections[targetId] = next;
      if (persist) config.preferences[family(agentCli)] = next;
      return next;
    }
    function request(agentCli: unknown, targetId: string): void {
      config.postMessage({
        command: 'agentModels.get',
        requestId: config.nextRequestId(),
        targetId: targetId || '',
        agentCli: String(agentCli || '').trim() || config.getCurrentCliPath() || 'agy'
      });
    }
    return {
      getAgentFamilyKey: family,
      getAutoOnlyModelCatalog: autoCatalog,
      getAgentModelCatalog: catalog,
      getAgentModelOptions: options,
      sanitizeModelValue: sanitize,
      getStoredModelPreference: stored,
      getTargetModelValue: target,
      setTargetModelValue: setTarget,
      ensureAgentModelsLoaded: request
    };
  }

  function getEffectiveSettingCliPath(select: Element | null, customInput: HTMLInputElement | null, currentCliPath: string): string {
    if (!select) return currentCliPath || 'agy';
    const selected = getSoloSelectValue(select);
    if (selected === 'custom') return String(customInput?.value || '').trim() || 'agy';
    if (currentCliPath && getCliPresetFromCliPath(currentCliPath) === selected) return currentCliPath;
    return selected || 'agy';
  }

  function applySettingCliPath(select: Element | null, customInput: HTMLInputElement | null, cliPath: unknown): string {
    const raw = String(cliPath || '').trim() || 'agy';
    const preset = getCliPresetFromCliPath(raw);
    if (select) setSoloSelectValue(select, preset);
    if (customInput) {
      customInput.value = preset === 'custom' ? raw : '';
      customInput.style.display = preset === 'custom' ? 'block' : 'none';
    }
    return raw;
  }

  function getEffectiveReviewerCliPath(select: Element | null, customInput: HTMLInputElement | null): string {
    const selected = getSoloSelectValue(select);
    if (!selected) return '';
    return selected === 'custom' ? String(customInput?.value || '').trim() : selected;
  }

  function applyReviewerCliPath(select: Element | null, customInput: HTMLInputElement | null, cliPath: unknown): void {
    const raw = String(cliPath || '').trim();
    if (!select) return;
    if (!raw) {
      setSoloSelectValue(select, '');
      if (customInput) {
        customInput.value = '';
        customInput.style.display = 'none';
      }
      return;
    }
    const preset = getCliPresetFromCliPath(raw);
    setSoloSelectValue(select, preset);
    if (customInput) {
      customInput.value = preset === 'custom' ? raw : '';
      customInput.style.display = preset === 'custom' ? 'block' : 'none';
    }
  }

  function hasProEntitlement(settings: any, feature: string): boolean {
    const entitlements = settings?.proEntitlements || {};
    const account = settings?.proAccount || {};
    const expiresAtMs = account.expiresAt ? Date.parse(String(account.expiresAt)) : NaN;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) return false;
    return Boolean(entitlements[feature]);
  }

  function renderProAccount(panel: Element | null, settings: any, t: (key: string) => string, language: string): void {
    if (!panel) return;
    const account = settings?.proAccount || {};
    const authenticated = Boolean(account.authenticated);
    const unlocked = hasProEntitlement(settings || {}, 'strategy_pyramid');
    const email = String(account.email || '').trim();
    panel.innerHTML =
      '<div class="dependency-item"><div class="dependency-info">' +
      '<div class="dependency-name">' + escapeHtml(t('accountName')) + '</div>' +
      '<div class="dependency-message">' + escapeHtml(email || t('proAccountAnonymous')) + '</div>' +
      '<div class="dependency-message">' + escapeHtml(t(unlocked ? 'accountProHelp' : authenticated ? 'accountSignedInHelp' : 'accountSignedOutHelp')) + '</div></div>' +
      '<span class="dependency-status ' + (unlocked || authenticated ? 'ready' : 'missing') + '">' +
      escapeHtml(unlocked ? 'SoloMap Pro' : authenticated ? t('accountFree') : t('proAccountAnonymous')) + '</span></div>';
  }

  function renderOnboardingPanel(t: (key: string) => string): string {
    return '<div class="onboarding-panel">' +
      '<div class="onboarding-kicker"><span class="codicon codicon-compass"></span>' + escapeHtml(t('onboardingKicker')) + '</div>' +
      '<div class="onboarding-title">' + escapeHtml(t('onboardingTitle')) + '</div>' +
      '<div class="onboarding-copy">' + escapeHtml(t('onboardingCopy')) + '</div>' +
      '<div class="onboarding-steps">' +
      '<div class="onboarding-step"><span class="onboarding-step-index">1</span><span>' + escapeHtml(t('onboardingStepProject')) + '</span></div>' +
      '<div class="onboarding-step"><span class="onboarding-step-index">2</span><span>' + escapeHtml(t('onboardingStepType')) + '</span></div>' +
      '<div class="onboarding-step"><span class="onboarding-step-index">3</span><span>' + escapeHtml(t('onboardingStepRoadmap')) + '</span></div>' +
      '</div><button class="onboarding-action" data-onboarding-add-project>' +
      '<span class="codicon codicon-add"></span>' + escapeHtml(t('onboardingAction')) + '</button></div>';
  }

  function bindOnboardingActions(container: Element, postMessage: (message: any) => void): void {
    container.querySelectorAll('[data-onboarding-add-project]').forEach((button) => {
      button.addEventListener('click', () => postMessage({ command: 'project.add' }));
    });
  }

  function createAbilityController(config: any): any {
    let selectedId = '';
    let currentSettings: any = null;

    function buildItems(settings: any): any[] {
      const items: any[] = [];
      (Array.isArray(settings?.skills) ? settings.skills : []).forEach((skill: any) => items.push({
        id: 'skill-' + skill.id,
        type: 'skill',
        originId: skill.id,
        title: skill.title || skill.id,
        description: skill.description || '',
        installed: true,
        statusLabel: config.t('installedStatus'),
        statusClass: 'ready',
        meta: config.t('skillMetaPrefix') + (skill.entry || '')
      }));
      items.push({
        id: 'add-new-skill',
        type: 'add-new-skill',
        title: config.t('addSkill'),
        description: config.t('addSkillDescription'),
        installed: false
      });
      (Array.isArray(settings?.connectors) ? settings.connectors : []).forEach((connector: any) => items.push({
        id: 'connector-' + connector.id,
        type: 'connector',
        originId: connector.id,
        title: connector.title || connector.id,
        description: connector.description || '',
        installed: true,
        statusLabel: config.t('installedStatus'),
        statusClass: 'ready',
        meta: config.t('connectorMetaPrefix') + (connector.type || 'mcp')
      }));
      items.push({
        id: 'add-new-connector',
        type: 'add-new-connector',
        title: config.t('addConnector'),
        description: config.t('addConnectorDescription'),
        installed: false
      });
      (Array.isArray(settings?.enhancementStatuses) ? settings.enhancementStatuses : []).forEach((enhancement: any) => {
        const installed = enhancement.status === 'ready' || enhancement.installed;
        items.push({
          id: 'enhancement-' + enhancement.id,
          type: 'enhancement',
          originId: enhancement.id,
          title: enhancement.title || enhancement.id,
          description: enhancement.description || '',
          installed,
          statusLabel: enhancement.statusLabel || (installed ? config.t('readyStatus') : config.t('notInstalledStatus')),
          statusClass: enhancement.status || (installed ? 'ready' : 'missing'),
          meta: config.t('enhancementMetaPrefix') + (enhancement.version || 'unknown')
        });
      });
      return items;
    }

    function render(settings: any): void {
      const elements = config.elements;
      if (!elements.select || !elements.urlContainer || !elements.urlInput || !elements.urlHelp ||
          !elements.detailCard || !elements.installButton || !elements.uninstallButton) return;
      currentSettings = settings;
      const items = buildItems(settings);
      if (!selectedId || !items.some((item) => item.id === selectedId)) selectedId = items[0]?.id || '';
      const selected = items.find((item) => item.id === selectedId) || items[0];
      if (!selected) return;

      const groups = [
        ['abilityGroupSkills', ['skill', 'add-new-skill']],
        ['abilityGroupConnectors', ['connector', 'add-new-connector']],
        ['abilityGroupEnhancements', ['enhancement']]
      ];
      const menu = elements.select.querySelector('[data-solo-menu]');
      if (menu) {
        menu.innerHTML = groups.map(([labelKey, types]: any) => (
          '<div class="solo-select-group-header">' + escapeHtml(config.t(labelKey)) + '</div>' +
          items.filter((item) => types.includes(item.type)).map((item) =>
            '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(item.id) +
            '" aria-selected="' + (item.id === selected.id ? 'true' : 'false') + '">' +
            escapeHtml(item.title) + '</button>'
          ).join('')
        )).join('');
      }
      const label = elements.select.querySelector('[data-solo-label]');
      if (label) label.textContent = selected.title;
      elements.select.setAttribute('data-value', selected.id);

      const adding = selected.type === 'add-new-skill' || selected.type === 'add-new-connector';
      elements.urlContainer.style.display = adding ? 'block' : 'none';
      elements.detailCard.style.display = adding ? 'none' : 'block';
      if (adding) {
        const skill = selected.type === 'add-new-skill';
        elements.urlInput.placeholder = skill
          ? 'e.g. https://skills.sh/owner/repo or owner/repo@skill'
          : 'e.g. GitHub MCP server URL, npm package, or config snippet';
        elements.urlHelp.textContent = config.t(skill ? 'skillInstallInputHelp' : 'mcpInstallInputHelp');
        elements.installButton.removeAttribute('disabled');
        elements.uninstallButton.setAttribute('disabled', 'true');
      } else {
        elements.detailTitle.textContent = selected.title;
        elements.detailDescription.textContent = selected.description;
        elements.detailStatus.textContent = selected.statusLabel;
        elements.detailStatus.className = 'enhancement-status ' + selected.statusClass;
        elements.detailMeta.textContent = selected.meta || '';
        const canInstall = selected.type === 'enhancement' && !selected.installed;
        if (canInstall) {
          elements.installButton.removeAttribute('disabled');
          elements.uninstallButton.setAttribute('disabled', 'true');
        } else {
          elements.installButton.setAttribute('disabled', 'true');
          elements.uninstallButton.removeAttribute('disabled');
        }
      }
      bindSoloSelect(elements.select, (value) => {
        selectedId = value || '';
        render(currentSettings);
      });
    }

    function install(): void {
      const value = String(config.elements.urlInput?.value || '').trim();
      if (!selectedId || !currentSettings) return;
      if (selectedId === 'add-new-skill') {
        if (!value) return config.showMessage(config.t('skillInputRequired'), true);
        config.showMessage(config.t('installingSkillMessage'));
        config.postMessage({ command: 'ability.installSkill', skillInput: value });
      } else if (selectedId === 'add-new-connector') {
        if (!value) return config.showMessage(config.t('mcpInputRequired'), true);
        config.showMessage(config.t('installingMcpMessage'));
        config.postMessage({ command: 'ability.installMcp', mcpInput: value });
      } else if (selectedId.startsWith('enhancement-')) {
        config.showMessage(config.t('installingEnhancementMessage'));
        config.postMessage({ command: 'ability.installEnhancement', enhancementId: selectedId.substring(12) });
      }
    }

    function uninstall(): void {
      if (!selectedId || !currentSettings) return;
      const actions = [
        ['skill-', 'uninstallingSkillMessage', 'ability.uninstallSkill', 'skillId'],
        ['connector-', 'uninstallingMcpMessage', 'ability.uninstallMcp', 'mcpId'],
        ['enhancement-', 'uninstallingEnhancementMessage', 'ability.uninstallEnhancement', 'enhancementId']
      ];
      const action = actions.find(([prefix]) => selectedId.startsWith(prefix));
      if (!action) return;
      const [prefix, messageKey, command, idKey] = action;
      config.showMessage(config.t(messageKey));
      config.postMessage({ command, [idKey]: selectedId.substring(prefix.length) });
    }

    config.elements.installButton?.addEventListener('click', install);
    config.elements.uninstallButton?.addEventListener('click', uninstall);
    return { render, buildItems };
  }

  root.SoloMapWebview = Object.freeze({
    escapeHtml,
    statusClass,
    extractNativeSessionId,
    formatDurationMs,
    normalizeAgentOptionLabel,
    getCliPresetFromCliPath,
    buildAgentOption,
    getAgentOptions,
    closeSoloSelects,
    setSoloSelectValue,
    getSoloSelectValue,
    setSoloSelectOptions,
    renderSoloSelect,
    bindSoloSelect,
    bindSoloSelects,
    readClipboardImage,
    bindPastedImageAttachments,
    createModelController,
    getEffectiveSettingCliPath,
    applySettingCliPath,
    getEffectiveReviewerCliPath,
    applyReviewerCliPath,
    hasProEntitlement,
    renderProAccount,
    renderOnboardingPanel,
    bindOnboardingActions,
    createAbilityController
  });
}

export function getSharedWebviewRuntimeScript(): string {
  return `(${bootstrapSoloMapWebviewRuntime.toString()})();`;
}
