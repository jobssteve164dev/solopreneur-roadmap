export interface RoadmapNode {
  id: string;
  title: string;
  description: string;
  stage: string;
  dependencies: string; // Comma-separated list of node IDs
  agentCli: string;
  agentPrompt: string;
  status: 'Pending' | 'Running' | 'Completed' | 'Failed';
  createdAt: string;
  completedAt: string;
}

export interface RoadmapEdge {
  id: string;
  source: string;
  target: string;
}

export interface ProjectState {
  nodes: RoadmapNode[];
  edges: RoadmapEdge[];
}
