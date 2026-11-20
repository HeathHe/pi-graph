import type { Pool } from 'pg';
export declare class TenantMigrator {
    private templateDir;
    private pool;
    constructor(templateDir: string, pool: Pool);
    runMigrationForTenant(tenantSlug: string): Promise<void>;
    runMigrationForAllTenants(slugs: string[], parallel?: boolean): Promise<void>;
    rollbackMigration(tenantSlug: string, version: number): Promise<void>;
    private getSqlFiles;
}
//# sourceMappingURL=tenant-migrator.d.ts.map