import * as fs from 'fs';
import * as path from 'path';
import { collectReviewManifest, GithubRead, reviewHash } from './learningReview.js';
import { applyLearningReview, buildLearningReviewPrompt, buildLearningReviewCheckPrompt } from './learningReviewApply.js';
import { readLearningJson, writeLearningJson } from './taskReport.js';

const activeReviews = new Map<string, Promise<{ status: 'applied' | 'partial'; errors: string[] }>>();

export function runManualLearningReview(input: {
  runDir: string; globalRoot: string; projects: string[]; globalPrompt: string; persistedGlobalPrompt?: string;
  getGlobalPrompt: () => string; setGlobalPrompt: (value: string, expectedHash: string) => Promise<void>;
  launch: (promptFile: string, resultFile: string) => Promise<void>; api?: GithubRead;
}): Promise<{ status: 'applied' | 'partial'; errors: string[] }> {
  const key = path.resolve(input.globalRoot);
  const existing = activeReviews.get(key);
  if (existing) return existing;
  const operation = Promise.resolve().then(async () => {
    const runId = path.basename(input.runDir);
    const runsRoot = path.dirname(input.runDir);
    const pendingRuns = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(runsRoot, entry.name)).sort().reverse() : [];
    for (const previousDir of pendingRuns) {
      const journal = readLearningJson(path.join(previousDir, 'application.json'));
      if (!journal || !['partial', 'applying'].includes(journal.status)) continue;
      const previous = readLearningJson(path.join(previousDir, 'manifest.json'));
      const result = readLearningJson(path.join(previousDir, 'result.json'));
      if (previous?.globalRoot !== input.globalRoot || !previous.projects.every((project: string) => input.projects.includes(project))) continue;
      const proposalFile = result?.proposalFile;
      const checkFile = result?.checkFile;
      if (!proposalFile || !checkFile || path.dirname(proposalFile) !== previousDir || path.dirname(checkFile) !== previousDir) continue;
      if (input.globalPrompt !== previous.globalPrompt && reviewHash(input.globalPrompt) !== (journal.items.globalPrompt || journal.pending?.globalPrompt)) {
        writeLearningJson(path.join(previousDir, 'application.json'), { ...journal, status: 'superseded', reason: 'User edited the current instruction draft.' });
        continue;
      }
      try {
        return await applyLearningReview({ ...input, runDir: previousDir, manifest: previous, proposal: readLearningJson(proposalFile), review: readLearningJson(checkFile) });
      } catch (error: any) {
        // A newer user edit makes the saved proposal stale. Preserve its history
        // and collect fresh inputs in this explicitly requested review.
        writeLearningJson(path.join(previousDir, 'application.json'), { ...journal, status: 'superseded', reason: String(error.message) });
      }
    }
    fs.mkdirSync(input.runDir, { recursive: true });
    const manifest = await collectReviewManifest({ runId, globalRoot: input.globalRoot, globalPrompt: input.globalPrompt, projects: input.projects, api: input.api });
    manifest.persistedPromptHash = reviewHash(input.persistedGlobalPrompt ?? input.globalPrompt);
    const manifestFile = path.join(input.runDir, 'manifest.json');
    writeLearningJson(manifestFile, manifest);
    writeLearningJson(path.join(input.runDir, 'context-index.json'), {
      runId, manifestHash: reviewHash(JSON.stringify(manifest)), gaps: manifest.gaps,
      sources: manifest.sources.map(({ id, kind, file, hash, projectPath, value }) => ({ id, kind, file, hash, projectPath, ...(value ? { repository: value.repository, sha: value.sha, gaps: value.gaps } : {}) })),
      memory: manifest.memory.map(({ relativePath, hash }) => ({ relativePath, hash })),
      constraints: manifest.globalPrompt.split('\n').filter(line => line.trim())
    });
    let feedback = '';
    for (let attempt = 1; ; attempt += 1) {
      const proposalFile = path.join(input.runDir, `proposal-${attempt}.json`);
      const promptFile = path.join(input.runDir, `prompt-${attempt}.txt`);
      fs.writeFileSync(promptFile, buildLearningReviewPrompt(manifestFile, manifest, proposalFile) + feedback, 'utf8');
      await input.launch(promptFile, proposalFile);
      const proposal = readLearningJson(proposalFile);
      if (!proposal) throw new Error('复盘未生成完整结果，材料已保留。');
      const checkFile = path.join(input.runDir, `review-${attempt}.json`);
      const checkPrompt = path.join(input.runDir, `review-prompt-${attempt}.txt`);
      fs.writeFileSync(checkPrompt, buildLearningReviewCheckPrompt(manifestFile, proposalFile, manifest, proposal, checkFile), 'utf8');
      await input.launch(checkPrompt, checkFile);
      const review = readLearningJson(checkFile);
      if (!review) throw new Error('复盘复核未生成完整结果，材料已保留。');
      if (review.verdict === 'revise') {
        feedback = `\n上一版未通过独立复核。读取 ${checkFile} 和 ${proposalFile}，按证据修正；无法证实的判断保留 deferred 或 unresolved，不编造证据。`;
        continue;
      }
      writeLearningJson(path.join(input.runDir, 'result.json'), { proposalFile, checkFile });
      return applyLearningReview({ ...input, manifest, proposal, review });
    }
  }).finally(() => { activeReviews.delete(key); });
  activeReviews.set(key, operation);
  return operation;
}

export function buildLearningReviewRunScript(command: string, cwd: string, output: string, done: string, quote: (value: string) => string): string {
  const finish = 'const fs=require("fs");const file=process.argv[1];const tmp=file+"."+process.pid+".tmp";fs.writeFileSync(tmp,JSON.stringify({exitCode:Number(process.argv[2])}));fs.renameSync(tmp,file);';
  return [
    '#!/usr/bin/env bash',
    'set +e',
    `trap ${quote(`solomap_review_exit=$?; trap - EXIT; node -e ${quote(finish)} ${quote(done)} "$solomap_review_exit"`)} EXIT`,
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    `cd ${quote(cwd)} || exit 1`,
    `( ${command} ) 2>&1 | tee ${quote(output)}`,
    'solomap_review_exit=${PIPESTATUS[0]}',
    'exit "$solomap_review_exit"',
    ''
  ].join('\n');
}
