import { drizzle } from 'drizzle-orm/node-postgres';
import * as coreSchema from './schema/core/index.js';
export function createDb(databaseUrl) {
    return drizzle(databaseUrl, {
        schema: coreSchema,
    });
}
export { coreSchema };
//# sourceMappingURL=index.js.map