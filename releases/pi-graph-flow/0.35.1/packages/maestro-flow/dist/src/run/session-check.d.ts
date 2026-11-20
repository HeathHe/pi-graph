import type { ResolvedSession } from './session-resolver.js';
export interface SessionCheckFinding {
    level: 'E' | 'W';
    code: string;
    message: string;
    step_index?: number;
}
export declare function checkResolvedSession(projectRoot: string, resolved: ResolvedSession): SessionCheckFinding[];
export declare function summarizeSessionCheck(findings: SessionCheckFinding[]): {
    errors: number;
    warnings: number;
};
//# sourceMappingURL=session-check.d.ts.map