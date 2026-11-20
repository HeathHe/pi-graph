// ---------------------------------------------------------------------------
// SkillPromptBuilder — builds prompt referencing issue metadata for skill mode
// ---------------------------------------------------------------------------
// Extracted from ExecutionScheduler.buildPrompt() 'skill' mode branch.
// ---------------------------------------------------------------------------
export class SkillPromptBuilder {
    name = 'skill';
    async build(context) {
        const { issue } = context;
        const lines = [
            `Execute the following issue:`,
            '',
            `Issue ID: ${issue.id}`,
            `Title: ${issue.title}`,
            `Type: ${issue.type}`,
            `Priority: ${issue.priority}`,
            '',
            `Description:`,
            issue.description,
        ];
        if (issue.analysis?.suggested_approach) {
            lines.push('', `Suggested approach: ${issue.analysis.suggested_approach}`);
        }
        if (issue.analysis?.related_files && issue.analysis.related_files.length > 0) {
            lines.push(`Key files: ${issue.analysis.related_files.join(', ')}`);
        }
        return { userPrompt: lines.join('\n'), mode: 'skill' };
    }
}
//# sourceMappingURL=skill-builder.js.map