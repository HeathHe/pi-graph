/** Apply explicit semantic overrides before generic Codex tool-name conversion. */
export declare function applyCodexAgentOverrides(agentName: string, body: string, overrideDir: string): string;
/** Codex collaboration tools are not a Claude-style shared task board. */
export declare function assertNoUnsupportedCodexTaskBoardTokens(agentName: string, body: string): void;
export interface CodexAgentLintIssue {
    rule: string;
    message: string;
}
/** Lightweight TOML/content lint for generated Codex agent definitions. */
export declare function lintCodexAgentToml(fileName: string, content: string): CodexAgentLintIssue[];
//# sourceMappingURL=codex-agent-overrides.d.ts.map