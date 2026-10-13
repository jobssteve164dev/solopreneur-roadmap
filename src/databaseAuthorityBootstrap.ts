import * as fs from 'fs';
import * as path from 'path';

import { normalizeGlobalDataPathForExtension } from './projectRegistry';

export async function ensurePersistentRuntimeDatabaseAuthority(
  globalDataPath: string,
  ensureDatabase: (root: string) => Promise<unknown>,
  rememberAuthority: (root: string) => Promise<void>
): Promise<void> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  if (!fs.existsSync(path.join(root, 'solomap.db'))) await ensureDatabase(root);
  await rememberAuthority(root);
}
