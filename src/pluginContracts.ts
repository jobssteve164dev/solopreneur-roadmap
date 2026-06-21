import { AgentModelCatalog } from './agentModels';
import { ProAccountStatus } from './proAccount';

export interface SolomapEnhancementStatus {
  id: string;
  title: string;
  description: string;
  status: string;
  statusLabel: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  action: string;
  message: string;
  updatedAt: string;
}

export interface SolopreneurSettings {
  cliPath: string;
  agentModelPreferences?: Record<string, string>;
  language: string;
  globalPrompt: string;
  globalDataPath: string;
  taskPermissionMode?: string;
  reviewerCliPath?: string;
  collaborationReviewMode?: string;
  proEntitlements?: Record<string, boolean>;
  proAccount?: ProAccountStatus;
  enabledEnhancements?: Record<string, boolean>;
  enhancementStatuses?: SolomapEnhancementStatus[];
  skills?: any[];
  connectors?: any[];
}

export type AgentModelLoader = (agentCli: string) => Promise<AgentModelCatalog>;

