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
        ...overrides.signals
      };
    }
    if (parent?.filename === loaderPath && request === './projectAnalytics') {
      return { readProjectInvestmentStatsFromDatabase: overrides.investment || (async () => ({})) };
    }
    if (parent?.filename === loaderPath && request === './projectPortfolio') {
      return { buildProjectPortfolioSummary: project => ({ path: project.path, name: project.name }) };
    }
    return original.apply(this, arguments);
  };
  try { return require(loaderPath).SidebarProjectLoader; }
  finally { Module._load = original; }
}

function createLoader(Loader, posted) {
  return new Loader({
    isAvailable: () => true,
    postMessage: message => posted.push(message),
    getGlobalDataPath: () => '/tmp/solomap-loader-test',
    getExtensionPath: () => '/tmp',
    buildGlobalStore: (_path, portfolio) => ({ ready: true, paths: portfolio.map(item => item.path) }),
    buildGlobalStorePlaceholder: () => ({ ready: false })
  });
}

test('refreshing one project does not cancel another pending portfolio enrichment', async () => {
  const alpha = deferred();
  const Loader = loadLoader({ investment: projectPath => projectPath === '/alpha' ? alpha.promise : Promise.resolve({}) });
  const posted = [];
  const loader = createLoader(Loader, posted);
  const projects = [{ name: 'Alpha', path: '/alpha' }, { name: 'Beta', path: '/beta' }];
  loader.schedulePortfolioEnrichment(projects, '/alpha', projects);
  await new Promise(resolve => setTimeout(resolve, 1050));
  loader.schedulePortfolioEnrichment(projects, '/alpha', projects, ['/beta']);
  alpha.resolve({});
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(posted.some(message => message.projects?.updatedProjectPaths?.[0] === '/alpha'));
  assert.ok(posted.some(message => message.projects?.updatedProjectPaths?.[0] === '/beta'));
  const settled = posted.at(-1);
  assert.equal(settled.projects.globalStore.ready, true);
  assert.deepEqual(settled.projects.globalStore.paths, ['/alpha', '/beta']);
});

test('refreshing one portfolio card restores a real global store', async () => {
  const Loader = loadLoader();
  const posted = [];
  const loader = createLoader(Loader, posted);
  const projects = [{ name: 'Alpha', path: '/alpha' }, { name: 'Beta', path: '/beta' }];
  loader.schedulePortfolioEnrichment(projects, '/alpha', projects, ['/beta']);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(posted.at(-1).projects.globalStore.ready, true);
  assert.deepEqual(posted.at(-1).projects.globalStore.paths, ['/alpha', '/beta']);
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
