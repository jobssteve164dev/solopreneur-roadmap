const assert = require('node:assert/strict');
const test = require('node:test');

const { RuntimeControlProjection } = require('../out/runtimeControlProjection.js');

function registry(revision, projects = [{ name: 'Alpha', path: '/project/alpha' }]) {
  return {
    objectId: 'registry-object',
    revision,
    legacyContextImported: true,
    registry: {
      schemaVersion: 1,
      updatedAt: `2026-11-02T00:00:0${revision}.000Z`,
      projects,
      hiddenProjects: [],
      selectedProjectPath: projects[0]?.path || ''
    }
  };
}

test('Runtime control projection is unavailable until it is hydrated from the database authority', () => {
  const projection = new RuntimeControlProjection();
  assert.throws(() => projection.readProjectRegistry({}), /runtime_project_registry_projection_not_ready/);
  projection.hydrateProjectRegistry(null);
  assert.equal(projection.readProjectRegistry({}), null);
});

test('Runtime control projection preserves the project registry conditional-read contract', () => {
  const projection = new RuntimeControlProjection();
  const snapshot = registry(7);
  projection.hydrateProjectRegistry(snapshot);

  assert.deepEqual(projection.readProjectRegistry({}), snapshot);
  assert.deepEqual(projection.readProjectRegistry({ knownObjectId: snapshot.objectId, knownRevision: 7 }), {
    objectId: snapshot.objectId,
    revision: 7,
    unchanged: true,
    legacyContextImported: true
  });
});

test('Runtime control projection never regresses when an older Writer event arrives late', () => {
  const projection = new RuntimeControlProjection();
  const latest = registry(9, [{ name: 'Latest', path: '/project/latest' }]);
  projection.hydrateProjectRegistry(latest);
  projection.hydrateProjectRegistry(registry(8));
  assert.deepEqual(projection.readProjectRegistry({}), latest);
});

test('Runtime control projection delegates historical revisions to the database authority', async () => {
  const projection = new RuntimeControlProjection();
  const current = registry(9);
  const historical = registry(4, [{ name: 'Historical', path: '/project/historical' }]);
  projection.hydrateProjectRegistry(current);

  assert.equal(projection.canServeProjectRegistry({ revision: 4 }), false);
  assert.equal(projection.canServeProjectRegistry({ revision: 9 }), true);
  assert.deepEqual(projection.readProjectRegistry({ revision: 9 }), current);
  assert.deepEqual(await projection.readProjectRegistryWithFallback({ revision: 4 }, async input => {
    assert.deepEqual(input, { revision: 4 });
    return historical;
  }), historical);
});
