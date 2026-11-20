// ---------------------------------------------------------------------------
// RequirementWsHandler — requirement:expand, requirement:refine,
//                         requirement:commit
// ---------------------------------------------------------------------------
export class RequirementWsHandler {
    requirementExpander;
    actions = [
        'requirement:expand',
        'requirement:refine',
        'requirement:commit',
    ];
    constructor(requirementExpander) {
        this.requirementExpander = requirementExpander;
    }
    async handle(action, data, _ws, broadcast) {
        const msg = data;
        switch (action) {
            case 'requirement:expand': {
                const requirement = await this.requirementExpander.expand(msg.text, msg.depth, msg.method, msg.previousRequirementId);
                broadcast('requirement:expanded', { requirement });
                break;
            }
            case 'requirement:refine': {
                const requirement = await this.requirementExpander.refine(msg.requirementId, msg.feedback);
                broadcast('requirement:expanded', { requirement });
                break;
            }
            case 'requirement:commit': {
                if (msg.mode === 'issues') {
                    const issueIds = await this.requirementExpander.commitAsIssues(msg.requirementId);
                    broadcast('requirement:committed', {
                        requirementId: msg.requirementId,
                        mode: 'issues',
                        issueIds,
                    });
                }
                else {
                    const coordinateSessionId = await this.requirementExpander.commitAsCoordinate(msg.requirementId);
                    broadcast('requirement:committed', {
                        requirementId: msg.requirementId,
                        mode: 'coordinate',
                        coordinateSessionId,
                    });
                }
                break;
            }
        }
    }
}
//# sourceMappingURL=requirement-handler.js.map