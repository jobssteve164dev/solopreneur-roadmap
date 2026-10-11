'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

async function openDataClient(globalRoot, projectRoot) {
  const identity = JSON.parse(await fs.promises.readFile(path.join(projectRoot, '.solopreneur', 'project.json'), 'utf8'));
  if (identity.schemaVersion !== 1 || typeof identity.projectId !== 'string' || !identity.projectId) throw new Error('project_identity_invalid');
  let session; let opening;
  const runIdentity = process.env.SOLOMAP_RUN_PROOF ? { executionLogId: Number(process.env.SOLOMAP_EXECUTION_LOG_ID), generation: Number(process.env.SOLOMAP_RUN_GENERATION), proof: process.env.SOLOMAP_RUN_PROOF } : undefined;
  const request = async input => {
    const endpoint = JSON.parse(await fs.promises.readFile(path.join(globalRoot, 'runtime', 'control.json'), 'utf8'));
    if (endpoint.schemaVersion !== 1 || endpoint.host !== '127.0.0.1' || !Number.isInteger(endpoint.port) || !endpoint.token) throw new Error('runtime_endpoint_invalid');
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: endpoint.port }); let response = '';
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(JSON.stringify({ token: endpoint.token, command: 'data', expectedRuntimeId: endpoint.runtimeId, request: input }) + '\n'));
      socket.on('data', chunk => { response += chunk; }); socket.once('error', reject);
      socket.once('end', () => {
        try { const result = JSON.parse(response); if (!result.ok || result.runtimeId !== endpoint.runtimeId) throw new Error(result.error || 'different_runtime'); resolve(result.result); }
        catch (error) { reject(error); }
      });
    });
  };
  const establish = async () => {
    if (!opening) opening = request({ operation: 'open_mcp_session', input: { projectId: identity.projectId, ...(runIdentity ? { runIdentity } : {}), ...(session ? { resume: { actorId: session.actorId, proof: session.proof } } : {}) } }).then(value => { session = value; }).finally(() => { opening = undefined; });
    await opening;
  };
  const call = async (operation, input) => {
    if (!['read', 'search', 'context', 'write', 'link', 'export'].includes(operation)) throw new Error('action_denied');
    if (!session) await establish();
    try { return await request({ operation, input, sessionToken: session.sessionToken }); }
    catch (error) {
      if (error.message !== 'mcp_session_expired') throw error;
      await establish(); return request({ operation, input, sessionToken: session.sessionToken });
    }
  };
  return {
    scope: identity.projectId, call,
    async list(kinds) {
      for (;;) {
        const items = []; let cursor; let changed = false;
        do {
          const page = await call('search', { scope: identity.projectId, kinds, limit: 100, ...(cursor ? { cursor } : {}) });
          if (page.sourceChanged) { changed = true; break; }
          items.push(...page.items); cursor = page.cursor;
        } while (cursor);
        if (!changed) return items;
      }
    },
    async content(object, field = 'content') {
      const parts = []; let cursor;
      do {
        const page = await call('read', { ref: object.objectId, revision: object.revision, view: 'content', field, limit: 1048576, ...(cursor ? { cursor } : {}) });
        parts.push(Buffer.from(page.data, 'base64')); cursor = page.cursor;
      } while (cursor);
      return Buffer.concat(parts).toString('utf8');
    },
    async close() { if (opening) await opening; if (session) await request({ operation: 'close_mcp_session', input: { sessionToken: session.sessionToken } }); session = undefined; }
  };
}

module.exports = { openDataClient };
