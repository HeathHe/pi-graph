// ---------------------------------------------------------------------------
// ExtensionManager -- Phase 1 registry that aggregates registered strategies,
// builders, and adapters into a unified ExtensionInfo[] list
// ---------------------------------------------------------------------------
export class ExtensionManager {
    eventBus;
    agentManager;
    promptRegistry;
    extensions = [];
    constructor(eventBus, agentManager, promptRegistry) {
        this.eventBus = eventBus;
        this.agentManager = agentManager;
        this.promptRegistry = promptRegistry;
    }
    /** Scan registries and emit extension_loaded event */
    init() {
        this.extensions.length = 0;
        try {
            // Enumerate prompt builders
            if (this.promptRegistry) {
                for (const name of this.promptRegistry.list()) {
                    this.extensions.push(this.toInfo(name, 'builder'));
                }
            }
            // Enumerate registered agent adapters
            for (const adapterType of this.agentManager.listAdapterTypes()) {
                this.extensions.push(this.toInfo(adapterType, 'adapter'));
            }
            this.eventBus.emit('supervisor:extension_loaded', {
                extensions: this.extensions,
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.eventBus.emit('supervisor:extension_error', {
                name: 'init',
                error: message,
            });
        }
    }
    /** Return all discovered extensions */
    listExtensions() {
        return [...this.extensions];
    }
    /** Find a single extension by name */
    getExtension(name) {
        return this.extensions.find((ext) => ext.name === name);
    }
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    toInfo(name, type) {
        return {
            name,
            version: '1.0.0',
            type,
            description: `${type}: ${name}`,
            status: 'enabled',
        };
    }
}
//# sourceMappingURL=extension-manager.js.map