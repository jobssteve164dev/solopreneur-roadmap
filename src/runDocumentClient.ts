export interface RunDocumentPage {
  objectId: string;
  revision: number;
  bytes: string;
  hash: string;
  mimeType: string;
  byteOffset: number;
  totalBytes: number;
}

export async function readCompleteRunDocument(
  operation: (operation: string, input: Record<string, unknown>) => Promise<unknown>,
  input: Record<string, unknown>
): Promise<RunDocumentPage | null> {
  const buffers: Buffer[] = [];
  let offset = 0, first: RunDocumentPage | undefined;
  for (;;) {
    if (first && buffers.length >= Math.max(1, Math.ceil(first.totalBytes / 65536))) throw new Error('run_document_page_incomplete');
    const page = await operation('read_run_document', { ...input, offset, limit: 65536 }) as RunDocumentPage | null;
    if (!page) return null;
    if (!Number.isSafeInteger(page.totalBytes) || page.totalBytes < 0 || !Number.isSafeInteger(page.byteOffset) || page.byteOffset < 0
      || typeof page.bytes !== 'string' || typeof page.hash !== 'string') throw new Error('run_document_page_invalid');
    if (!first) first = page;
    if (page.objectId !== first.objectId || page.revision !== first.revision || page.hash !== first.hash
      || page.totalBytes !== first.totalBytes || page.byteOffset !== offset) throw new Error('run_document_snapshot_changed');
    const bytes = Buffer.from(page.bytes, 'base64');
    if (bytes.length > page.totalBytes - offset || (!bytes.length && offset < page.totalBytes)) throw new Error('run_document_page_invalid');
    if (bytes.length !== Math.min(65536, page.totalBytes - offset)) throw new Error('run_document_page_incomplete');
    buffers.push(bytes); offset += bytes.length;
    if (offset === page.totalBytes) return { ...first, byteOffset: 0, bytes: Buffer.concat(buffers).toString('base64') };
  }
}
