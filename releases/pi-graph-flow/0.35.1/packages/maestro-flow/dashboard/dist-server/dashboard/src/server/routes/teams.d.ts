import { Hono } from 'hono';
import { type TeamWorkLocation } from '../../../../src/tools/team-run-paths.js';
type TeamLocation = TeamWorkLocation;
export interface TeamRouteLifecycleOptions {
    now?: () => string | number | Date;
    staleTtlMs?: number;
    inspectLiveBrokerMembers?: (location: TeamLocation) => {
        count: number;
        known: boolean;
    };
}
export declare function createTeamRoutes(workflowRoot: string | (() => string), lifecycleOptions?: TeamRouteLifecycleOptions): Hono;
export {};
