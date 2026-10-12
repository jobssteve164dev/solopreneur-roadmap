import * as fs from 'fs';
import * as Papa from 'papaparse';
import { RoadmapNode } from './types';

export const roadmapCsvColumns = [
  'id', 'title', 'description', 'stage', 'dependencies', 'agentCli',
  'agentPrompt', 'status', 'createdAt', 'completedAt'
];

export function parseRoadmapCsv(fileContent: string, options: { strictHeader?: boolean } = {}): RoadmapNode[] {
  const headerResult = Papa.parse<string[]>(fileContent, { preview: 1, skipEmptyLines: true });
  const header = (headerResult.data[0] || []).map(value => String(value));
  if (options.strictHeader && (header.length !== roadmapCsvColumns.length || header.some((value, index) => value !== roadmapCsvColumns[index]))) {
    throw new Error('roadmap_csv_invalid:header');
  }
  const parseResult = Papa.parse<RoadmapNode>(fileContent, { header: true, skipEmptyLines: true });
  if (parseResult.errors.length > 0) throw new Error(`roadmap_csv_invalid:${parseResult.errors.map(error => error.message).join(';')}`);
  const nodes = parseResult.data.map(node => ({
    ...node,
    id: String(node.id || '').trim(),
    title: String(node.title || ''),
    status: node.status || 'Pending',
    dependencies: node.dependencies || '',
  }));
  const ids = new Set<string>();
  const statuses = new Set(['Pending', 'In Progress', 'Running', 'Completed', 'Failed']);
  for (const node of nodes) {
    if (!node.id || !node.title || ids.has(node.id) || !statuses.has(node.status)) throw new Error('roadmap_csv_invalid:node_identity');
    ids.add(node.id);
  }
  for (const node of nodes) for (const dependency of String(node.dependencies || '').split(',').map(value => value.trim()).filter(Boolean)) {
    if (dependency === node.id || !ids.has(dependency)) throw new Error('roadmap_csv_invalid:dependency');
  }
  return nodes;
}

export function serializeRoadmapNodes(nodes: RoadmapNode[]): string {
  parseRoadmapCsv(Papa.unparse(nodes, { columns: roadmapCsvColumns }), { strictHeader: true });
  return Papa.unparse(nodes, { columns: roadmapCsvColumns });
}

export class CsvStore {
  constructor(private csvFilePath: string) {}

  /**
   * Reads and parses the roadmap.csv file.
   * If the file doesn't exist, returns an empty array.
   */
  public readNodes(): RoadmapNode[] {
    if (!fs.existsSync(this.csvFilePath)) {
      return [];
    }

    try {
      const fileContent = fs.readFileSync(this.csvFilePath, 'utf8');
      return parseRoadmapCsv(fileContent);
    } catch (error) {
      console.error('Failed to read nodes from CSV:', error);
      return [];
    }
  }

  /**
   * Writes the nodes back to roadmap.csv.
   */
  public writeNodes(nodes: RoadmapNode[]): void {
    try {
      const csvContent = serializeRoadmapNodes(nodes);

      fs.writeFileSync(this.csvFilePath, csvContent, 'utf8');
    } catch (error) {
      console.error('Failed to write nodes to CSV:', error);
      throw error;
    }
  }
}
