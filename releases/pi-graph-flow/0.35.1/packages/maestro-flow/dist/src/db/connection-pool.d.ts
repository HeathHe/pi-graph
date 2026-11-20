import { Pool, type PoolClient } from 'pg';
import { type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as coreSchema from './schema/core/index.js';
import { TenantMigrator } from './tenant-migrator.js';
export declare class TenantConnectionManager {
    private pool;
    constructor(databaseUrl: string, poolOptions?: {
        max?: number;
        idleTimeoutMillis?: number;
    });
    getTenantDb(tenantSlug: string): Promise<{
        db: NodePgDatabase<typeof coreSchema>;
        client: PoolClient;
    }>;
    releaseTenantConnection(client: PoolClient): Promise<void>;
    createNewTenant(slug: string, migrator: TenantMigrator): Promise<boolean>;
    removeTenant(slug: string): Promise<void>;
    close(): Promise<void>;
    getPool(): Pool;
}
//# sourceMappingURL=connection-pool.d.ts.map