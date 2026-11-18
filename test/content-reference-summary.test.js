const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, collectContentReferences, serializeContentWithReferences, stringifyContentWithReferences, summarizeContentBytes } = require('../out/contentReferences.js');

test('single serialization preserves canonical bytes and the existing branch-stop reference grammar', () => {
  const value = { z: [{ bodyContentId: 'A' }], a: { sourceContents: { p: 'B', nested: { contentId: 'ignored-map' } } }, bodyContentIds: ['C', { contentId: 'ignored-array' }] };
  const expected = '{"a":{"sourceContents":{"nested":{"contentId":"ignored-map"},"p":"B"}},"bodyContentIds":["C",{"contentId":"ignored-array"}],"z":[{"bodyContentId":"A"}]}';
  const result = serializeContentWithReferences(value);
  assert.equal(result.text, expected);
  assert.equal(canonicalJson(value), expected);
  assert.deepEqual(result.targets, ['A', 'B', 'C']);
  assert.deepEqual(result.targets, [...new Set(collectContentReferences(JSON.parse(expected)))].sort());
});
test('summary and bytes observe object properties only once', () => {
  let reads = 0;
  const value = { get bodyContentId() { reads++; return reads === 1 ? 'actual-bytes-target' : 'wrong-second-read'; } };
  const result = serializeContentWithReferences(value);
  assert.equal(reads, 1);
  assert.equal(result.text, '{"bodyContentId":"actual-bytes-target"}');
  assert.deepEqual(result.targets, ['actual-bytes-target']);
});
test('raw summaries bind final bytes and strict JSON duplicate/escaped key meaning', () => {
  const bytes = Buffer.from('{"contentId":"discarded","content\\u0049d":"kept","x":{"bodyContentId":"other"}}');
  const result = summarizeContentBytes(bytes);
  assert.deepEqual(result.targets, ['kept', 'other']);
  assert.equal(result.byteLength, bytes.length);
  assert.equal(result.sha256, require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(summarizeContentBytes(Buffer.from('{broken')).targets, []);
  assert.deepEqual(summarizeContentBytes(Buffer.from('ordinary original text')).targets, []);
});
test('non-container original bytes never allocate a whole UTF-8 JSON string', () => {
  for(const text of ['SQLite format 3\0'+ 'x'.repeat(256*1024), 'ordinary original log'.repeat(2000), '"a JSON primitive string"', '42', 'true', 'null', '\ufeff{"contentId":"BOM is invalid JSON"}']){
    const bytes=Buffer.from(text),expected=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    bytes.toString=()=>assert.fail('no object/array references can exist in this original byte prefix');
    const summary=summarizeContentBytes(bytes);assert.deepEqual(summary.targets,[]);assert.equal(summary.sha256,expected);assert.equal(summary.byteLength,bytes.length);
  }
  assert.deepEqual(summarizeContentBytes(Buffer.from(' \t\r\n {"contentId":"object"}')).targets,['object']);
  assert.deepEqual(summarizeContentBytes(Buffer.from(' \n [{"content_id":"array"}]')).targets,['array']);
});
test('nonmatching reference shapes retain nested traversal and duplicate targets collapse', () => {
  const value = { bodyContentId: { contentId: 'same' }, bodyContentIds: { contentId: 'same' }, sourceContents: [{ contentId: 'from-array' }] };
  assert.deepEqual(serializeContentWithReferences(value).targets, ['from-array', 'same']);
});
test('native stringify summaries retain insertion order, toJSON and omitted-value semantics', () => {
  const shared = { contentId: 'shared-target' };
  const value = { z: undefined, y: [undefined, { toJSON: () => ({ contentId: 'from-json' }) }], sourceContents: { ignored: shared, direct: 'from-map' }, normal: shared, bodyContentIds: ['from-array', shared] };
  const result = stringifyContentWithReferences(value);
  assert.equal(result.text, JSON.stringify(value));
  assert.deepEqual(result.targets, ['from-array', 'from-json', 'from-map', 'shared-target']);
  assert.deepEqual(result.targets, [...new Set(collectContentReferences(JSON.parse(result.text)))].sort());
});
test('native stringify summary reads dynamic values once and keeps empty property names', () => {
  let reads = 0;
  const value = { sourceContents: { '': { contentId: 'ignored' }, direct: 'kept' }, '': { get contentId() { reads++; return 'read-' + reads; } } };
  const result = stringifyContentWithReferences(value);
  assert.equal(reads, 1);
  assert.deepEqual(result.targets, ['kept', 'read-1']);
});
test('native stringify summaries follow boxed strings across all reference shapes and realms', () => {
  const value = { contentId: new String('boxed-target'), bodyContentIds: [new String('array-target')],
    sourceContents: { body: new String('map-target') },
    normal: { contentId: require('node:vm').runInNewContext('new String("realm-target")') } };
  const result = stringifyContentWithReferences(value);
  assert.equal(result.text, JSON.stringify(value));
  assert.deepEqual(result.targets, ['array-target', 'boxed-target', 'map-target', 'realm-target']);
  assert.deepEqual(result.targets, [...new Set(collectContentReferences(JSON.parse(result.text)))].sort());
});
test('native stringify coerces a string wrapper once without trusting a spoofed type tag', () => {
  let coercions = 0;
  const boxed = new String('original'); boxed.toString = () => { coercions++; return 'coerced-target'; };
  const result = stringifyContentWithReferences({ contentId: boxed, other: { [Symbol.toStringTag]: 'String', contentId: 'real-nested-target' } });
  assert.equal(coercions, 1);
  assert.equal(result.text, '{"contentId":"coerced-target","other":{"contentId":"real-nested-target"}}');
  assert.deepEqual(result.targets, ['coerced-target', 'real-nested-target']);
});
test('native raw JSON references follow emitted values while retaining exact raw literals', () => {
  const value = { contentId: JSON.rawJSON('"raw\\u002dtarget"'), bodyContentIds: [JSON.rawJSON('"array-target"')],
    sourceContents: { body: JSON.rawJSON('"map-target"') }, numeric: JSON.rawJSON('1e3'), empty: JSON.rawJSON('null') };
  const result = stringifyContentWithReferences(value);
  assert.equal(result.text, JSON.stringify(value));
  assert.ok(result.text.includes('"raw\\u002dtarget"'));
  assert.ok(result.text.includes('"numeric":1e3'));
  assert.deepEqual(result.targets, ['array-target', 'map-target', 'raw-target']);
  assert.deepEqual(result.targets, [...new Set(collectContentReferences(JSON.parse(result.text)))].sort());
});
