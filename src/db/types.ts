export interface RoadmapNode {
  id: string;
  title: string;
  description: string;
  stage: string;
  dependencies: string; // Comma-separated list of node IDs
  agentCli: string;
  agentPrompt: string;
  completionCriteria?: string[];
  status: 'Pending' | 'In Progress' | 'Running' | 'Completed' | 'Failed';
  createdAt: string;
  completedAt: string;
}

export interface RoadmapEdge {
  id: string;
  source: string;
  target: string;
}

export interface AgentConversation {
  id: number;
  nodeId: string;
  timestamp: string;
  agentCli: string;
  command: string;
  output: string;
  status: string;
}

export interface RunIndexRecord {
  executionLogId: number;
  nodeId: string;
  runKind: string;
  agentCli: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outputPath: string;
  outputBytes: number;
  outputTail: string;
  commandPath: string;
  promptPath: string;
  changesPath: string;
  touchedFilesPath: string;
  updatedAt: string;
}

export interface RunIndexFile {
  executionLogId?: number;
  filePath: string;
  role: 'changed' | 'touched' | 'attachment' | 'evidence' | string;
}

export interface RunIndexSignal {
  executionLogId?: number;
  type: 'verification' | 'failure' | 'reusable' | 'decision' | string;
  value: string;
}

export interface RunIndexEntry extends RunIndexRecord {
  files: RunIndexFile[];
  signals: RunIndexSignal[];
}

export interface ProjectState {
  nodes: RoadmapNode[];
  edges: RoadmapEdge[];
}
