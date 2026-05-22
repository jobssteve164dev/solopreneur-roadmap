import * as fs from 'fs';
import * as Papa from 'papaparse';
import { RoadmapNode } from './types';

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
      const parseResult = Papa.parse<RoadmapNode>(fileContent, {
        header: true,
        skipEmptyLines: true,
      });

      if (parseResult.errors.length > 0) {
        console.warn('CSV parsing encountered some issues:', parseResult.errors);
      }

      return parseResult.data.map(node => ({
        ...node,
        // Ensure status defaults to Pending if empty
        status: node.status || 'Pending',
        dependencies: node.dependencies || '',
      }));
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
      const csvContent = Papa.unparse(nodes, {
        columns: [
          'id',
          'title',
          'description',
          'stage',
          'dependencies',
          'agentCli',
          'agentPrompt',
          'status',
          'createdAt',
          'completedAt'
        ]
      });

      fs.writeFileSync(this.csvFilePath, csvContent, 'utf8');
    } catch (error) {
      console.error('Failed to write nodes to CSV:', error);
      throw error;
    }
  }
}
