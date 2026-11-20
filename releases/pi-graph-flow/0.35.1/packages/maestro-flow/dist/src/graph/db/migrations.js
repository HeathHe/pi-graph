export const CURRENT_SCHEMA_VERSION = 1;
const MIGRATIONS = [
// Version 1 is the initial schema loaded from schema.sql
];
export function needsMigration(conn) {
    return conn.getSchemaVersion() < CURRENT_SCHEMA_VERSION;
}
export function runMigrations(conn) {
    const current = conn.getSchemaVersion();
    const pending = MIGRATIONS.filter(m => m.version > current);
    for (const migration of pending) {
        conn.transaction(() => {
            migration.up(conn);
            conn.raw.prepare('INSERT OR REPLACE INTO schema_versions (version, description) VALUES (?, ?)').run(migration.version, migration.description);
        });
    }
}
//# sourceMappingURL=migrations.js.map