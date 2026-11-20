import type { Command } from 'commander';
import { type DelegateBrokerApi } from '../async/delegate-broker.js';
export declare function resolveReportPath(sessionDir: string, sessionId: string, nodeId: string): string;
/** Test-only: inject a broker instance for `maestro coordinate watch`. */
export declare function __setCoordinateBrokerForTests(broker: DelegateBrokerApi | null): void;
export declare function registerCoordinateCommand(program: Command): void;
//# sourceMappingURL=coordinate.d.ts.map