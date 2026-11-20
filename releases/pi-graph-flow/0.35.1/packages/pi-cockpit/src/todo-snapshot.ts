import { TODO_STATE_ENTRY_TYPE } from "./types.ts";

export type TodoSourceAvailability = "available" | "empty" | "unavailable" | "unsupported";
export interface TodoEntry { readonly id?: string; readonly type?: string; readonly customType?: string; readonly data?: unknown }
/** Facts from the already-bound branch reader; not an access capability. */
export interface TodoProjectionSource {
 readonly cwd: string; readonly sessionId: string; readonly epoch: number;
 readonly branchIds: readonly string[];
}
export interface TodoSnapshotRead {
 readonly source?: TodoProjectionSource;
	readonly availability: TodoSourceAvailability;
	readonly tasks?: Record<string, unknown>;
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function actor(value: unknown): boolean {
	return record(value) && typeof value.id === "string" && typeof value.label === "string";
}
/** Decode the latest canonical entry only. A corrupt latest entry never reveals older state. */
export function decodeTodoSnapshot(entries: readonly TodoEntry[]): TodoSnapshotRead {
	const entry = [...entries].reverse().find((item) => item?.type === "custom" && item.customType === TODO_STATE_ENTRY_TYPE);
	if (!entry) return { availability: "empty" };
	if (!record(entry.data)) return { availability: "unavailable" };
	if (entry.data.version !== 9 && entry.data.version !== 10) return { availability: typeof entry.data.version === "number" ? "unsupported" : "unavailable" };
	const tasks = entry.data.tasks;
	if (!record(tasks)) return { availability: "unavailable" };
	for (const [id, task] of Object.entries(tasks)) {
		if (!record(task) || !id || task.id !== id || typeof task.subject !== "string"
			|| typeof task.status !== "string" || !["pending", "in_progress", "blocked", "completed", "deleted"].includes(task.status)
			|| !Array.isArray(task.blockedBy) || !task.blockedBy.every((dep) => typeof dep === "string" && dep.length > 0)
			|| !Array.isArray(task.skills) || !task.skills.every((skill) => record(skill) && typeof skill.name === "string"
				&& skill.name.length > 0 && (skill.role === undefined || typeof skill.role === "string"))
			|| !actor(task.createdBy) || !actor(task.assignee)
			|| typeof task.createdAt !== "number" || !Number.isFinite(task.createdAt)
			|| typeof task.updatedAt !== "number" || !Number.isFinite(task.updatedAt)) return { availability: "unavailable" };
	}
	return { availability: "available", tasks };
}

export interface TodoBranchManager {
	getSessionId(): string;
	getCwd(): string;
	getLeafId?(): string | null;
	getBranch?(): readonly TodoEntry[];
}
export interface TodoHost { readonly sessionManager: TodoBranchManager; readonly cwd: string }
/** A session binding, not a context-object identity. Every refresh reads this manager's current branch. */
export class TodoBranchReader {
	private binding?: { manager: TodoBranchManager; sessionId: string; cwd: string; epoch: number };
	bind(host: TodoHost, epoch: number): void {
		this.binding = undefined;
		try {
			if (host.sessionManager.getCwd() !== host.cwd) return;
			this.binding = { manager: host.sessionManager, sessionId: host.sessionManager.getSessionId(), cwd: host.cwd, epoch };
		} catch { /* read remains explicitly unavailable */ }
	}
	advanceEpoch(epoch: number): void { if (this.binding) this.binding = { ...this.binding, epoch }; }
	clear(): void { this.binding = undefined; }
	read(host: TodoHost | undefined, epoch: number): TodoSnapshotRead {
		const binding = this.binding;
		if (!binding || !host || binding.epoch !== epoch || host.sessionManager !== binding.manager || host.cwd !== binding.cwd) return { availability: "unavailable" };
		try {
			const manager = binding.manager;
			if (manager.getSessionId() !== binding.sessionId || manager.getCwd() !== binding.cwd) return { availability: "unavailable" };
			if (typeof manager.getBranch !== "function") return { availability: "unavailable" };
			const head = manager.getLeafId?.();
			const entries = manager.getBranch();
			if (!Array.isArray(entries) || manager.getLeafId?.() !== head || manager.getSessionId() !== binding.sessionId
				|| manager.getCwd() !== binding.cwd || this.binding !== binding) return { availability: "unavailable" };
			return {...decodeTodoSnapshot(entries), source:{cwd:binding.cwd,sessionId:binding.sessionId,epoch:binding.epoch,
                branchIds:entries.map(entry => entry.id).filter((id): id is string => typeof id === "string" && id.length > 0)}};
		} catch { return { availability: "unavailable" }; }
	}
}
