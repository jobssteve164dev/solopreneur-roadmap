const test = require('node:test');
const runtime = require('../out/runtimeDataOperations.js');
const { attachLazyContentCompute } = require('./content-compute-fixture.cjs');
const active = new Set();
test.after(async () => { for (const close of active) await close(); active.clear(); });

module.exports = { ...runtime, createRuntimeDataOperations(store, ...args) {
  const closeCompute = attachLazyContentCompute(store);
  active.add(closeCompute);
  const operations = runtime.createRuntimeDataOperations(store, ...args);
  const close = operations.close.bind(operations);
  operations.close = async () => {
    try { await close(); }
    finally { await closeCompute(); active.delete(closeCompute); }
  };
  return operations;
} };
