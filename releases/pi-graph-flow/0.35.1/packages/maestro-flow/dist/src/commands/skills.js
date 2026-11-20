async function loadSkillsCommand() {
    return (await import('../skills/cmd-skills.js')).runSkills;
}
export function registerSkillsCommand(program) {
    program
        .command('skills')
        .description('List effective commands, Skills, and optional Run-resolvable steps')
        .option('--json', 'Machine-readable output (one JSON line per entry)')
        .option('--quiet', 'Suppress decorative output')
        .option('--platform <platform>', 'Filter by platform: claude | codex | agent | agy | pi')
        .option('--steps', 'Include prepare/workflow step names resolvable by maestro run next')
        .action(async (opts) => {
        const run = await loadSkillsCommand();
        const code = await run({
            json: Boolean(opts.json),
            quiet: Boolean(opts.quiet),
            platform: opts.platform,
            steps: Boolean(opts.steps),
        });
        process.exitCode = code;
    });
}
//# sourceMappingURL=skills.js.map