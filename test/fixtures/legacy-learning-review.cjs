"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readGithubApi = exports.reviewHash = void 0;
exports.projectGithubRepository = projectGithubRepository;
exports.collectGithubEvidence = collectGithubEvidence;
exports.legacyReviewSourceBody = legacyReviewSourceBody;
exports.registeredReviewSourceFiles = registeredReviewSourceFiles;
exports.collectReviewManifest = collectReviewManifest;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const childProcess = __importStar(require("child_process"));
const taskReport_js_1 = require("./legacy-task-report.cjs");
const growthReports_js_1 = require("../../out/growthReports.js");
const autonomousRuntimeControl_js_1 = require("../../out/autonomousRuntimeControl.js");
const reviewHash = (value) => crypto.createHash('sha256').update(value).digest('hex');
exports.reviewHash = reviewHash;
const readGithubApi = endpoint => new Promise((resolve, reject) => {
    childProcess.execFile('gh', ['api', '--method', 'GET', endpoint], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error) {
            reject(new Error(`GitHub read unavailable: ${endpoint.split('?')[0]}`));
            return;
        }
        try {
            resolve(JSON.parse(stdout));
        }
        catch {
            reject(new Error('GitHub returned invalid JSON'));
        }
    });
});
exports.readGithubApi = readGithubApi;
async function projectGithubRepository(projectPath) {
    return new Promise(resolve => childProcess.execFile('git', ['remote', 'get-url', 'origin'], { cwd: projectPath, encoding: 'utf8' }, (error, stdout) => {
        const match = !error && stdout.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
        resolve(match ? match[1] : '');
    }));
}
function taskTrailers(message, known) {
    const lastParagraph = message.trim().split(/\r?\n\s*\r?\n/).pop() || '';
    return [...new Set(lastParagraph.split(/\r?\n/).map(line => line.match(/^SoloMap-Task:\s*(task-[A-Za-z0-9-]+)\s*$/)?.[1] || '').filter(id => known.has(id)))];
}
const factRequests = new Map();
function collectGithubEvidence(input) {
    const scope = (0, exports.reviewHash)(input.tasks.map(task => task.taskId).sort().join('\n'));
    const key = `${input.globalDataPath || ''}:${input.projectPath}:${input.repository}:${scope}:${input.persist === false ? 'read-only' : 'persist'}`;
    const pending = factRequests.get(key);
    if (pending)
        return pending;
    const operation = collectGithubFacts(input, scope).finally(() => factRequests.delete(key));
    factRequests.set(key, operation);
    return operation;
}
async function collectGithubFacts(input, scope) {
    const { repository, tasks, reports } = input;
    const persist = input.persist !== false;
    const result = { repository, commits: [], gaps: [] };
    if (!repository) {
        result.gaps.push('No GitHub origin; only local reports are available.');
        return result;
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
        throw new Error('Invalid GitHub repository');
    const api = input.api || exports.readGithubApi;
    const known = new Set(tasks.map(task => task.taskId));
    const root = path.join(input.projectPath, '.solopreneur', 'agent-runs', 'learning-evidence');
    const cursorFile = path.join(root, `${(0, exports.reviewHash)(repository)}-${scope}.json`);
    const factsFile = path.join(root, `${(0, exports.reviewHash)(repository)}.facts.json`);
    const loadFacts = async () => input.globalDataPath
        ? (0, autonomousRuntimeControl_js_1.sendRuntimeDataRequest)(input.globalDataPath, { operation: 'read_github_facts', input: { root: input.projectPath, repository } })
        : { revision: 0, facts: (0, taskReport_js_1.readLearningJson)(factsFile) };
    const previous = persist ? (await loadFacts()).facts : undefined;
    const cursorKey = `github-cursor:${repository}:${scope}`;
    const loadCursor = async () => (await (0, autonomousRuntimeControl_js_1.sendRuntimeDataRequest)(input.globalDataPath, { operation: 'read_growth_report_projection', input: { root: input.projectPath, prefix: cursorKey } })).find(row => row.key === cursorKey);
    const nativeCursor = input.globalDataPath && persist ? await loadCursor() : undefined;
    let cursorRevision = nativeCursor?.revision || 0;
    let cursorSuperseded = false;
    const cursor = (persist ? input.globalDataPath ? nativeCursor?.value : (0, taskReport_js_1.readLearningJson)(cursorFile) : undefined) || { discovered: {}, coveredHead: '', page: 1, scanHead: '' };
    const saveCursor = async (value) => {
        if (!persist)
            return;
        if (!input.globalDataPath) {
            (0, taskReport_js_1.writeLearningJson)(cursorFile, value);
            return;
        }
        for (;;) {
            if (cursorSuperseded) {
                const latest = await loadCursor();
                cursorRevision = latest?.revision || 0;
                const discovered = { ...value.discovered };
                for (const [sha, taskIds] of Object.entries(latest?.value.discovered || {}))
                    discovered[sha] = [...new Set([...(discovered[sha] || []), ...taskIds])];
                // Once superseded, later pages also preserve the other window's committed position.
                value = { ...(latest?.value || value), discovered };
            }
            try {
                const receipt = await (0, autonomousRuntimeControl_js_1.sendRuntimeDataRequest)(input.globalDataPath, { operation: 'write_growth_report_projection', input: { root: input.projectPath, updates: [{ key: cursorKey, value, expectedRevision: cursorRevision }] } });
                cursorRevision = receipt.revisions.find(row => row.key === cursorKey).revision;
                return;
            }
            catch (error) {
                if (!String(error).includes('revision_conflict'))
                    throw error;
                cursorSuperseded = true;
            }
        }
    };
    const discovered = cursor.discovered || {};
    const since = tasks.map(task => task.startedAt).filter(Boolean).sort()[0];
    if (known.size && since) {
        let page = cursor.page || 1;
        let scanHead = cursor.scanHead || '';
        let boundaryFound = false;
        try {
            while (true) {
                const query = `per_page=100&page=${page}&since=${encodeURIComponent(since)}${scanHead ? `&sha=${scanHead}` : ''}`;
                const commits = await api(`repos/${repository}/commits?${query}`);
                if (!Array.isArray(commits))
                    throw new Error('Invalid commit list');
                if (!scanHead && commits[0])
                    scanHead = commits[0].sha;
                for (const commit of commits) {
                    if (commit.sha === cursor.coveredHead) {
                        boundaryFound = true;
                        break;
                    }
                    if (!/^[a-f0-9]{40}$/.test(commit.sha))
                        throw new Error('Invalid commit SHA');
                    const ids = taskTrailers(String(commit.commit?.message || ''), known);
                    if (ids.length)
                        discovered[commit.sha] = [...new Set([...(discovered[commit.sha] || []), ...ids])];
                }
                if (boundaryFound || commits.length < 100) {
                    if (cursor.coveredHead && !boundaryFound)
                        result.gaps.push('Previous commit boundary was not found; history may have changed.');
                    await saveCursor({ discovered, coveredHead: !cursor.coveredHead || boundaryFound ? scanHead : cursor.coveredHead, scanHead: '', page: 1 });
                    break;
                }
                page += 1;
                await saveCursor({ discovered, coveredHead: cursor.coveredHead, scanHead, page });
            }
        }
        catch (error) {
            await saveCursor({ discovered, coveredHead: cursor.coveredHead, scanHead, page });
            result.gaps.push(String(error.message));
        }
    }
    for (const report of reports) {
        if (!known.has(report.taskId))
            continue;
        for (const commit of report.report?.commits || []) {
            if (commit.repository !== repository) {
                result.gaps.push('A reported commit belongs to a different repository.');
                continue;
            }
            if (/^[a-f0-9]{40}$/.test(commit.sha))
                discovered[commit.sha] = [...new Set([...(discovered[commit.sha] || []), report.taskId])];
        }
    }
    for (const [sha, ids] of Object.entries(discovered)) {
        const taskIds = ids.filter(id => known.has(id));
        if (!taskIds.length)
            continue;
        const evidence = { sha, repository, taskIds, observedAt: new Date().toISOString(), reportMissing: !reports.some(report => taskIds.includes(report.taskId) && report.report?.commits?.some((commit) => commit.sha === sha && commit.repository === repository)), files: [], checks: [], statuses: [], gaps: [] };
        try {
            let page = 1;
            while (true) {
                const commit = await api(`repos/${repository}/commits/${sha}?per_page=100&page=${page}`);
                if (commit.sha !== sha || !Array.isArray(commit.files))
                    throw new Error('Commit response does not match requested SHA');
                evidence.message = String(commit.commit?.message || '');
                evidence.files.push(...commit.files);
                if (commit.files.length < 100)
                    break;
                if (evidence.files.length >= 3000) {
                    evidence.gaps.push('GitHub commit file limit reached; diff may be incomplete.');
                    break;
                }
                page += 1;
            }
            evidence.remoteExists = true;
            evidence.commitObservedAt = evidence.observedAt;
            const trailerParagraph = evidence.message.trim().split(/\r?\n\s*\r?\n/).pop() || '';
            evidence.commitTaskIds = [...new Set(trailerParagraph.split(/\r?\n/).map((line) => line.match(/^SoloMap-Task:\s*(task-[A-Za-z0-9-]+)\s*$/)?.[1]).filter(Boolean))];
            evidence.diffComplete = evidence.gaps.length === 0 && evidence.files.every((file) => typeof file.patch === 'string' || file.changes === 0);
            if (!evidence.diffComplete)
                evidence.gaps.push('Some file patches are unavailable; inspect original artifacts before confirming their behavior.');
            const associatedReports = reports.filter(report => taskIds.includes(report.taskId)).flatMap(report => (report.report?.commits || []).filter((commit) => commit.sha === sha && commit.repository === repository).map((commit) => ({ taskId: report.taskId, files: commit.files })));
            evidence.reportedScopes = associatedReports;
            if (taskIds.length > 1 && taskIds.some(taskId => !associatedReports.some(scope => scope.taskId === taskId && scope.files.length)))
                evidence.gaps.push('Shared commit lacks per-task file scope; do not attribute its entire diff to each task.');
        }
        catch (error) {
            evidence.gaps.push(String(error.message));
        }
        try {
            for (let page = 1;; page += 1) {
                const checks = await api(`repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`);
                if (!Array.isArray(checks.check_runs) || checks.check_runs.some((run) => run.head_sha !== sha))
                    throw new Error('Check runs do not match requested SHA');
                evidence.checks.push(...checks.check_runs);
                if (checks.check_runs.length < 100)
                    break;
            }
            evidence.checksObservedAt = evidence.observedAt;
        }
        catch (error) {
            evidence.gaps.push(String(error.message));
        }
        try {
            for (let page = 1;; page += 1) {
                const statuses = await api(`repos/${repository}/commits/${sha}/status?per_page=100&page=${page}`);
                if (statuses.sha !== sha || !Array.isArray(statuses.statuses))
                    throw new Error('Statuses do not match requested SHA');
                evidence.statuses.push(...statuses.statuses);
                if (statuses.statuses.length < 100)
                    break;
            }
            evidence.statusesObservedAt = evidence.observedAt;
        }
        catch (error) {
            evidence.gaps.push(String(error.message));
        }
        const old = previous?.commits?.find((item) => item.sha === sha && item.repository === repository);
        for (const [timeKey, fields] of [
            ['commitObservedAt', ['files', 'message', 'remoteExists', 'diffComplete', 'reportedScopes']],
            ['checksObservedAt', ['checks']], ['statusesObservedAt', ['statuses']]
        ]) {
            if (!evidence[timeKey] && old?.[timeKey]) {
                evidence[timeKey] = old[timeKey];
                for (const field of fields)
                    evidence[field] = old[field];
            }
        }
        result.commits.push(evidence);
    }
    // Read again at publication: another task scope may have completed while this request awaited GitHub.
    if (!persist)
        return result;
    for (;;) {
        const state = await loadFacts();
        const latest = state.facts;
        const merged = new Map((latest?.commits || []).map((commit) => [commit.sha, commit]));
        for (const commit of result.commits) {
            const old = merged.get(commit.sha);
            const combined = { ...commit, taskIds: [...new Set([...(old?.taskIds || []), ...commit.taskIds])] };
            const scopes = new Map([...(old?.reportedScopes || []), ...(commit.reportedScopes || [])].map((scope) => [`${scope.taskId}:${JSON.stringify(scope.files)}`, scope]));
            combined.reportedScopes = [...scopes.values()];
            for (const [timeKey, fields] of [['commitObservedAt', ['files', 'message', 'remoteExists', 'diffComplete']], ['checksObservedAt', ['checks']], ['statusesObservedAt', ['statuses']]]) {
                if (old?.[timeKey] && (!combined[timeKey] || old[timeKey] > combined[timeKey])) {
                    combined[timeKey] = old[timeKey];
                    for (const field of fields)
                        combined[field] = old[field];
                }
            }
            merged.set(commit.sha, combined);
        }
        const facts = { schemaVersion: 1, repository, observedAt: new Date().toISOString(), commits: [...merged.values()], gaps: result.gaps };
        const summary = {
            schemaVersion: 1, repository, observedAt: new Date().toISOString(), gaps: result.gaps,
            commits: [...merged.values()].map(({ message, files, checks, statuses, ...commit }) => ({
                ...commit, files: (files || []).map((file) => ({ filename: file.filename, status: file.status, previous_filename: file.previous_filename })),
                checks: (checks || []).map((check) => ({ id: check.id, head_sha: check.head_sha, name: check.name, status: check.status, conclusion: check.conclusion, html_url: check.html_url })),
                statuses: (statuses || []).map((status) => ({ id: status.id, context: status.context, state: status.state, target_url: status.target_url }))
            }))
        };
        if (input.globalDataPath) {
            try {
                await (0, autonomousRuntimeControl_js_1.sendRuntimeDataRequest)(input.globalDataPath, { operation: 'write_github_facts', input: { root: input.projectPath, repository, expectedRevision: state.revision, facts, summary } });
            }
            catch (error) {
                if (String(error).includes('revision_conflict'))
                    continue;
                throw error;
            }
        }
        else {
            (0, taskReport_js_1.writeLearningJson)(factsFile, facts);
            (0, taskReport_js_1.writeLearningJson)(factsFile.replace('.facts.json', '.summary.json'), summary);
        }
        break;
    }
    return result;
}
/** Old fact hashes identify semantic versions; contentHash identifies the complete transport bytes. */
function legacyReviewSourceBody(source) {
    if (!source || typeof source.id !== 'string' || !source.id || source.id.includes(':') || typeof source.kind !== 'string'
        || !/^[a-f0-9]{64}$/.test(source.hash || '') || (source.previousVersions !== undefined && !Array.isArray(source.previousVersions)))
        throw new Error('legacy_review_source_invalid');
    const value = source.value;
    if (source.kind === 'github') {
        const { observedAt, ...stable } = value || {};
        if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository || '') || !/^[a-f0-9]{40}$/.test(value.sha || '')
            || source.id !== `github-${(0, exports.reviewHash)(`${value.repository}:${value.sha}`).slice(0, 24)}` || source.hash !== (0, exports.reviewHash)(JSON.stringify(stable)))
            throw new Error('legacy_review_source_invalid');
        const body = JSON.stringify(value);
        if (source.content !== undefined && source.content !== body)
            throw new Error('legacy_review_source_invalid');
        return body;
    }
    if (source.kind === 'deleted_source') {
        if (!value || typeof value.file !== 'string' || !value.file || typeof value.previousKind !== 'string' || !value.previousKind
            || !/^[a-f0-9]{64}$/.test(value.previousHash || '') || (0, exports.reviewHash)(JSON.stringify(value)) !== source.hash)
            throw new Error('legacy_review_source_invalid');
        if (source.content === undefined && value.contentUnavailable === true)
            return JSON.stringify(value);
        if (typeof source.content !== 'string' || (0, exports.reviewHash)(source.content) !== value.previousHash || value.contentUnavailable === true)
            throw new Error('legacy_review_source_invalid');
        return source.content;
    }
    if (typeof source.content !== 'string' || (0, exports.reviewHash)(source.content) !== source.hash)
        throw new Error('legacy_review_source_invalid');
    return source.content;
}
function sameSourceVersion(source, stat) {
    return source?.size === stat.size && source?.mtimeMs === stat.mtimeMs && source?.ctimeMs === stat.ctimeMs
        && source?.dev === stat.dev && source?.ino === stat.ino;
}
function registeredReviewSourceFiles(project, previousSources = {}) {
    const taskRoot = (0, taskReport_js_1.learningTasksRoot)(project);
    const runsRoot = path.join(project, '.solopreneur', 'agent-runs');
    const tasks = [];
    const reports = [];
    const revokedReports = [];
    const reportRegistrations = {};
    const parsedTasks = new Map();
    const safe = (file, directory = false) => {
        try {
            const relative = path.relative(project, path.resolve(file));
            if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
                return false;
            let current = project;
            for (const part of relative.split(path.sep)) {
                current = path.join(current, part);
                if (fs.lstatSync(current).isSymbolicLink())
                    return false;
            }
            return directory ? fs.statSync(current).isDirectory() : fs.statSync(current).isFile();
        }
        catch {
            return false;
        }
    };
    const previous = (file, kind) => previousSources[`source-${(0, exports.reviewHash)(`${file}:${kind}`).slice(0, 24)}`];
    const readTask = (taskId) => {
        if (parsedTasks.has(taskId))
            return parsedTasks.get(taskId);
        const file = path.join(taskRoot, `${taskId}.json`);
        let task;
        try {
            task = JSON.parse(fs.readFileSync(file, 'utf8'));
        }
        catch {
            task = undefined;
        }
        const valid = task?.schemaVersion === 1 && task.projectPath === project && task.taskId === taskId && Array.isArray(task.executions)
            ? task : undefined;
        parsedTasks.set(taskId, valid);
        return valid;
    };
    if (fs.existsSync(taskRoot))
        for (const entry of fs.readdirSync(taskRoot, { withFileTypes: true })) {
            if (!entry.isFile() || !/^task-[A-Za-z0-9-]+\.json$/.test(entry.name))
                continue;
            const file = path.join(taskRoot, entry.name);
            if (!safe(file))
                continue;
            const taskId = entry.name.slice(0, -5);
            const old = previous(file, 'task');
            if (old && sameSourceVersion(old, fs.statSync(file)))
                tasks.push(file);
            else if (readTask(taskId))
                tasks.push(file);
        }
    const reportCandidates = [];
    if (fs.existsSync(runsRoot))
        for (const first of fs.readdirSync(runsRoot, { withFileTypes: true })) {
            if (!first.isDirectory() || first.isSymbolicLink())
                continue;
            const firstPath = path.join(runsRoot, first.name);
            for (const second of fs.readdirSync(firstPath, { withFileTypes: true })) {
                const secondPath = path.join(firstPath, second.name);
                if (second.isFile() && /^task-report-\d+\.json$/.test(second.name))
                    reportCandidates.push(secondPath);
                if (!second.isDirectory() || second.isSymbolicLink())
                    continue;
                for (const third of fs.readdirSync(secondPath, { withFileTypes: true }))
                    if (third.isFile() && /^task-report-\d+\.json$/.test(third.name))
                        reportCandidates.push(path.join(secondPath, third.name));
            }
        }
    for (const file of reportCandidates) {
        if (!safe(file))
            continue;
        const old = previous(file, 'agent_report');
        if (old && sameSourceVersion(old, fs.statSync(file))) {
            const registration = old.value?.registration;
            if (registration && typeof registration.taskId === 'string') {
                const taskFile = path.join(taskRoot, `${registration.taskId}.json`);
                const oldTask = previous(taskFile, 'task');
                if (safe(taskFile) && oldTask && sameSourceVersion(oldTask, fs.statSync(taskFile))) {
                    reports.push(file);
                    reportRegistrations[file] = registration;
                    continue;
                }
            }
        }
        let envelope;
        try {
            envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
        }
        catch {
            if (old)
                revokedReports.push(file);
            continue;
        }
        const sequence = Number(path.basename(file).match(/\d+/)?.[0]);
        const task = readTask(envelope?.taskId);
        const execution = task?.executions?.find((run) => run?.id === envelope?.executionLogId && path.resolve(run.runDir) === path.dirname(file)
            && safe(run.runDir, true));
        if (execution && envelope.projectPath === project && envelope.turnId === `${sequence}:complete`
            && envelope.report && typeof envelope.report === 'object' && typeof envelope.report.summary === 'string') {
            reports.push(file);
            reportRegistrations[file] = { taskId: envelope.taskId, executionLogId: envelope.executionLogId, runDir: path.dirname(file), turnId: envelope.turnId };
        }
        else if (old)
            revokedReports.push(file);
    }
    return { tasks, reports, revokedReports, reportRegistrations };
}
async function collectReviewManifest(input) {
    const manifest = { schemaVersion: 1, runId: input.runId, globalRoot: input.globalRoot, globalPrompt: input.globalPrompt, promptHash: (0, exports.reviewHash)(input.globalPrompt), projects: input.projects, sources: [], memory: [], gaps: [], ...(input.incremental ? { cursorUpdates: [] } : {}) };
    const safeFile = (root, file) => {
        try {
            const relative = path.relative(path.resolve(root), path.resolve(file));
            if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
                return false;
            let current = path.resolve(root);
            for (const part of relative.split(path.sep)) {
                current = path.join(current, part);
                if (fs.lstatSync(current).isSymbolicLink())
                    return false;
            }
            return fs.statSync(current).isFile();
        }
        catch {
            return false;
        }
    };
    const deferred = new Set(input.deferredSourceIds || []);
    const addFile = (file, kind, projectPath) => {
        if (manifest.sources.some(source => source.file === file && source.kind === kind))
            return undefined;
        const id = `source-${(0, exports.reviewHash)(`${file}:${kind}`).slice(0, 24)}`;
        const stat = fs.statSync(file);
        const previous = input.previousSources?.[id];
        if (input.incremental && !deferred.has(id) && previous && typeof previous === 'object'
            && previous.file === file && previous.kind === kind && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs
            && previous.ctimeMs === stat.ctimeMs && previous.dev === stat.dev && previous.ino === stat.ino)
            return undefined;
        const content = fs.readFileSync(file, 'utf8');
        const hash = (0, exports.reviewHash)(content);
        const previousHash = typeof previous === 'string' ? previous : previous?.hash;
        if (input.incremental && !deferred.has(id) && previousHash === hash) {
            manifest.cursorUpdates.push({ id, kind, projectPath, file, hash, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino });
            return undefined;
        }
        manifest.sources.push({ id, kind, projectPath, file, hash, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino, content });
        return content;
    };
    const addDirectoryFiles = (root, directory, kind, projectPath, pattern = /\.json$/) => {
        if (!fs.existsSync(directory))
            return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isFile() && pattern.test(entry.name) && safeFile(root, file))
                addFile(file, kind, projectPath);
        }
    };
    const promptMirror = path.join(input.globalRoot, 'context', 'global-default-prompt.md');
    if (safeFile(input.globalRoot, promptMirror))
        addFile(promptMirror, 'global_prompt_mirror');
    const sharedProjectRoot = path.dirname(input.globalRoot);
    const globalConstraintFile = path.join(sharedProjectRoot, 'agent.md');
    if (safeFile(sharedProjectRoot, globalConstraintFile))
        addFile(globalConstraintFile, 'global_constraint');
    for (const project of input.projects) {
        for (const name of ['agent.md', 'AGENTS.md']) {
            const file = path.join(project, name);
            if (file !== globalConstraintFile && safeFile(project, file))
                addFile(file, 'project_constraint', project);
        }
        const legacyProjectMemory = path.join(project, 'PROJECT_MEMORY.md');
        if (safeFile(project, legacyProjectMemory))
            addFile(legacyProjectMemory, 'project_memory_legacy', project);
        const documentationFile = path.join(project, '.solopreneur', 'documentation.json');
        if (safeFile(project, documentationFile)) {
            const documentationContent = addFile(documentationFile, 'project_document_index', project);
            const indexId = `source-${(0, exports.reviewHash)(`${documentationFile}:project_document_index`).slice(0, 24)}`;
            const oldIndex = input.previousSources?.[indexId];
            let activeDocumentPaths = Array.isArray(oldIndex?.value?.activeDocumentPaths) ? oldIndex.value.activeDocumentPaths : [];
            if (documentationContent !== undefined || !activeDocumentPaths.length) {
                let documentation = {};
                try {
                    documentation = JSON.parse(documentationContent ?? fs.readFileSync(documentationFile, 'utf8'));
                }
                catch {
                    documentation = {};
                }
                activeDocumentPaths = (Array.isArray(documentation?.documents) ? documentation.documents : [])
                    .filter((item) => item?.status === 'active' && typeof item.path === 'string').map((item) => path.resolve(project, item.path));
            }
            const indexSnapshot = [...manifest.sources, ...(manifest.cursorUpdates || [])].find(source => source.id === indexId);
            if (indexSnapshot)
                indexSnapshot.value = { activeDocumentPaths };
            for (const file of activeDocumentPaths)
                if (safeFile(project, file))
                    addFile(file, 'project_document', project);
        }
        addDirectoryFiles(project, path.join(project, '.solopreneur', 'run-digests'), 'run_digest', project);
        const taskRoot = (0, taskReport_js_1.learningTasksRoot)(project);
        let tasks = [];
        let reports = [];
        if (input.includeGithub === false) {
            const registered = registeredReviewSourceFiles(project, input.previousSources);
            for (const file of registered.tasks)
                addFile(file, 'task', project);
            for (const file of registered.reports) {
                addFile(file, 'agent_report', project);
                const id = `source-${(0, exports.reviewHash)(`${file}:agent_report`).slice(0, 24)}`;
                const snapshot = [...manifest.sources, ...(manifest.cursorUpdates || [])].find(source => source.id === id);
                const registration = registered.reportRegistrations[file] || input.previousSources?.[id]?.value?.registration;
                if (snapshot && registration)
                    snapshot.value = { registration };
            }
            for (const file of registered.revokedReports) {
                const id = `source-${(0, exports.reviewHash)(`${file}:agent_report`).slice(0, 24)}`;
                const previous = input.previousSources?.[id];
                const value = { file, previousHash: previous?.hash, previousKind: 'agent_report', registrationRevoked: true, ...(typeof previous?.content === 'string' ? {} : { contentUnavailable: true }) };
                manifest.sources.push({ id, kind: 'deleted_source', projectPath: project, hash: (0, exports.reviewHash)(JSON.stringify(value)), content: previous?.content, value });
            }
        }
        else {
            const registered = (0, growthReports_js_1.readRegisteredTaskSources)(project);
            tasks = registered.tasks;
            reports = registered.reports;
            for (const task of tasks) {
                addFile(path.join(taskRoot, `${task.taskId}.json`), 'task', project);
                for (const observation of registered.observations.filter(item => item.taskId === task.taskId && item.envelope))
                    addFile(observation.file, 'agent_report', project);
            }
        }
        if (input.includeGithub !== false)
            try {
                const repository = await (input.repositoryForProject || projectGithubRepository)(project);
                const evidence = await collectGithubEvidence({ projectPath: project, repository, tasks, reports, api: input.api });
                manifest.gaps.push(...evidence.gaps.map(gap => `${project}: ${gap}`));
                for (const commit of evidence.commits) {
                    const { observedAt, ...stableEvidence } = commit;
                    manifest.sources.push({ id: `github-${(0, exports.reviewHash)(`${repository}:${commit.sha}`).slice(0, 24)}`, kind: 'github', projectPath: project, hash: (0, exports.reviewHash)(JSON.stringify(stableEvidence)), value: commit });
                }
            }
            catch (error) {
                manifest.gaps.push(`${project}: ${error.message}`);
            }
    }
    const walkMemory = (dir) => {
        if (!fs.existsSync(dir))
            return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory())
                walkMemory(file);
            else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
                const content = addFile(file, 'memory');
                if (content !== undefined)
                    manifest.memory.push({ relativePath: path.relative(path.join(input.globalRoot, 'memory'), file).replace(/\\/g, '/'), hash: (0, exports.reviewHash)(content), content });
            }
        }
    };
    walkMemory(path.join(input.globalRoot, 'memory'));
    addDirectoryFiles(input.globalRoot, path.join(input.globalRoot, 'memory', 'entries'), 'memory_entry');
    for (const name of ['index.json', 'events.jsonl']) {
        const file = path.join(input.globalRoot, 'learning', 'ledger', name);
        if (safeFile(input.globalRoot, file))
            addFile(file, 'learning_ledger');
    }
    addDirectoryFiles(input.globalRoot, path.join(input.globalRoot, 'learning', 'ledger', 'sources'), 'learning_event_source');
    for (const dir of ['candidates', 'approved', 'rejected', 'promotion-suggestions', 'candidate-decisions']) {
        const root = path.join(input.globalRoot, 'learning', dir);
        if (!fs.existsSync(root))
            continue;
        if (input.incremental) {
            continue;
        }
        for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
            const file = path.join(root, name);
            const value = (0, taskReport_js_1.readLearningJson)(file);
            if (dir === 'candidate-decisions' && [1, 2].includes(value?.schemaVersion))
                addFile(file, `legacy_${dir}`);
            else if (value?.schemaVersion === 1 && input.projects.includes(value?.projectPath))
                addFile(file, `legacy_${dir}`, value.projectPath);
        }
    }
    manifest.sources = manifest.sources.filter(source => {
        if (input.incremental)
            return source.kind !== 'legacy_candidate-decisions';
        if (!input.incremental && (['memory', 'memory_entry', 'task', 'global_prompt_mirror', 'global_constraint', 'project_constraint', 'project_memory_legacy', 'project_document_index', 'project_document', 'run_digest', 'learning_ledger', 'learning_event_source'].includes(source.kind) || source.kind.startsWith('legacy_')))
            return true;
        const decision = (0, taskReport_js_1.readLearningJson)(path.join(input.globalRoot, 'learning', 'candidate-decisions', `semantic-${(0, exports.reviewHash)(`${source.id}:${source.hash}`)}.json`));
        return !(decision?.schemaVersion === 2 && decision.id === source.id && decision.hash === source.hash && ['created', 'skipped'].includes(decision.decision));
    });
    if (input.incremental) {
        const includedMemory = new Set(manifest.sources.filter(source => source.kind === 'memory' && source.file).map(source => path.resolve(source.file)));
        manifest.memory = manifest.memory.filter(item => includedMemory.has(path.resolve(input.globalRoot, 'memory', ...item.relativePath.split('/'))));
    }
    return manifest;
}
//# sourceMappingURL=learningReview.js.map
