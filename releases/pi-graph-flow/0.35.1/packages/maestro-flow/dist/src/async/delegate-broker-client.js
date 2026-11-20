import { createDefaultDelegateBroker as createBroker } from './delegate-broker.js';
export class DelegateBrokerClient {
    broker;
    constructor(options = {}) {
        this.broker = options.broker ?? createBroker(options);
    }
    registerSession(input) {
        return this.broker.registerSession(input);
    }
    heartbeat(input) {
        return this.broker.heartbeat(input);
    }
    publishEvent(input) {
        return this.broker.publishEvent(input);
    }
    pollEvents(input) {
        return this.broker.pollEvents(input);
    }
    ack(input) {
        return this.broker.ack(input);
    }
    getJob(jobId) {
        return this.broker.getJob(jobId);
    }
    listJobEvents(jobId) {
        return this.broker.listJobEvents(jobId);
    }
    requestCancel(input) {
        return this.broker.requestCancel(input);
    }
    queueMessage(input) {
        return this.broker.queueMessage(input);
    }
    listMessages(jobId) {
        return this.broker.listMessages(jobId);
    }
    updateMessage(input) {
        return this.broker.updateMessage(input);
    }
    checkTimeouts(input) {
        return this.broker.checkTimeouts(input);
    }
    purgeExpiredEvents(input) {
        return this.broker.purgeExpiredEvents(input);
    }
}
//# sourceMappingURL=delegate-broker-client.js.map