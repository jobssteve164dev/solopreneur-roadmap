import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

export interface PastedImageAttachment {
  name?: string;
  mimeType?: string;
  dataUrl?: string;
}

export function normalizeSupplementFiles(files: unknown): string[] {
  if (!Array.isArray(files)) {
    return [];
  }
  return files
    .map((file) => String(file || '').trim())
    .filter(Boolean)
    .filter((file, index, all) => all.indexOf(file) === index)
    .slice(0, 10);
}

export function filterProjectRelativeFiles(workspaceRoot: string, files: string[]): string[] {
  return normalizeSupplementFiles(files).filter((relativePath) => {
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    const relativeToRoot = path.relative(workspaceRoot, absolutePath);
    return Boolean(relativeToRoot)
      && !relativeToRoot.startsWith('..')
      && !path.isAbsolute(relativeToRoot)
      && fs.existsSync(absolutePath)
      && fs.statSync(absolutePath).isFile();
  });
}

export function sanitizeAttachmentScope(scope: string): string {
  const normalized = String(scope || 'conversation')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'conversation';
}

function imageExtensionFromMimeType(mimeType: string): string {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  return 'png';
}

export function savePastedImageAttachments(projectRoot: string, scope: string, attachments: PastedImageAttachment[]): string[] {
  if (!projectRoot || !Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const safeScope = sanitizeAttachmentScope(scope);
  const targetDir = path.join(projectRoot, '.solopreneur', 'attachments', safeScope);
  fs.mkdirSync(targetDir, { recursive: true });

  return attachments.slice(0, 10).map((attachment, index) => {
    const dataUrl = String(attachment?.dataUrl || '');
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/);
    if (!match) {
      return '';
    }
    const mimeType = String(attachment.mimeType || match[1] || 'image/png').toLowerCase();
    if (!mimeType.startsWith('image/')) {
      return '';
    }
    const extension = imageExtensionFromMimeType(mimeType);
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const randomId = Math.random().toString(16).slice(2, 8);
    const fileName = `${timestamp}-${randomId}-${index + 1}.${extension}`;
    const filePath = path.join(targetDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(match[2].replace(/\s/g, ''), 'base64'));
    return path.relative(projectRoot, filePath).split(path.sep).join('/');
  }).filter(Boolean);
}

export async function savePastedImageAttachmentsAsync(
  projectRoot: string,
  scope: string,
  attachments: PastedImageAttachment[]
): Promise<string[]> {
  if (!projectRoot || !Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const safeScope = sanitizeAttachmentScope(scope);
  const targetDir = path.join(projectRoot, '.solopreneur', 'attachments', safeScope);
  await fs.promises.mkdir(targetDir, { recursive: true });
  const files = await Promise.all(attachments.slice(0, 10).map(async (attachment, index) => {
    const dataUrl = String(attachment?.dataUrl || '');
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/);
    if (!match) return '';
    const mimeType = String(attachment.mimeType || match[1] || 'image/png').toLowerCase();
    if (!mimeType.startsWith('image/')) return '';
    const extension = imageExtensionFromMimeType(mimeType);
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const randomId = Math.random().toString(16).slice(2, 8);
    const fileName = `${timestamp}-${randomId}-${index + 1}.${extension}`;
    const filePath = path.join(targetDir, fileName);
    await fs.promises.writeFile(filePath, Buffer.from(match[2].replace(/\s/g, ''), 'base64'));
    return path.relative(projectRoot, filePath).split(path.sep).join('/');
  }));
  return files.filter(Boolean);
}

export async function chooseSupplementFilesForProject(projectRoot: string): Promise<string[]> {
  const vscodeApi = require('vscode') as typeof vscode;
  const files = listProjectAttachmentCandidates(projectRoot);
  if (!files.length) {
    vscodeApi.window.showInformationMessage('当前项目里还没有可选择的补充文件。');
    return [];
  }

  const selected = await vscodeApi.window.showQuickPick(
    files.map((file) => ({
      label: file,
      description: path.dirname(file) === '.' ? '' : path.dirname(file)
    })),
    {
      canPickMany: true,
      matchOnDescription: true,
      placeHolder: '选择要附加给 Agent 的项目文件',
      title: '添加补充文件'
    }
  );

  return (selected || []).map((item) => item.label).slice(0, 10);
}

export function listProjectAttachmentCandidates(projectRoot: string): string[] {
  const fromGit = listProjectFilesFromGit(projectRoot);
  if (fromGit.length > 0) {
    return fromGit;
  }
  const fromRipgrep = listProjectFilesFromCommand('rg', ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!cache', '-g', '!.solopreneur/agent-runs'], projectRoot);
  if (fromRipgrep.length > 0) {
    return fromRipgrep;
  }
  return listProjectFilesByWalking(projectRoot);
}

function listProjectFilesFromGit(projectRoot: string): string[] {
  const files = listProjectFilesFromCommand('git', ['-C', projectRoot, 'ls-files', '--cached', '--others', '--exclude-standard'], projectRoot);
  return files.filter((file) => !file.startsWith('.solopreneur/agent-runs/'));
}

function listProjectFilesFromCommand(command: string, args: string[], projectRoot: string): string[] {
  try {
    const output = childProcess.execFileSync(command, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
      maxBuffer: 1024 * 1024
    });
    return normalizeAttachmentCandidateFiles(projectRoot, output.split(/\r?\n/));
  } catch {
    return [];
  }
}

function listProjectFilesByWalking(projectRoot: string): string[] {
  const results: string[] = [];
  const skip = new Set(['.git', 'node_modules', 'cache']);
  const walk = (directory: string) => {
    if (results.length >= 1500) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 1500) {
        return;
      }
      if (skip.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join('/');
      if (relativePath.startsWith('.solopreneur/agent-runs/')) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  };
  walk(projectRoot);
  return normalizeAttachmentCandidateFiles(projectRoot, results);
}

function normalizeAttachmentCandidateFiles(projectRoot: string, files: string[]): string[] {
  const seen = new Set<string>();
  return files
    .map((file) => String(file || '').trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((file) => {
      if (seen.has(file)) {
        return false;
      }
      seen.add(file);
      const absolutePath = path.resolve(projectRoot, file);
      const relativeToRoot = path.relative(projectRoot, absolutePath);
      return Boolean(relativeToRoot)
        && !relativeToRoot.startsWith('..')
        && !path.isAbsolute(relativeToRoot)
        && fs.existsSync(absolutePath)
        && fs.statSync(absolutePath).isFile();
    })
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 1500);
}
