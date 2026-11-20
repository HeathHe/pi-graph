/**
 * migrations/index.ts — Auto-registration of all migration scripts.
 *
 * Each migration file in this directory exports a default MigrationDef.
 * Import this module to register all migrations with the global registry.
 *
 * To add a new migration:
 *   1. Create src/migrations/v{FROM}-to-v{TO}.ts exporting default MigrationDef
 *   2. Import it below
 *   3. The registry auto-chains: from → to → from → to ...
 */
import { registry } from '../utils/migration-registry.js';
export { registry };
//# sourceMappingURL=index.d.ts.map