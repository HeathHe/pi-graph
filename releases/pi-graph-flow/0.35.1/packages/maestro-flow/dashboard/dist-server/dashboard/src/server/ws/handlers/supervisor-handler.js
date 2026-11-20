import { WebSocket } from 'ws';
// ---------------------------------------------------------------------------
// SupervisorWsHandler -- real-time supervisor data queries
//   supervisor:learning  -> returns current learning stats
//   supervisor:schedule  -> returns current scheduled tasks
// ---------------------------------------------------------------------------
export class SupervisorWsHandler {
    learningService;
    schedulerService;
    actions = [
        'supervisor:learning',
        'supervisor:schedule',
    ];
    constructor(learningService, schedulerService) {
        this.learningService = learningService;
        this.schedulerService = schedulerService;
    }
    async handle(action, data, ws, _broadcast) {
        if (ws.readyState !== WebSocket.OPEN)
            return;
        switch (action) {
            case 'supervisor:learning': {
                const stats = this.learningService.getStats();
                ws.send(JSON.stringify({ type: 'supervisor:learning_update', data: stats }));
                break;
            }
            case 'supervisor:schedule': {
                const tasks = this.schedulerService.listTasks();
                ws.send(JSON.stringify({ type: 'supervisor:schedule_update', data: { tasks } }));
                break;
            }
        }
    }
}
//# sourceMappingURL=supervisor-handler.js.map