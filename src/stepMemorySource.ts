export interface ParsedStepMemorySource {
  metadata: Record<string, unknown>;
  entries: unknown[];
}

/** The source bytes remain authoritative; this projection never clips entries. */
export function parseStepMemorySource(text: string, format: 'json' | 'md'): ParsedStepMemorySource {
  if (format === 'json') {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (Array.isArray(value)) return { metadata: {}, entries: value };
    if (!value || typeof value !== 'object') throw new Error('step_memory_source_invalid');
    const entries = (value as Record<string, unknown>).entries;
    if (entries !== undefined && entries !== null && !Array.isArray(entries)) throw new Error('step_memory_source_entries_invalid');
    return { metadata: Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'entries')), entries: Array.isArray(entries) ? entries : [] };
  }
  const headers = [...text.matchAll(/^##\s+([^\r\n]+?)\s+·\s+([^\r\n]+)\r?$/gm)];
  const entries = headers.map((header, index) => {
    const raw = text.slice(header.index!, headers[index + 1]?.index ?? text.length);
    const section = (name: string) => {
      const match = raw.match(new RegExp(`^### ${name}\\r?\\n([\\s\\S]*?)(?=^### |^---[\\t ]*\\r?$|(?![\\s\\S]))`, 'm'));
      return match ? match[1].trim() : '';
    };
    const files = section('本轮文件变化');
    return { timestamp: header[1].trim(), status: header[2].trim(), changedFiles: files ? files.split(/\r?\n/) : [], usefulSignals: section('本轮关键信号'), completionReason: section('完成判断'), raw };
  });
  return { metadata: {}, entries };
}
