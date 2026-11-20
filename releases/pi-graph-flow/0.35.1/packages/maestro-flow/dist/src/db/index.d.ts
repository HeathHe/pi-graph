import * as coreSchema from './schema/core/index.js';
export declare function createDb(databaseUrl: string): import("drizzle-orm/node-postgres").NodePgDatabase<typeof coreSchema> & {
    $client: import("pg").Pool;
};
export { coreSchema };
//# sourceMappingURL=index.d.ts.map