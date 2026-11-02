const fs = require('node:fs');

function readCompleteJson(file) {
  let bytes;
  try { bytes = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try { return JSON.parse(bytes); }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
}

module.exports = { readCompleteJson };
