const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const loaderPath = path.resolve(__dirname, '../out/sidebarProjectLoader.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function loadLoader(overrides = {}) {
  delete require.cache[loaderPath];
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === loaderPath && request === './projectExternalSignals') {
      return {
        loadExternalIssueSummary: async () => ({}),
        loadExternalPullRequestSummary: async () => ({}),
        loadExternalDeliverySummary: async () => ({}),
        loadExternalSecuritySummary: async () => ({}),
        readCachedExternalSignals: async () => null,
        resolveGithubRepoSlug: async projectPath => `owner/${path.basename(projectPath)}`,
        ...overrides.signals
      };
    }
    if (parent?.filename === loaderPath && request === './projectAnalytics') {
      return { readProjectInvestmentStatsFromDatabase: overrides.investment || (async () => ({})) };
    }
    if (parent?.filename === loaderPath && request === './learningLedger') {
      return { readLearningOverview: async () => ({ eventCount: 0, candidateCount: 0, candidateDecisionCount: 0, skippedCandidateDecisionCount: 0, approvedCount: 0, promotedCount: 0, projectSignals: [] }) };
    }
    if (parent?.filename === loaderPath && request === './autonomousRuntimeControl') {
      return { sendRuntimeDataRequest: async (_root, request) => {
        if (overrides.runtime) return overrides.runtime(_root, request);
        if (request.operation === 'resolve_project_repository') {
          const resolve = overrides.signals?.resolveGithubRepoSlug || (async projectPath => `owner/${path.basename(projectPath)}`);
          return { repo: await resolve(request.input.root) };
        }
        if (request.operation === 'refresh_project_signal') {
          const loaders = {
            issues: overrides.signals?.loadExternalIssueSummary,
            pullRequests: overrides.signals?.loadExternalPullRequestSummary,
            delivery: overrides.signals?.loadExternalDeliverySummary,
            security: overrides.signals?.loadExternalSecuritySummary
          };
          const load = loaders[request.input.kind] || (async () => ({}));
          return { repo: request.input.repo, value: await load(request.input.root, {
            globalDataPath: _root,
            repo: request.input.repo,
            force: request.input.force
          }) };
        }
        assert.fail(`unexpected operation: ${request.operation}`);
      } };
    }
    if (parent?.filename === loaderPath && request === './projectPortfolio') {
      return { buildProjectPortfolioSummary: project => ({ path: project.path, name: project.name }) };
    }
    return original.apply(this, arguments);
  };
  try { return require(loaderPath).SidebarProjectLoader; }
  finally { Module._load = original; }
}

function createLoader(Loader, posted, options = {}) {
  return new Loader({
    isAvailable: () => true,
    postMessage: message => posted.push(message),
    getGlobalDataPath: options.getGlobalDataPath || (() => '/tmp/solomap-loader-test')
  });
}

test('the external loader exposes no compatibility portfolio publishing path', () => {
  const Loader = loadLoader();
  const loader = createLoader(Loader, []);
  assert.equal(loader.scheduleAll, undefined);
  assert.equal(loader.schedulePortfolioEnrichment, undefined);
});

test('invalidating one project issue load rejects its old response but keeps another project', async () => {
  const alpha = deferred();
  const beta = deferred();
  const Loader = loadLoader({ signals: { loadExternalIssueSummary: projectPath => projectPath === '/alpha' ? alpha.promise : beta.promise } });
  const posted = [];
  const loader = createLoader(Loader, posted);
  loader.scheduleIssueLoads([{ name: 'Alpha', path: '/alpha' }, { name: 'Beta', path: '/beta' }], '/alpha');
  await new Promise(resolve => setTimeout(resolve, 1320));
  loader.invalidateProjectSignals('/alpha', ['issues']);
  alpha.resolve({ openCount: 2 });
  beta.resolve({ openCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(posted.filter(message => message.command === 'projectIssuesLoaded').map(message => message.projectPath), ['/beta']);
});

test('invalidating one project pull request load leaves another project in flight', async () => {
  const alpha = deferred();
  const beta = deferred();
  const Loader = loadLoader({ signals: { loadExternalPullRequestSummary: projectPath => projectPath === '/alpha' ? alpha.promise : beta.promise } });
  const posted = [];
  const loader = createLoader(Loader, posted);
  loader.schedulePullRequestLoads([{ name: 'Alpha', path: '/alpha' }, { name: 'Beta', path: '/beta' }], '/alpha');
  await new Promise(resolve => setTimeout(resolve, 1420));
  loader.invalidateProjectSignals('/alpha', ['pullRequests']);
  alpha.resolve({ openCount: 2 });
  beta.resolve({ openCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(posted.filter(message => message.command === 'projectPullRequestsLoaded').map(message => message.projectPath), ['/beta']);
});

test('the loader never replays cached database signals outside the sidebar projection', async () => {
  let cachedReads = 0;
  const Loader = loadLoader({ signals: { readCachedExternalSignals: async () => { cachedReads += 1; return null; } } });
  const loader = createLoader(Loader, []);
  loader.scheduleExternalSignals([{ name: 'Alpha', path: '/alpha' }], '/alpha');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(cachedReads, 0);
});

test('background signal scheduling limits repository work to two projects at a time', async () => {
  let active = 0;
  let maximum = 0;
  const pending = [];
  const Loader = loadLoader({ signals: {
    resolveGithubRepoSlug: projectPath => new Promise(resolve => {
      active += 1;
      maximum = Math.max(maximum, active);
      pending.push(() => {
        active -= 1;
        resolve(`owner/${path.basename(projectPath)}`);
      });
    }),
    readCachedExternalSignals: async () => null
  } });
  const loader = createLoader(Loader, []);
  loader.scheduleExternalSignals([
    { name: 'Alpha', path: '/alpha' },
    { name: 'Beta', path: '/beta' },
    { name: 'Gamma', path: '/gamma' },
    { name: 'Delta', path: '/delta' }
  ], '/alpha');

  await new Promise(resolve => setTimeout(resolve, 1350));
  assert.equal(active, 2);
  let released = 0;
  while (released < 4) {
    while (released < pending.length) pending[released++]();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(maximum, 2);
});

test('background Issue refresh keeps at most two projects in flight', async () => {
  const pending = new Map();
  const starts = [];
  const Loader = loadLoader({ signals: {
    loadExternalIssueSummary: projectPath => {
      starts.push(projectPath);
      const request = deferred();
      pending.set(projectPath, request);
      return request.promise;
    }
  } });
  const posted = [];
  const loader = createLoader(Loader, posted);
  const projects = Array.from({ length: 5 }, (_, index) => ({ name: `Project ${index}`, path: `/project-${index}` }));

  loader.scheduleIssueLoads(projects, '/project-0');
  await new Promise(resolve => setTimeout(resolve, 1350));
  assert.deepEqual(starts, ['/project-0', '/project-1']);

  pending.get('/project-0').resolve({ available: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(starts, ['/project-0', '/project-1', '/project-2']);

  for (const request of pending.values()) request.resolve({ available: true });
});

test('all external signal kinds share one two-request concurrency limit', async () => {
  let active = 0;
  let maximum = 0;
  const pending = [];
  const hold = () => {
    active += 1;
    maximum = Math.max(maximum, active);
    const request = deferred();
    pending.push(request);
    return request.promise.finally(() => { active -= 1; });
  };
  const Loader = loadLoader({ signals: {
    loadExternalIssueSummary: hold,
    loadExternalPullRequestSummary: hold,
    loadExternalDeliverySummary: hold,
    loadExternalSecuritySummary: hold
  } });
  const loader = createLoader(Loader, []);
  const projects = [{ name: 'Alpha', path: '/alpha' }, { name: 'Beta', path: '/beta' }];

  loader.scheduleExternalSignals(projects, '/alpha');
  await new Promise(resolve => setTimeout(resolve, 1750));

  assert.equal(maximum, 2);
  assert.equal(active, 2);
  let resolved = 0;
  for (let round = 0; round < 5; round += 1) {
    for (const request of pending.slice(resolved)) request.resolve({ available: true });
    resolved = pending.length;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});

test('one external refresh resolves each project repository only once across signal kinds', async () => {
  const resolutions = new Map();
  const Loader = loadLoader({ signals: {
    resolveGithubRepoSlug: async projectPath => {
      resolutions.set(projectPath, (resolutions.get(projectPath) || 0) + 1);
      return `owner/${path.basename(projectPath)}`;
    }
  } });
  const loader = createLoader(Loader, []);
  const projects = [{ name: 'Alpha', path: '/alpha' }, { name: 'Beta', path: '/beta' }];

  loader.scheduleExternalSignals(projects, '/alpha');
  await new Promise(resolve => setTimeout(resolve, 1800));

  assert.deepEqual(Object.fromEntries(resolutions), { '/alpha': 1, '/beta': 1 });
});

test('switching projects prioritizes a live worker refresh without reading cached database signals', async () => {
  const starts = [];
  const Loader = loadLoader({ signals: {
    readCachedExternalSignals: async () => assert.fail('cache reads belong to the projection worker'),
    loadExternalIssueSummary: async projectPath => { starts.push(projectPath); return { available: true }; }
  } });
  const loader = createLoader(Loader, []);
  loader.prioritizeProjectSignals({ name: 'Beta', path: '/beta' });
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.equal(starts.includes('/beta'), true);
});

test('a new full refresh invalidates the previous repository resolution generation', async () => {
  let resolutions = 0;
  const Loader = loadLoader({ signals: {
    resolveGithubRepoSlug: async () => `owner/app-${++resolutions}`
  } });
  const loader = createLoader(Loader, []);
  loader.scheduleExternalSignals([{ name: 'App', path: '/app' }], '/app');
  await new Promise(resolve => setTimeout(resolve, 1700));
  loader.scheduleExternalSignals([{ name: 'App', path: '/app' }], '/app');
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(resolutions, 2);
});

test('a scheduled external batch never follows a later data root selection', async () => {
  let globalDataPath = '/data-a';
  const loadedRoots = [];
  const posted = [];
  const trackRoot = async (_projectPath, options) => {
    loadedRoots.push(options.globalDataPath);
    return { available: true };
  };
  const Loader = loadLoader({ signals: {
    loadExternalIssueSummary: trackRoot,
    loadExternalPullRequestSummary: trackRoot,
    loadExternalDeliverySummary: trackRoot,
    loadExternalSecuritySummary: trackRoot
  } });
  const loader = createLoader(Loader, posted, { getGlobalDataPath: () => globalDataPath });

  loader.scheduleExternalSignals([{ name: 'App', path: '/app' }], '/app');
  globalDataPath = '/data-b';
  await new Promise(resolve => setTimeout(resolve, 1750));

  assert.deepEqual(loadedRoots, []);
  assert.deepEqual(posted, []);
});

test('prioritizing a selected project keeps the remaining background signal queue alive', async () => {
  const issueProjects = [];
  const Loader = loadLoader({ signals: {
    loadExternalIssueSummary: async projectPath => {
      issueProjects.push(projectPath);
      return { available: true };
    }
  } });
  const loader = createLoader(Loader, []);
  const projects = [
    { name: 'Alpha', path: '/alpha' },
    { name: 'Beta', path: '/beta' },
    { name: 'Gamma', path: '/gamma' }
  ];

  loader.scheduleExternalSignals(projects, '/alpha');
  loader.prioritizeProjectSignals(projects[1]);
  await new Promise(resolve => setTimeout(resolve, 1800));

  assert.deepEqual(new Set(issueProjects), new Set(['/alpha', '/beta', '/gamma']));
});

test('manual external refresh reuses one async repository lookup and the global two-request limit', async () => {
  let resolutions = 0;
  let active = 0;
  let maximum = 0;
  const pending = [];
  const hold = () => {
    active += 1;
    maximum = Math.max(maximum, active);
    const request = deferred();
    pending.push(request);
    return request.promise.finally(() => { active -= 1; });
  };
  const Loader = loadLoader({ signals: {
    resolveGithubRepoSlug: async () => { resolutions += 1; return 'owner/app'; },
    loadExternalIssueSummary: hold,
    loadExternalPullRequestSummary: hold,
    loadExternalDeliverySummary: hold,
    loadExternalSecuritySummary: hold
  } });
  const loader = createLoader(Loader, []);
  const refresh = loader.refreshProjectSignals('/app');
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(resolutions, 1);
  assert.equal(active, 2);
  assert.equal(maximum, 2);
  pending[0].resolve({ available: true });
  pending[1].resolve({ available: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(active, 2);
  pending[2].resolve({ available: true });
  pending[3].resolve({ available: true });
  await refresh;
  assert.equal(maximum, 2);
});

test('manual external refresh never crosses into a data root selected while repository lookup is pending', async () => {
  let globalDataPath = '/data-a';
  let loads = 0;
  const repository = deferred();
  const posted = [];
  const Loader = loadLoader({ signals: {
    resolveGithubRepoSlug: () => repository.promise,
    loadExternalIssueSummary: async () => { loads += 1; return {}; },
    loadExternalPullRequestSummary: async () => { loads += 1; return {}; },
    loadExternalDeliverySummary: async () => { loads += 1; return {}; },
    loadExternalSecuritySummary: async () => { loads += 1; return {}; }
  } });
  const loader = createLoader(Loader, posted, { getGlobalDataPath: () => globalDataPath });

  const refresh = loader.refreshProjectSignals('/app');
  globalDataPath = '/data-b';
  repository.resolve('owner/app');

  assert.deepEqual(await refresh, { issues: null, pullRequests: null, delivery: null, security: null });
  assert.equal(loads, 0);
  assert.deepEqual(posted, []);
});

test('one failed manual signal refresh preserves the other successful signal results', async () => {
  const Loader = loadLoader({ signals: {
    loadExternalIssueSummary: async () => { throw new Error('issues unavailable'); },
    loadExternalPullRequestSummary: async () => ({ available: true, open: 2 }),
    loadExternalDeliverySummary: async () => ({ available: true, latestWorkflowStatus: 'completed' }),
    loadExternalSecuritySummary: async () => ({ available: true, alerts: 0 })
  } });
  const loader = createLoader(Loader, []);

  const result = await loader.refreshProjectSignals('/app');

  assert.equal(result.issues, null);
  assert.equal(result.pullRequests.open, 2);
  assert.equal(result.delivery.latestWorkflowStatus, 'completed');
  assert.equal(result.security.alerts, 0);
});

test('one action-triggered signal refresh keeps its captured data root', async () => {
  let globalDataPath = '/data-a';
  let loads = 0;
  const repository = deferred();
  const Loader = loadLoader({ signals: {
    resolveGithubRepoSlug: () => repository.promise,
    loadExternalIssueSummary: async () => { loads += 1; return { available: true }; }
  } });
  const loader = createLoader(Loader, [], { getGlobalDataPath: () => globalDataPath });

  const refresh = loader.refreshProjectSignal('/app', 'issues', '/data-a');
  globalDataPath = '/data-b';
  repository.resolve('owner/app');

  assert.equal(await refresh, null);
  assert.equal(loads, 0);
});

test('manual refresh jumps ahead of queued background projects without exceeding the limit', async () => {
  const starts = [];
  const pending = [];
  const hold = projectPath => {
    starts.push(projectPath);
    const request = deferred();
    pending.push(request);
    return request.promise;
  };
  const Loader = loadLoader({ signals: {
    loadExternalIssueSummary: hold,
    loadExternalPullRequestSummary: hold,
    loadExternalDeliverySummary: hold,
    loadExternalSecuritySummary: hold
  } });
  const loader = createLoader(Loader, []);
  loader.scheduleExternalSignals([
    { name: 'Alpha', path: '/alpha' },
    { name: 'Beta', path: '/beta' },
    { name: 'Gamma', path: '/gamma' }
  ], '/alpha');
  await new Promise(resolve => setTimeout(resolve, 1350));
  assert.deepEqual(starts, ['/alpha', '/beta']);

  const manual = loader.refreshProjectSignals('/manual');
  await new Promise(resolve => setTimeout(resolve, 20));
  pending[0].resolve({ available: true });
  pending[1].resolve({ available: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(starts.slice(2, 4), ['/manual', '/manual']);

  let resolved = 2;
  for (let round = 0; round < 8; round += 1) {
    for (const request of pending.slice(resolved)) request.resolve({ available: true });
    resolved = pending.length;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await manual;
});

test('a timed-out repository lookup preserves cached signals and starts no synchronous fallback', async () => {
  let loads = 0;
  const posted = [];
  const Loader = loadLoader({ signals: {
    resolveGithubRepoSlug: async () => null,
    readCachedExternalSignals: async () => { loads += 1; return null; },
    loadExternalIssueSummary: async () => { loads += 1; return {}; },
    loadExternalPullRequestSummary: async () => { loads += 1; return {}; },
    loadExternalDeliverySummary: async () => { loads += 1; return {}; },
    loadExternalSecuritySummary: async () => { loads += 1; return {}; }
  } });
  const loader = createLoader(Loader, posted);

  loader.prioritizeProjectSignals({ name: 'App', path: '/app' });
  await new Promise(resolve => setTimeout(resolve, 1700));

  assert.equal(loads, 0);
  assert.equal(posted.some(message => message.command === 'projectRepositoryResolved'), false);
});
