// ---------------------------------------------------------------------------
// AgentAdapter interface + BaseAgentAdapter abstract class
// Protocol-agnostic agent abstraction layer
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
// ---------------------------------------------------------------------------
// BaseAgentAdapter — abstract base with shared lifecycle management
// ---------------------------------------------------------------------------
/** Abstract base class providing process tracking and event callback plumbing */
export class BaseAgentAdapter {
    processes = new Map();
    entryCallbacks = new Map();
    approvalCallbacks = new Map();
    // --- Public interface (delegates to abstract hooks) ---------------------
    async spawn(config) {
        const processId = this.generateProcessId();
        const process = await this.doSpawn(processId, config);
        this.addProcess(process);
        return process;
    }
    async stop(processId) {
        this.requireProcess(processId);
        await this.doStop(processId);
        this.removeProcess(processId);
    }
    async sendMessage(processId, content) {
        this.requireProcess(processId);
        await this.doSendMessage(processId, content);
    }
    onEntry(processId, cb) {
        let set = this.entryCallbacks.get(processId);
        if (!set) {
            set = new Set();
            this.entryCallbacks.set(processId, set);
        }
        set.add(cb);
        return () => {
            set.delete(cb);
            if (set.size === 0) {
                this.entryCallbacks.delete(processId);
            }
        };
    }
    onApproval(processId, cb) {
        let set = this.approvalCallbacks.get(processId);
        if (!set) {
            set = new Set();
            this.approvalCallbacks.set(processId, set);
        }
        set.add(cb);
        return () => {
            set.delete(cb);
            if (set.size === 0) {
                this.approvalCallbacks.delete(processId);
            }
        };
    }
    async respondApproval(decision) {
        await this.doRespondApproval(decision);
    }
    getProcess(processId) {
        return this.processes.get(processId);
    }
    listProcesses() {
        return Array.from(this.processes.values());
    }
    supportsInteractive() {
        return false;
    }
    endInput(_processId) {
        // No-op default — override in interactive adapters that need stdin close
    }
    // --- Protected helpers for subclasses -----------------------------------
    /** Generate a unique process ID */
    generateProcessId() {
        return randomUUID();
    }
    /** Emit a normalized entry to all registered listeners for a process */
    emitEntry(processId, entry) {
        const set = this.entryCallbacks.get(processId);
        if (set) {
            for (const cb of set) {
                cb(entry);
            }
        }
    }
    /** Emit an approval request to all registered listeners for a process */
    emitApproval(processId, request) {
        const set = this.approvalCallbacks.get(processId);
        if (set) {
            for (const cb of set) {
                cb(request);
            }
        }
    }
    /** Add a process to the internal tracking map */
    addProcess(process) {
        this.processes.set(process.id, process);
    }
    /** Remove a process and clean up all associated callbacks */
    removeProcess(processId) {
        this.processes.delete(processId);
        this.entryCallbacks.delete(processId);
        this.approvalCallbacks.delete(processId);
    }
    // --- Private helpers ----------------------------------------------------
    requireProcess(processId) {
        if (!this.processes.has(processId)) {
            throw new Error(`No process found with id: ${processId}`);
        }
    }
}
//# sourceMappingURL=base-adapter.js.map