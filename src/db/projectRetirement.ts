import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { DiskDatabase, SqlValue } from './diskDatabase.js';
import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import { projectName, type ProjectRegistrySnapshot } from '../projectRegistry.js';

type Row = Record<string, SqlValue>;
interface Store {
  db: DiskDatabase;
  rows(sql: string, values?: SqlValue[]): Row[];
  readTransaction<T>(operation: () => T): T;
  readProjectRegistry(): ProjectRegistrySnapshot | null;
}
export interface ProjectRetirementCandidate extends DataWriteDatabaseIdentity { locationId: string; projectId: string; root: string; deviceId: string }
export interface ProjectRetirementQualificationRequest extends ProjectRetirementCandidate { purpose?: 'retirement' | 'database-only' }
export interface ProjectRetirementPage { cursor: string; complete: boolean; projects: ProjectRetirementCandidate[] }
export interface ProjectRetirementPageRequest extends DataWriteDatabaseIdentity { cursor: string; deviceId: string }
type Reference = { table: string; column: string };
const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
const table = 'solomap_project_retirement_watches';
const activeMigrations = "('queued','running','failed','interrupted','completed_with_conflicts')";
export function vanishedTestProject(root: string): boolean {
  const resolved = path.resolve(root), relative = path.relative(path.resolve(os.tmpdir()), resolved);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    && /^solomap-old-init-[A-Za-z0-9_-]+$/.test(path.basename(resolved)) && !fs.existsSync(resolved);
}

/** Compute reads the full protection evidence; Source retains only a transient qualification. */
export class ProjectRetirement {
  private catalog?: { cookie: number; references: Reference[] };
  private bootstrapCookie?: number;
  private bootstrapSchema?: number;
  private readonly definitions = new Map<string, string>();
  private readonly generatedDefinitions = new Map<string, string>();
  private readonly retired = new Set<string>();
  constructor(private readonly store: Store) {}
  private version(pragma: string): number { return Number(this.store.db.exec(`PRAGMA ${pragma}`)[0].values[0][0]); }
  private references(): Reference[] {
    const cookie = this.version('main.schema_version');
    if (this.catalog?.cookie === cookie) return this.catalog.references;
    const references = this.store.rows("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .flatMap(row => this.store.rows(`PRAGMA main.foreign_key_list(${quote(String(row.name))})`)
        .filter(fk => fk.to === 'id' && (fk.table === 'projects'
          ? !['projects', 'project_locations', 'sidebar_core_projection_state'].includes(String(row.name))
          : fk.table === 'objects' && !['projects', 'object_revisions', 'events'].includes(String(row.name))))
        .map(fk => ({ table: String(row.name), column: String(fk.from) })));
    this.catalog = { cookie, references }; return references;
  }
  public page(input: ProjectRetirementPageRequest): ProjectRetirementPage {
    return this.store.readTransaction(() => {
      const rows = this.store.rows('SELECT id,project_id,root_path,device_id,status FROM project_locations WHERE id>? ORDER BY id LIMIT 128', [input.cursor]);
      return { cursor: String(rows.at(-1)?.id || input.cursor), complete: rows.length < 128,
        projects: rows.filter(row => row.device_id === input.deviceId && row.status === 'active' && vanishedTestProject(String(row.root_path)))
          .map(row => ({ databaseId: input.databaseId, sourceDevice: input.sourceDevice, sourceInode: input.sourceInode,
            locationId: String(row.id), projectId: String(row.project_id), root: String(row.root_path), deviceId: input.deviceId })) };
    });
  }
  private currentMetadata(project: ProjectRetirementCandidate): boolean {
    const row = this.store.rows(`SELECT p.name FROM project_locations l JOIN projects p ON p.id=l.project_id JOIN objects o ON o.id=p.id
      WHERE l.id=? AND l.project_id=? AND l.root_path=? AND l.device_id=? AND l.status='active' AND p.hidden=0 AND o.archived_at IS NULL
      AND o.revision=1 AND p.type IS NULL AND p.priority IS NULL AND p.description IS NULL AND p.pinned_at IS NULL AND p.notes_content_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM project_locations other WHERE other.project_id=l.project_id AND other.id<>l.id)
      AND NOT EXISTS(SELECT 1 FROM objects scoped WHERE scoped.project_id=l.project_id)`, [project.locationId, project.projectId, project.root, project.deviceId])[0];
    return Boolean(row && row.name === projectName(project.root));
  }
  public current(project: ProjectRetirementCandidate): boolean { return this.currentMetadata(project) && vanishedTestProject(project.root); }
  public qualify(project: ProjectRetirementCandidate,purpose: 'retirement' | 'database-only'='retirement'): boolean {
    if(purpose!=='retirement' && purpose!=='database-only')throw new Error('project_retirement_qualification_invalid');
    return this.store.readTransaction(() => {
      if (!this.currentMetadata(project) || purpose==='retirement' && !vanishedTestProject(project.root)) return false;
      for (const reference of this.references()) {
        if (this.store.rows(`SELECT 1 FROM ${quote(reference.table)} WHERE ${quote(reference.column)}=? LIMIT 1`, [project.projectId])[0]) return false;
      }
      const registry = this.store.readProjectRegistry()?.registry;
      if (registry && [...registry.projects.map(item => item.path), ...registry.hiddenProjects].some(root => path.resolve(root) === path.resolve(project.root))) return false;
      let cursor = '';
      for (;;) {
        const jobs = this.store.rows(`SELECT id,args_json FROM migration_jobs WHERE id>? AND status IN ${activeMigrations} ORDER BY id LIMIT 128`, [cursor]);
        for (const job of jobs) {
          try {
            const args = JSON.parse(String(job.args_json));
            if (typeof args.projectRoot === 'string' && path.resolve(args.projectRoot) === path.resolve(project.root)) return false;
            if (args.projectScopes && typeof args.projectScopes === 'object' && !Array.isArray(args.projectScopes)) {
              for (const [root, projectId] of Object.entries(args.projectScopes)) {
                if (projectId === project.projectId || path.isAbsolute(root) && path.resolve(root) === path.resolve(project.root)) return false;
              }
            }
          } catch { /* Preserve the existing interpretation of malformed migration arguments. */ }
        }
        if (jobs.length < 128) return true;
        cursor = String(jobs.at(-1)!.id);
      }
    });
  }
  private bootstrap(): void {
    if (this.store.db.inTransaction) throw new Error('project_retirement_transaction_active');
    const schema = this.version('main.schema_version'), temp = this.version('temp.schema_version');
    if (this.bootstrapCookie === temp && this.bootstrapSchema === schema) return;
    const references = new Map<string, Set<string>>();
    for (const reference of [...this.references(), { table: 'projects', column: 'id' }, { table: 'project_locations', column: 'project_id' },
      { table: 'objects', column: 'id' }, { table: 'objects', column: 'project_id' }]) {
      const columns = references.get(reference.table) || new Set<string>(); columns.add(reference.column); references.set(reference.table, columns);
    }
    this.store.db.run('SAVEPOINT solomap_project_retirement_bootstrap');
    try {
      this.store.db.run(`CREATE TEMP TABLE IF NOT EXISTS ${table}(project_id TEXT NOT NULL,token TEXT NOT NULL,registry_id TEXT,
        dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),PRIMARY KEY(project_id,token)) WITHOUT ROWID`);
      this.store.db.run(`CREATE INDEX IF NOT EXISTS temp.solomap_project_retirement_tokens ON ${table}(token)`);
      this.store.db.run(`CREATE INDEX IF NOT EXISTS temp.solomap_project_retirement_registry ON ${table}(registry_id)`);
      this.store.db.run(`UPDATE temp.${table} SET dirty=1 WHERE dirty=0`);
      const definitions = new Map<string, string>();
      for (const [source, columns] of references) for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const sides = action === 'UPDATE' ? ['OLD', 'NEW'] : [action === 'DELETE' ? 'OLD' : 'NEW'];
        const keys = sides.flatMap(side => [...columns].map(column => `${side}.${quote(column)}`)).join(',');
        const registryKeys = sides.map(side => `${side}.id`).join(',');
        const condition = `project_id IN (${keys})${source === 'objects' ? ` OR registry_id IN (${registryKeys})` : ''}`;
        const name = `solomap_retire_${source}_${action.toLowerCase()}`;
        definitions.set(name, `CREATE TEMP TRIGGER ${quote(name)} AFTER ${action} ON main.${quote(source)}
          BEGIN UPDATE ${table} SET dirty=1 WHERE dirty=0 AND (${condition}); END`);
      }
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const sides = action === 'UPDATE' ? ['OLD', 'NEW'] : [action === 'DELETE' ? 'OLD' : 'NEW'];
        const when = sides.map(side => `(${side}.namespace='project_registry' AND ${side}.key='registry' AND ${side}.owner_scope='global')`).join(' OR ');
        const name = `solomap_retire_registry_${action.toLowerCase()}`;
        definitions.set(name, `CREATE TEMP TRIGGER ${quote(name)} AFTER ${action} ON main.settings WHEN ${when}
          BEGIN UPDATE ${table} SET dirty=1 WHERE dirty=0; END`);
      }
      definitions.set('solomap_retire_migration_insert', `CREATE TEMP TRIGGER solomap_retire_migration_insert AFTER INSERT ON main.migration_jobs
        WHEN NEW.status IN ${activeMigrations} BEGIN UPDATE ${table} SET dirty=1 WHERE dirty=0; END`);
      definitions.set('solomap_retire_migration_update', `CREATE TEMP TRIGGER solomap_retire_migration_update AFTER UPDATE OF status,args_json ON main.migration_jobs
        WHEN (NEW.status IN ${activeMigrations} OR OLD.status IN ${activeMigrations})
        AND ((OLD.status IN ${activeMigrations})<>(NEW.status IN ${activeMigrations}) OR OLD.args_json IS NOT NEW.args_json)
        BEGIN UPDATE ${table} SET dirty=1 WHERE dirty=0; END`);
      definitions.set('solomap_retire_migration_delete', `CREATE TEMP TRIGGER solomap_retire_migration_delete AFTER DELETE ON main.migration_jobs
        WHEN OLD.status IN ${activeMigrations} BEGIN UPDATE ${table} SET dirty=1 WHERE dirty=0; END`);
      for (const [name, sql] of definitions) {
        const existing = this.store.rows("SELECT sql FROM temp.sqlite_schema WHERE type='trigger' AND name=?", [name])[0];
        if (existing) {
          if (this.definitions.get(name) !== existing.sql) throw new Error('project_retirement_schema_changed');
          // Schema extensions may add a reference column on an already watched table.
          if (this.generatedDefinitions.get(name) !== sql) this.store.db.run(`DROP TRIGGER temp.${quote(name)}`);
          else continue;
        }
        this.store.db.run(sql);
      }
      const installed = new Map<string, string>();
      for (const name of definitions.keys()) installed.set(name, String(this.store.rows("SELECT sql FROM temp.sqlite_schema WHERE type='trigger' AND name=?", [name])[0].sql));
      this.store.db.run('RELEASE solomap_project_retirement_bootstrap');
      this.definitions.clear(); this.generatedDefinitions.clear();
      for (const [name, sql] of definitions) {
        this.generatedDefinitions.set(name, sql);
        this.definitions.set(name, installed.get(name)!);
      }
      this.bootstrapCookie = this.version('temp.schema_version');
      this.bootstrapSchema = schema;
    } catch (error) {
      try { this.store.db.run('ROLLBACK TO solomap_project_retirement_bootstrap'); this.store.db.run('RELEASE solomap_project_retirement_bootstrap'); } catch { /* Preserve the original storage failure. */ }
      throw error;
    }
  }
  public begin(project: ProjectRetirementCandidate): string {
    this.bootstrap(); this.flushRetired();
    const token = randomUUID(), registry = this.store.rows("SELECT id FROM settings WHERE namespace='project_registry' AND key='registry' AND owner_scope='global'")[0];
    this.store.db.run(`INSERT INTO temp.${table} VALUES(?,?,?,0)`, [project.projectId, token, registry?.id || null]); return token;
  }
  public unchanged(project: ProjectRetirementCandidate, token: string): boolean {
    return this.store.rows(`SELECT 1 FROM temp.${table} WHERE project_id=? AND token=? AND dirty=0`, [project.projectId, token]).length === 1;
  }
  public release(token: string): void { this.retired.add(token); this.flushRetired(); }
  public flushRetired(throwOnFailure = false): boolean {
    if (!this.store.db.isOpen) { this.retired.clear(); return false; }
    if (this.store.db.inTransaction) return this.retired.size > 0;
    const token = this.retired.values().next().value;
    if (token !== undefined) {
      try { this.store.db.run(`DELETE FROM temp.${table} WHERE token=?`, [token]); this.retired.delete(token); }
      catch (error) { if (throwOnFailure) throw error; }
    }
    return this.retired.size > 0;
  }
}
