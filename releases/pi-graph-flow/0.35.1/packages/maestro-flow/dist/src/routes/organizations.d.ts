import { Hono } from 'hono';
import { TenantConnectionManager } from '../db/connection-pool.js';
import { TenantMigrator } from '../db/tenant-migrator.js';
export declare function createOrgRoutes(db: any, tenantManager: TenantConnectionManager, migrator: TenantMigrator): Hono;
//# sourceMappingURL=organizations.d.ts.map