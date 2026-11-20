/**
 * Maestro Statusline Hook — Two-line colored text
 *
 * Line 1: Model | Coordinator | Task | Team | Dir+Git | Context
 * Line 2: Milestone ◆Phase | Session chain (ANL-001→PLN-001→EXC-001→VRF-001 ✓)
 *
 * Input (stdin JSON from Claude Code):
 *   { model, workspace, session_id, context_window }
 *
 * Output (stdout): formatted ANSI string (1 or 2 lines)
 */
interface StatuslineInput {
    model?: {
        display_name?: string;
    };
    workspace?: {
        current_dir?: string;
    };
    session_id?: string;
    context_window?: {
        remaining_percentage?: number;
        total_input_tokens?: number;
        total_output_tokens?: number;
    };
    cost?: {
        total_lines_added?: number;
        total_lines_removed?: number;
    };
}
export declare function buildTeamSegment(session: string): string;
export declare function buildCoordinatorSegment(session: string): string;
/**
 * Main statusline handler.
 *
 * compact (default): Line 1 = all segments; Line 2 = workflow (if active)
 * expanded:          Line 1 = Model/Thinking/Coord/Task/Team
 *                    Line 2 = Dir+Git/Tokens/Context
 *                    Line 3 = workflow (if active)
 */
export declare function formatStatusline(data: StatuslineInput): string;
/** Entry point — reads stdin JSON, writes formatted statusline to stdout */
export declare function runStatusline(): void;
export {};
//# sourceMappingURL=statusline.d.ts.map