import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export function runtimeBuildId(extensionPath: string): string {
  const root = path.join(extensionPath, 'out');
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(fullPath);
    }
  };
  visit(root);
  if (files.length === 0) throw new Error('SoloMap Runtime build files are missing.');
  const hash = crypto.createHash('sha256');
  for (const filePath of files.sort()) {
    hash.update(path.relative(root, filePath).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}
