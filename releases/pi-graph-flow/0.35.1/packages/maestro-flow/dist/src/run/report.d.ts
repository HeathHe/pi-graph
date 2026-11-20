import { type Handoff, type ReportFrontmatter } from './schemas.js';
export type { ReportFrontmatter };
export declare function readReportFrontmatter(runDir: string): ReportFrontmatter;
export declare function deriveHandoff(frontmatter: ReportFrontmatter, runId: string, command: string, artifactRefs: string[], evidenceRefs: string[]): Handoff;
//# sourceMappingURL=report.d.ts.map