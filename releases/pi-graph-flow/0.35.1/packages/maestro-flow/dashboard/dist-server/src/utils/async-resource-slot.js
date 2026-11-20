/**
 * Serializes use and replacement of one keyed async resource.
 * A superseded resource is closed only after its current borrower finishes.
 */
export class AsyncResourceSlot {
    current = null;
    tail = Promise.resolve();
    run(key, create, use) {
        const operation = this.tail.then(async () => {
            if (!this.current || !Object.is(this.current.key, key)) {
                const replacement = await create();
                const previous = this.current;
                if (previous) {
                    try {
                        await previous.resource.close();
                    }
                    catch (error) {
                        await replacement.close().catch(() => undefined);
                        throw error;
                    }
                }
                this.current = { key, resource: replacement };
            }
            return use(this.current.resource);
        });
        this.tail = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async close() {
        await this.tail;
        const current = this.current;
        this.current = null;
        if (current)
            await current.resource.close();
    }
}
//# sourceMappingURL=async-resource-slot.js.map