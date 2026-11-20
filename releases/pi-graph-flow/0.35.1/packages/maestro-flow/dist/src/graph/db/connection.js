import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, statSync } from 'node:fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
export class DatabaseConnection {
    db = null;
    dbPath = '';
    get raw() {
        if (!this.db)
            throw new Error('Database not open');
        return this.db;
    }
    get path() {
        return this.dbPath;
    }
    get isOpen() {
        return this.db !== null;
    }
    initialize(dbPath) {
        this.dbPath = dbPath;
        const dir = dirname(dbPath);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        this.db = new DatabaseSync(dbPath);
        this.applyPragmas();
        this.transaction(() => {
            this.loadSchema();
            this.setSchemaVersion(1, 'Initial schema');
        });
    }
    open(dbPath) {
        if (!existsSync(dbPath)) {
            throw new Error(`Database not found: ${dbPath}`);
        }
        this.dbPath = dbPath;
        this.db = new DatabaseSync(dbPath);
        this.applyPragmas();
    }
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
    applyPragmas() {
        const db = this.raw;
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec('PRAGMA cache_size = -64000');
        db.exec('PRAGMA temp_store = MEMORY');
        db.exec('PRAGMA mmap_size = 268435456');
    }
    loadSchema() {
        const schemaPath = resolve(__dirname, 'schema.sql');
        let sql;
        if (existsSync(schemaPath)) {
            sql = readFileSync(schemaPath, 'utf-8');
        }
        else {
            const distPath = resolve(__dirname, '..', '..', '..', 'src', 'graph', 'db', 'schema.sql');
            if (existsSync(distPath)) {
                sql = readFileSync(distPath, 'utf-8');
            }
            else {
                throw new Error(`Schema file not found at ${schemaPath} or ${distPath}`);
            }
        }
        this.raw.exec(sql);
    }
    setSchemaVersion(version, description) {
        this.raw.prepare('INSERT OR REPLACE INTO schema_versions (version, description) VALUES (?, ?)').run(version, description);
    }
    transaction(fn) {
        return sqliteTransaction(this.raw, fn);
    }
    optimize() {
        this.raw.exec('PRAGMA optimize');
        this.raw.exec('VACUUM');
        this.raw.exec('ANALYZE');
    }
    runMaintenance() {
        this.raw.exec('PRAGMA optimize');
        this.raw.exec('PRAGMA wal_checkpoint(PASSIVE)');
    }
    getSize() {
        try {
            return statSync(this.dbPath).size;
        }
        catch {
            return 0;
        }
    }
    getJournalMode() {
        const row = this.raw.prepare('PRAGMA journal_mode').get();
        return row?.journal_mode ?? 'unknown';
    }
    getSchemaVersion() {
        try {
            const row = this.raw.prepare('SELECT MAX(version) as v FROM schema_versions').get();
            return row?.v ?? 0;
        }
        catch {
            return 0;
        }
    }
}
export function getDatabasePath(projectRoot) {
    const root = projectRoot ?? process.cwd();
    return resolve(root, '.workflow', 'codebase', 'codegraph.db');
}
export function sqliteTransaction(db, fn) {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    }
    catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
//# sourceMappingURL=connection.js.map