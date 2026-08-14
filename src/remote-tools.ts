const MUTATING_REMOTE_VERBS = new Set([
	"send", "create", "update", "write", "edit", "delete", "remove", "destroy", "post", "put", "patch", "publish", "deploy", "pay", "payment", "transfer", "purchase", "commit", "merge", "invite", "grant", "revoke", "upload", "execute", "run",
	"mark", "set", "add", "trash", "archive", "move", "modify", "label", "star", "flag", "reply", "forward", "rename", "assign", "cancel", "import", "sync", "empty", "purge", "watch", "block", "mute", "upsert", "schedule", "subscribe", "unsubscribe", "approve", "reject", "accept", "decline", "close", "resolve", "reopen", "restore", "submit", "save", "draft", "comment", "react", "like", "unlike", "follow", "unfollow", "pin", "unpin", "link", "unlink", "share", "copy", "replace", "append", "prepend", "enable", "disable", "start", "stop", "pause", "resume", "trigger", "rotate", "reset", "lock", "unlock", "join", "leave", "acknowledge", "dismiss", "snooze",
]);
const READ_REMOTE_VERBS = new Set(["get", "list", "search", "read", "fetch", "query", "lookup", "inspect", "view", "download", "find", "navigate", "open"]);

function remoteToolNameTokens(toolName: string): string[] {
	return toolName
		.replace(/([a-z\d])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z\d]+/)
		.filter(Boolean)
		.map((token) => token.toLowerCase());
}

export function isReadOnlyRemoteToolName(toolName: string): boolean {
	const tokens = remoteToolNameTokens(toolName);
	const firstOperation = tokens.find((token) => READ_REMOTE_VERBS.has(token) || MUTATING_REMOTE_VERBS.has(token));
	return firstOperation !== undefined && READ_REMOTE_VERBS.has(firstOperation) && !tokens.some((token) => MUTATING_REMOTE_VERBS.has(token));
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => [key, canonical(child)]));
}

export function canonicalRemoteToolInput(value: unknown): string {
	return JSON.stringify(canonical(value));
}
