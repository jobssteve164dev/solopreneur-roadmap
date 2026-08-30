import { dispatchWebviewMessage, WebviewMessageHandlers } from './panelMessages';

export type PluginSurface = 'roadmap' | 'sidebar';

export interface PluginActionRequest {
  command?: string;
  [key: string]: any;
}

const commandAliases: Record<string, string> = {
  continueNativeConversation: 'conversation.continue',
  continueSoloConversation: 'conversation.continue',
  continueStepConversation: 'conversation.continue',
  stopAgentRun: 'conversation.stop',
  stopConversation: 'conversation.stop',
  retryConversation: 'conversation.retry',
  continueConversationTurn: 'conversation.continueTurn',
  linkSoloConversation: 'conversation.linkToStep',
  rollbackChanges: 'conversation.rollback',
  showAgentTerminal: 'conversation.openTerminal',
  runAgent: 'conversation.runStep',
  runRoadmapRevision: 'conversation.runRoadmapRevision',
  runSoloConversation: 'conversation.runSolo',
  runFlow: 'flow.run',
  pauseFlow: 'flow.pause',
  abandonFlow: 'flow.abandon',
  chooseSupplementFiles: 'attachment.choose',
  chooseSoloSupplementFiles: 'attachment.choose',
  savePastedAttachments: 'attachment.save',
  getAgentModels: 'agentModels.get',
  testCli: 'agent.testCli',
  getAgentImpact: 'agentImpact.get',
  getProjectGrowth: 'projectGrowth.get',
  refreshProjectGrowth: 'projectGrowth.refresh',
  getSettings: 'settings.get',
  updateSettings: 'settings.update',
  openProAuthorization: 'entitlement.upgrade',
  installSkill: 'ability.installSkill',
  installMcp: 'ability.installMcp',
  installEnhancement: 'ability.installEnhancement',
  checkEnhancement: 'ability.checkEnhancement',
  setEnhancementEnabled: 'ability.setEnhancementEnabled',
  uninstallEnhancement: 'ability.uninstallEnhancement',
  uninstallSkill: 'ability.uninstallSkill',
  uninstallMcp: 'ability.uninstallMcp',
  getProjects: 'project.getAll',
  getNodeConversations: 'conversation.getHistory',
  getSoloConversationHistory: 'conversation.getHistory',
  getStepConversationHistory: 'conversation.getHistory',
  getProjectConversationHistory: 'conversation.getProjectHistory',
  selectProject: 'project.select',
  addProject: 'project.add',
  removeProject: 'project.remove',
  updateProjectMetadata: 'project.updateMetadata',
  toggleProjectPinned: 'project.togglePinned',
  openProjectFromPortfolio: 'project.openRoadmap',
  continueProjectFromPortfolio: 'project.continue',
  getIssueDetails: 'issue.getDetails',
  createIssue: 'issue.create',
  closeIssue: 'issue.close',
  refreshProjectData: 'project.refreshExternalData',
  openProjectFile: 'project.openFile',
  openExternal: 'external.open',
  openFeedbackIssue: 'feedback.open'
};

export function normalizePluginActionRequest(message: PluginActionRequest, surface: PluginSurface): PluginActionRequest {
  const originalCommand = String(message?.command || '');
  const command = commandAliases[originalCommand] || originalCommand;
  const normalized: PluginActionRequest = { ...message, command, originalCommand, surface };
  if (command === 'conversation.continue') {
    normalized.nodeId = String(message.nodeId || (originalCommand === 'continueSoloConversation' ? '__solo__' : ''));
  }
  if (command === 'conversation.stop') {
    normalized.nodeId = String(message.nodeId || '');
  }
  if (command === 'attachment.choose') {
    normalized.targetId = String(message.targetId || message.nodeId || '');
  }
  return normalized;
}

export async function dispatchPluginAction(
  message: PluginActionRequest,
  surface: PluginSurface,
  handlers: WebviewMessageHandlers
): Promise<boolean> {
  return dispatchWebviewMessage(normalizePluginActionRequest(message, surface), handlers);
}
