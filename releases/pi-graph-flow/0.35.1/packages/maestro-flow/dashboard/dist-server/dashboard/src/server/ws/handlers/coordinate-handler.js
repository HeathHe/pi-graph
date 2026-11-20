// ---------------------------------------------------------------------------
// CoordinateWsHandler — coordinate:start, coordinate:stop,
//                        coordinate:resume, coordinate:clarify
// ---------------------------------------------------------------------------
export class CoordinateWsHandler {
    coordinateRunner;
    actions = [
        'coordinate:start',
        'coordinate:stop',
        'coordinate:resume',
        'coordinate:clarify',
    ];
    constructor(coordinateRunner) {
        this.coordinateRunner = coordinateRunner;
    }
    async handle(action, data, _ws, _broadcast) {
        const msg = data;
        switch (action) {
            case 'coordinate:start':
                await this.coordinateRunner.start(msg.intent, { tool: msg.tool, autoMode: msg.autoMode });
                break;
            case 'coordinate:stop':
                await this.coordinateRunner.stop();
                break;
            case 'coordinate:resume':
                await this.coordinateRunner.resume(msg.sessionId);
                break;
            case 'coordinate:clarify':
                await this.coordinateRunner.clarify(msg.sessionId, msg.response);
                break;
        }
    }
}
//# sourceMappingURL=coordinate-handler.js.map