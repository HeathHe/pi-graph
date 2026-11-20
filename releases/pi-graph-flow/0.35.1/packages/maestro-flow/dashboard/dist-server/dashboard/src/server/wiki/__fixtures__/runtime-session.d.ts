export interface RuntimeSessionFixture {
    projectRoot: string;
    workflowRoot: string;
    sessionId: string;
    runId: string;
    summary: string;
    kind: string;
    session: Record<string, unknown>;
    run: Record<string, unknown>;
}
/** Generate canonical Session/Run files through the runtime writer, not hand-authored JSON. */
export declare function createRuntimeSessionFixture(projectRoot: string): RuntimeSessionFixture;
