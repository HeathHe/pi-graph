// ---------------------------------------------------------------------------
// CommanderWsHandler — commander:start, commander:stop, commander:pause,
//                      commander:config
// ---------------------------------------------------------------------------
export class CommanderWsHandler {
    commanderAgent;
    actions = [
        'commander:start',
        'commander:stop',
        'commander:pause',
        'commander:config',
    ];
    constructor(commanderAgent) {
        this.commanderAgent = commanderAgent;
    }
    async handle(action, data, _ws, _broadcast) {
        const msg = data;
        switch (action) {
            case 'commander:start':
                await this.commanderAgent.start();
                break;
            case 'commander:stop':
                this.commanderAgent.stop();
                break;
            case 'commander:pause': {
                const state = this.commanderAgent.getState();
                if (state.status === 'paused') {
                    this.commanderAgent.resume();
                }
                else {
                    this.commanderAgent.pause();
                }
                break;
            }
            case 'commander:config':
                this.commanderAgent.updateConfig(msg.config);
                break;
        }
    }
}
//# sourceMappingURL=commander-handler.js.map