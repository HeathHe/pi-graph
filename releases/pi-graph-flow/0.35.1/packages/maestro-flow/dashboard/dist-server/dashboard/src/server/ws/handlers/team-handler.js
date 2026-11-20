// ---------------------------------------------------------------------------
// TeamWsHandler — client-to-server team actions
//   team:message   -> send message to specific agent role in team session
//   team:broadcast -> broadcast message to all agents in team session
//   team:set_mode  -> toggle auto/manual mode for team session
//   team:approve   -> approve a pending action in team session
// ---------------------------------------------------------------------------
export class TeamWsHandler {
    eventBus;
    actions = [
        'team:message',
        'team:broadcast',
        'team:set_mode',
        'team:approve',
    ];
    constructor(eventBus) {
        this.eventBus = eventBus;
    }
    async handle(action, data, _ws, _broadcast) {
        const msg = data;
        switch (action) {
            case 'team:message': {
                const mailboxMessage = {
                    id: `tm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    from: 'user',
                    to: msg.to,
                    content: msg.content,
                    dispatch_status: 'pending',
                    timestamp: new Date().toISOString(),
                };
                this.eventBus.emit('team:message', mailboxMessage);
                break;
            }
            case 'team:broadcast': {
                const broadcastMessage = {
                    id: `tb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    from: 'user',
                    to: '*',
                    content: msg.content,
                    dispatch_status: 'pending',
                    timestamp: new Date().toISOString(),
                };
                this.eventBus.emit('team:dispatch', broadcastMessage);
                break;
            }
            case 'team:set_mode': {
                this.eventBus.emit('team:phase', {
                    current: msg.mode === 'auto' ? 'execution' : 'review',
                    history: [],
                    fixAttempts: 0,
                });
                break;
            }
            case 'team:approve': {
                const approvalMessage = {
                    id: `ta-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    from: 'user',
                    to: 'supervisor',
                    content: JSON.stringify({
                        type: 'approval',
                        requestId: msg.requestId,
                        allow: msg.allow,
                    }),
                    dispatch_status: 'pending',
                    timestamp: new Date().toISOString(),
                };
                this.eventBus.emit('team:message', approvalMessage);
                break;
            }
        }
    }
}
//# sourceMappingURL=team-handler.js.map