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

export interface GrowthSnapshotRecord {
  id: string;
  createdAt: string;
  projectPath: string;
  gitHead: string;
  scanReason: string;
  status: 'completed' | 'failed' | string;
  durationMs: number;
  error: string;
}

export interface GrowthNodeRecord {
  snapshotId: string;
  nodeId: string;
  parentId: string;
  kind: 'file' | 'directory' | 'module' | 'capability' | string;
  path: string;
  label: string;
  language: string;
  bytes: number;
  loc: number;
  fileCount: number;
  testFileCount: number;
  generated: boolean;
  excluded: boolean;
  primaryRole: string;
  confidence: number;
}

export interface GrowthEdgeRecord {
  snapshotId: string;
  sourceId: string;
  targetId: string;
  kind: 'contains' | 'imports' | 'depends_on' | 'implements' | 'tested_by' | 'shaped_by_run' | 'belongs_to_step' | string;
  weight: number;
  evidence: string;
}

export interface GrowthSignalRecord {
  snapshotId: string;
  nodeId: string;
  type: 'activity' | 'risk' | 'verification' | 'failure' | 'delivery' | 'ownership' | 'recommendation' | string;
  level: 'info' | 'watch' | 'attention' | 'blocked' | string;
  value: string;
  source: string;
  sourceRef: string;
  createdAt: string;
}

export interface GrowthModuleLabelRecord {
  snapshotId: string;
  nodeId: string;
  label: string;
  role: string;
  source: 'rule' | 'agent' | 'user' | 'import_graph' | 'roadmap' | string;
  confidence: number;
  updatedAt: string;
}

export interface GrowthSnapshotData {
  snapshot: GrowthSnapshotRecord;
  nodes: GrowthNodeRecord[];
  edges: GrowthEdgeRecord[];
  signals: GrowthSignalRecord[];
  labels: GrowthModuleLabelRecord[];
}

export interface ProjectState {
  nodes: RoadmapNode[];
  edges: RoadmapEdge[];
}
