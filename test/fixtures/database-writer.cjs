const { SqliteStore } = require('../../out/db/sqliteStore.js');
const path = require('node:path');
(async () => {
  const store = new SqliteStore(process.argv[2], path.resolve(__dirname, '../..'));
  await store.init();
  process.send('ready');
  process.once('message', () => {
    try {
      for (let i = 0; i < 20; i++) store.logExecution(`project-${process.argv[3]}`, 'codex', 'run', `${process.argv[3]}:${i}`, 'Completed');
      store.close();
      process.disconnect();
    } catch (error) { console.error(error); process.exitCode = 1; process.disconnect(); }
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
