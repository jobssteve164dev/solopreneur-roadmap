const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DiskDatabase}=require('../out/db/diskDatabase.js');
async function fixture(t,schema){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-fk-proof-'));
  const source=new DiskDatabase(path.join(root,'source.db'));source.run(schema);await source.backup(path.join(root,'candidate.db'));
  const candidate=new DiskDatabase(path.join(root,'candidate.db'));
  t.after(()=>{candidate.close();source.close();for(const name of fs.readdirSync(root))fs.unlinkSync(path.join(root,name));fs.rmdirSync(root);});
  return {source,candidate,replay:()=>candidate.applyChangeset(source.stopChangesetCapture())};
}
function validate(candidate){candidate.verifyGenerationIntegrity();candidate.acceptVerifiedGenerationBaseline();}
test('a parent deletion catches an unchanged imported child and rolls back the whole native replay',async t=>{
  const {source,candidate,replay}=await fixture(t,'CREATE TABLE parents(id TEXT PRIMARY KEY);CREATE TABLE children(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES parents(id));CREATE INDEX child_parent ON children(parent_id);INSERT INTO parents VALUES(\'a\'),(\'b\');');
  candidate.run("INSERT INTO children VALUES('imported','b')");validate(candidate);
  source.startChangesetCapture();source.run("DELETE FROM parents WHERE id='b'");
  assert.throws(replay,/database_generation_changeset_foreign_key/);
  assert.deepEqual(candidate.exec('SELECT id FROM parents ORDER BY id')[0].values,[['a'],['b']]);
  assert.equal(candidate.exec('PRAGMA foreign_key_check').length,0);
});
test('an invalid changed child is rejected before commit without rescanning untouched roots',async t=>{
  const {source,candidate,replay}=await fixture(t,'CREATE TABLE parents(id INTEGER PRIMARY KEY);CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents);INSERT INTO parents VALUES(1);INSERT INTO children VALUES(1,1);');
  validate(candidate);let fullChecks=0;const prepare=candidate.native.prepare.bind(candidate.native);
  candidate.native.prepare=sql=>{if(/foreign_key_check/i.test(sql))fullChecks++;return prepare(sql);};
  source.startChangesetCapture();source.run('PRAGMA foreign_keys=OFF');source.run('INSERT INTO children VALUES(2,99)');
  assert.throws(replay,/database_generation_changeset_foreign_key/);assert.equal(fullChecks,0);
  assert.deepEqual(candidate.exec('SELECT * FROM children')[0].values,[[1,1]]);
});
test('two native frames preserve cascade deletions and valid cyclic foreign keys with no full FK check',async t=>{
  const {source,candidate,replay}=await fixture(t,"CREATE TABLE a(id TEXT PRIMARY KEY,b_id TEXT REFERENCES b(id));CREATE TABLE b(id TEXT PRIMARY KEY,a_id TEXT REFERENCES a(id));CREATE TABLE parents(id INTEGER PRIMARY KEY);CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents ON DELETE CASCADE);CREATE INDEX child_parent ON children(parent_id);INSERT INTO parents VALUES(1);INSERT INTO children VALUES(1,1),(2,1);");
  validate(candidate);let fullChecks=0;const prepare=candidate.native.prepare.bind(candidate.native);candidate.native.prepare=sql=>{if(/foreign_key_check/i.test(sql))fullChecks++;return prepare(sql);};
  source.startChangesetCapture();source.run("BEGIN;PRAGMA defer_foreign_keys=ON;INSERT INTO a VALUES('a','b');INSERT INTO b VALUES('b','a');COMMIT;");replay();
  source.startChangesetCapture();source.run('DELETE FROM parents WHERE id=1');replay();
  assert.equal(fullChecks,0);assert.equal(candidate.exec('SELECT 1 FROM children').length,0);assert.deepEqual(candidate.exec('SELECT id,b_id FROM a')[0].values,[['a','b']]);
});
test('incremental proof applies parent affinity and collation, composite keys, WITHOUT ROWID and NULL exemptions',async t=>{
  const {source,candidate,replay}=await fixture(t,"CREATE TABLE parents(a TEXT COLLATE NOCASE,b TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID;CREATE TABLE children(k TEXT PRIMARY KEY,a TEXT,b TEXT,FOREIGN KEY(a,b) REFERENCES parents) WITHOUT ROWID;CREATE INDEX child_parent ON children(a,b);INSERT INTO parents VALUES('Alpha','01');CREATE TABLE text_parent(id TEXT PRIMARY KEY);INSERT INTO text_parent VALUES('01');CREATE TABLE numeric_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES text_parent(id));");
  validate(candidate);source.startChangesetCapture();source.run("INSERT INTO children VALUES('ok','alpha','01'),('nullable','missing',NULL)");replay();
  source.startChangesetCapture();source.run('PRAGMA foreign_keys=OFF');source.run('INSERT INTO numeric_child VALUES(1,1)');
  assert.throws(replay,/database_generation_changeset_foreign_key/);assert.equal(candidate.exec('SELECT 1 FROM numeric_child').length,0);
  assert.equal(candidate.exec('PRAGMA foreign_key_check').length,0);
});
test('proof acceptance rejects writes after full verification and schema changes after attachment',async t=>{
  const {source,candidate,replay}=await fixture(t,'CREATE TABLE values_kept(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO values_kept VALUES(1,\'old\');');
  candidate.verifyGenerationIntegrity();candidate.run("UPDATE values_kept SET value='candidate change'");
  assert.throws(()=>candidate.acceptVerifiedGenerationBaseline(),/database_generation_baseline_changed/);
  validate(candidate);source.startChangesetCapture();source.run("UPDATE values_kept SET value='new'");candidate.run('CREATE TABLE late_schema(id INTEGER PRIMARY KEY)');
  assert.throws(replay,/database_generation_schema_changed/);assert.deepEqual(candidate.exec('SELECT value FROM values_kept')[0].values,[['candidate change']]);
});
test('an already-invalid baseline cannot acquire an incremental integrity proof',async t=>{
  const {candidate}=await fixture(t,'CREATE TABLE parents(id INTEGER PRIMARY KEY);CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents);');
  candidate.run('PRAGMA foreign_keys=OFF');candidate.run('INSERT INTO children VALUES(1,99)');candidate.run('PRAGMA foreign_keys=ON');
  assert.throws(()=>candidate.verifyGenerationIntegrity(),/database_generation_invalid/);
  assert.throws(()=>candidate.acceptVerifiedGenerationBaseline(),/database_generation_baseline_changed/);
});

test('a separate candidate writer invalidates the held proof even when its schema is unchanged',async t=>{
  const {source,candidate,replay}=await fixture(t,"CREATE TABLE kept(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO kept VALUES(1,'old');");
  validate(candidate);const other=new DiskDatabase(candidate.filePath);
  try{other.run("UPDATE kept SET value='external writer'");}finally{other.close();}
  source.startChangesetCapture();source.run("INSERT INTO kept VALUES(2,'source frame')");
  assert.throws(replay,/database_generation_candidate_changed/);assert.equal(candidate.exec('SELECT 1 FROM kept WHERE id=2').length,0);
});

test('a replaced candidate parent cannot silently orphan imported descendants',async t=>{
  const {source,candidate,replay}=await fixture(t,"CREATE TABLE parents(id TEXT PRIMARY KEY,key TEXT UNIQUE);CREATE TABLE children(id TEXT PRIMARY KEY,parent_key TEXT REFERENCES parents(key));CREATE INDEX child_parent ON children(parent_key);");
  candidate.run("INSERT INTO parents VALUES('same-id','imported-key');INSERT INTO children VALUES('imported-child','imported-key');");validate(candidate);
  source.startChangesetCapture();source.run("INSERT INTO parents VALUES('same-id','source-key')");
  assert.throws(replay,/database_generation_changeset_foreign_key/);
  assert.deepEqual(candidate.exec('SELECT key FROM parents')[0].values,[['imported-key']]);
});

test('a candidate changed between the full integrity and FK scans cannot receive a baseline proof',async t=>{
  const {candidate}=await fixture(t,"CREATE TABLE kept(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO kept VALUES(1,'old');");
  const other=new DiskDatabase(candidate.filePath),prepare=candidate.native.prepare.bind(candidate.native);let changed=false;
  candidate.native.prepare=sql=>{if(!changed&&/foreign_key_check/.test(sql)){changed=true;other.run("UPDATE kept SET value='during validation'");}return prepare(sql);};
  try{assert.throws(()=>candidate.verifyGenerationIntegrity(),/database_generation_baseline_changed/);assert.ok(changed);}
  finally{candidate.native.prepare=prepare;other.close();}
});

test('an unverified same-connection dirty child is checked before the next frame clears pending keys',async t=>{
  const {source,candidate,replay}=await fixture(t,'CREATE TABLE parents(id INTEGER PRIMARY KEY);CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents);CREATE TABLE unrelated(id INTEGER PRIMARY KEY);');
  validate(candidate);candidate.run('PRAGMA foreign_keys=OFF;INSERT INTO children VALUES(9,99);PRAGMA foreign_keys=ON;');
  source.startChangesetCapture();source.run('INSERT INTO unrelated VALUES(1)');
  assert.throws(replay,/database_generation_changeset_foreign_key/);assert.equal(candidate.exec('SELECT 1 FROM unrelated').length,0);
  assert.throws(()=>candidate.verifyGenerationTail(),/database_generation_changeset_foreign_key/);
});

test('TEMP shadow tables cannot redirect the parent-change lookup away from main business children',async t=>{
  const {source,candidate,replay}=await fixture(t,'CREATE TABLE parents(id INTEGER PRIMARY KEY);CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents);CREATE INDEX child_parent ON children(parent_id);INSERT INTO parents VALUES(1);');
  candidate.run('INSERT INTO main.children VALUES(1,1);CREATE TEMP TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER);');validate(candidate);
  source.startChangesetCapture();source.run('DELETE FROM parents WHERE id=1');
  assert.throws(replay,/database_generation_changeset_foreign_key/);assert.equal(candidate.exec('PRAGMA main.foreign_key_check').length,0);
});

test('removing a TEMP tracking trigger invalidates the candidate proof before applying a new frame',async t=>{
  const {source,candidate,replay}=await fixture(t,'CREATE TABLE parents(id INTEGER PRIMARY KEY);CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents);INSERT INTO parents VALUES(1);');
  candidate.run('INSERT INTO children VALUES(1,1)');validate(candidate);
  const trigger=candidate.exec("SELECT name FROM temp.sqlite_schema WHERE type='trigger' AND name LIKE '%parent_delete' LIMIT 1")[0].values[0][0];candidate.run(`DROP TRIGGER temp."${trigger}"`);
  source.startChangesetCapture();source.run('DELETE FROM parents WHERE id=1');
  assert.throws(replay,/database_generation_schema_changed/);assert.equal(candidate.exec('PRAGMA foreign_key_check').length,0);
});

for(const identity of ['id','rowid','_rowid_','oid']) test(`a native business trigger moving child ${identity} cannot hide an imported orphan`,async t=>{
  const {source,candidate,replay}=await fixture(t,`CREATE TABLE p(id INTEGER PRIMARY KEY);CREATE TABLE c(id INTEGER PRIMARY KEY,p_id INTEGER REFERENCES p(id));CREATE INDEX c_parent ON c(p_id);INSERT INTO p VALUES(1);CREATE TRIGGER move_imported BEFORE DELETE ON p BEGIN UPDATE c SET ${identity}=${identity}+100 WHERE p_id=OLD.id;END;`);
  candidate.run('INSERT INTO c VALUES(7,1)');validate(candidate);source.startChangesetCapture();source.run('DELETE FROM p WHERE id=1');
  assert.throws(replay,/database_generation_changeset_foreign_key/);assert.deepEqual(candidate.exec('SELECT id FROM c')[0].values,[[7]]);assert.equal(candidate.exec('PRAGMA foreign_key_check').length,0);
});

for(const variation of ['collation','numeric-type'])test(`a native trigger changing child ${variation} is compared with exact stored semantics`,async t=>{
  const text=variation==='collation';
  const {source,candidate,replay}=await fixture(t,`CREATE TABLE p(id TEXT PRIMARY KEY);INSERT INTO p VALUES('${text?'A':'1'}');CREATE TABLE c(id INTEGER PRIMARY KEY,p_id ${text?'TEXT COLLATE NOCASE':''} REFERENCES p(id));CREATE TABLE marker(id INTEGER PRIMARY KEY,value INTEGER);INSERT INTO marker VALUES(1,0);CREATE TRIGGER change_imported AFTER UPDATE ON marker BEGIN UPDATE c SET p_id=${text?'lower(p_id)':'CAST(p_id AS REAL)'};END;`);
  candidate.run(text?"INSERT INTO c VALUES(7,'A')":'INSERT INTO c VALUES(7,1)');validate(candidate);source.startChangesetCapture();source.run('UPDATE marker SET value=1');
  assert.throws(replay,/database_generation_changeset_foreign_key/);assert.equal(candidate.exec('PRAGMA foreign_key_check').length,0);
});

test('a parent generated foreign-key target is followed when its base column changes',async t=>{
  const {source,candidate,replay}=await fixture(t,"CREATE TABLE p(id INTEGER PRIMARY KEY,base TEXT,k TEXT GENERATED ALWAYS AS(base) STORED UNIQUE);CREATE TABLE c(id INTEGER PRIMARY KEY,k TEXT REFERENCES p(k));CREATE INDEX c_parent ON c(k);INSERT INTO p(id,base) VALUES(1,'a');");
  candidate.run("INSERT INTO c VALUES(7,'a')");validate(candidate);source.startChangesetCapture();source.run("UPDATE p SET base='b'");
  assert.throws(replay,/database_generation_changeset_foreign_key/);assert.equal(candidate.exec('PRAGMA foreign_key_check').length,0);
});

test('a child generated FK changed by a native trigger is followed through its base column',async t=>{
  const {source,candidate,replay}=await fixture(t,"CREATE TABLE p(k TEXT PRIMARY KEY);INSERT INTO p VALUES('a');CREATE TABLE c(id INTEGER PRIMARY KEY,base TEXT,k TEXT GENERATED ALWAYS AS(base) STORED REFERENCES p(k));CREATE TABLE marker(id INTEGER PRIMARY KEY,value INTEGER);INSERT INTO marker VALUES(1,0);CREATE TRIGGER change_imported AFTER UPDATE ON marker BEGIN UPDATE c SET base='b';END;");
  candidate.run("INSERT INTO c(id,base) VALUES(7,'a')");validate(candidate);source.startChangesetCapture();source.run('UPDATE marker SET value=1');
  assert.throws(replay,/database_generation_changeset_foreign_key/);assert.equal(candidate.exec('PRAGMA foreign_key_check').length,0);
});

test('tail verification notices an external commit during its dirty-key checks',async t=>{
  const {candidate}=await fixture(t,'CREATE TABLE parents(id INTEGER PRIMARY KEY);CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents);');
  validate(candidate);const other=new DiskDatabase(candidate.filePath),prepare=candidate.native.prepare.bind(candidate.native);let changed=false;
  candidate.native.prepare=sql=>{if(!changed&&/SELECT 1 FROM temp\./.test(sql)){changed=true;other.run('PRAGMA foreign_keys=OFF;INSERT INTO children VALUES(9,99);');}return prepare(sql);};
  try{assert.throws(()=>candidate.verifyGenerationTail(),/database_generation_candidate_changed/);assert.ok(changed);}finally{candidate.native.prepare=prepare;other.close();}
});

test('the actual generated parent lookup uses the existing child index for compatible affinities',async t=>{
  const {candidate}=await fixture(t,'CREATE TABLE parents(id INTEGER PRIMARY KEY);CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents);CREATE INDEX child_parent ON children(parent_id);WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO parents SELECT x FROM n;INSERT INTO children SELECT id,id FROM parents;ANALYZE;');
  validate(candidate);
  const sql=candidate.exec("SELECT sql FROM temp.sqlite_schema WHERE type='trigger' AND tbl_name='parents' AND name LIKE '%parent_delete'")[0].values[0][0];
  const predicate=/WHERE ([\s\S]+); END$/.exec(sql)[1].replaceAll('OLD."id"','1');
  const plan=candidate.exec(`EXPLAIN QUERY PLAN SELECT c.id FROM main.children c WHERE ${predicate}`)[0].values.map(row=>String(row[3])).join('\n');
  assert.match(plan,/SEARCH c USING.*child_parent/);assert.doesNotMatch(plan,/SCAN c/);
});

test('an indexed parent lookup retains parent collation when the child column has a different collation',async t=>{
  const {source,candidate,replay}=await fixture(t,"CREATE TABLE parents(id TEXT COLLATE NOCASE PRIMARY KEY);CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id TEXT COLLATE BINARY REFERENCES parents);CREATE INDEX child_parent ON children(parent_id COLLATE NOCASE);INSERT INTO parents VALUES('Alpha');");
  candidate.run("INSERT INTO children VALUES(1,'alpha')");validate(candidate);source.startChangesetCapture();source.run('DELETE FROM parents');
  assert.throws(replay,/database_generation_changeset_foreign_key/);assert.equal(candidate.exec('PRAGMA foreign_key_check').length,0);
});

test('every content-parent lookup generated for the complete application schema uses a leading child index',t=>{
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-root-plans-')),store=new UnifiedDataStore(root);
  try{
    store.verifyDatabaseGeneration();store.acceptVerifiedDatabaseGenerationBaseline();
    const triggers=store.rows("SELECT sql FROM temp.sqlite_schema WHERE type='trigger' AND tbl_name='contents' AND name LIKE '%parent_delete'");
    assert.ok(triggers.length>=82,'include the complete declared content FK catalog');
    for(const trigger of triggers){
      const child=/FROM main\."([^"]+)" c WHERE/.exec(trigger.sql)[1],predicate=/WHERE ([\s\S]+); END$/.exec(trigger.sql)[1].replaceAll('OLD."id"',"'probe'");
      assert.doesNotMatch(predicate,/OLD\./);
      const plan=store.rows(`EXPLAIN QUERY PLAN SELECT 1 FROM main."${child}" c WHERE ${predicate}`).map(row=>row.detail).join('\n');
      assert.match(plan,/SEARCH c USING/,`${child}: ${plan}`);assert.doesNotMatch(plan,/SCAN c/,child);
    }
  }finally{store.close();for(const name of fs.readdirSync(root))fs.unlinkSync(path.join(root,name));fs.rmdirSync(root);}
});

test('candidate preparation adds only the twelve missing reverse indexes for actually mutable parent families',t=>{
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-mutable-plans-')),store=new UnifiedDataStore(root);
  const parents=new Set(['outbox','growth_live_edges','growth_live_signals','growth_live_module_labels','growth_live_items','growth_edges','growth_signals','growth_module_labels','growth_items','events','growth_snapshots','object_revisions','objects','requests']);
  try{
    const before=store.rows('SELECT COUNT(*) AS n FROM contents')[0].n;
    assert.equal(store.prepareDatabaseGenerationForeignKeyIndexes().length,12);
    const schemaCookie=store.rows('PRAGMA main.schema_version')[0].schema_version;
    assert.deepEqual(store.prepareDatabaseGenerationForeignKeyIndexes(),[]);assert.equal(store.rows('PRAGMA main.schema_version')[0].schema_version,schemaCookie);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM contents')[0].n,before);
    store.verifyDatabaseGeneration();store.acceptVerifiedDatabaseGenerationBaseline();let checked=0;
    for(const trigger of store.rows("SELECT tbl_name,sql FROM temp.sqlite_schema WHERE type='trigger' AND name LIKE '%parent_delete'")){
      if(!parents.has(trigger.tbl_name))continue;checked++;
      const info=store.rows(`PRAGMA main.table_xinfo("${trigger.tbl_name}")`);
      const child=/FROM main\."([^"]+)" c WHERE/.exec(trigger.sql)[1],predicate=/WHERE ([\s\S]+); END$/.exec(trigger.sql)[1].replace(/OLD\."([^"]+)"/g,(_match,column)=>/INT|REAL|NUM|FLOA|DOUB/.test(String(info.find(item=>item.name===column)?.type))?'1':"'probe'");
      const plan=store.rows(`EXPLAIN QUERY PLAN SELECT 1 FROM main."${child}" c WHERE ${predicate}`).map(row=>row.detail).join('\n');
      assert.match(plan,/SEARCH c USING/,`${trigger.tbl_name} -> ${child}: ${plan}`);assert.doesNotMatch(plan,/SCAN c/,child);
    }
    assert.ok(checked>=100);
  }finally{store.close();for(const name of fs.readdirSync(root))fs.unlinkSync(path.join(root,name));fs.rmdirSync(root);}
});

test('an index with a different collation cannot suppress the required candidate reverse index',t=>{
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-index-collation-')),store=new UnifiedDataStore(root);
  try{
    store.db.run('CREATE INDEX owned_wrong_collation ON relations(target_id COLLATE NOCASE)');
    assert.equal(store.prepareDatabaseGenerationForeignKeyIndexes().length,12);
    const plan=store.rows("EXPLAIN QUERY PLAN SELECT rowid FROM relations WHERE target_id='probe'").map(row=>row.detail).join('\n');
    assert.match(plan,/SEARCH relations USING.*generation_fk_relations_target_id/);
    assert.equal(store.rows("SELECT 1 FROM sqlite_schema WHERE name='owned_wrong_collation'").length,1);
  }finally{store.close();for(const name of fs.readdirSync(root))fs.unlinkSync(path.join(root,name));fs.rmdirSync(root);}
});
