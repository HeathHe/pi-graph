export class ToolRegistry {
    tools = new Map();
    register(tool) {
        if (this.tools.has(tool.name)) {
            throw new Error(`Tool "${tool.name}" is already registered`);
        }
        this.tools.set(tool.name, tool);
    }
    unregister(name) {
        return this.tools.delete(name);
    }
    get(name) {
        return this.tools.get(name);
    }
    list() {
        return Array.from(this.tools.values());
    }
    async execute(name, input) {
        const tool = this.tools.get(name);
        if (!tool) {
            return {
                content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }
        return tool.handler(input);
    }
}
//# sourceMappingURL=tool-registry.js.map