import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

let currentProcessIdentity: Promise<string | undefined> | undefined;

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function psProcessIdentity(pid: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 1_000 }, (error, stdout) => {
			if (error) {
				resolve(undefined);
				return;
			}
			const value = stdout.trim().replace(/\s+/g, " ");
			resolve(value ? `ps:${value}` : undefined);
		});
	});
}

/** PID 启动身份，防 PID 复用（与 src/claims.ts 同语义，供 V3 内核自包含使用）。 */
export async function processIdentityForPid(pid: number): Promise<string | undefined> {
	if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return undefined;
	if (pid === process.pid && currentProcessIdentity) return currentProcessIdentity;
	const resolveIdentity = async () => {
		if (process.platform === "linux") {
			try {
				const stat = await readFile(`/proc/${pid}/stat`, "utf8");
				const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
				const startedAtTick = fields[19];
				if (startedAtTick && /^[0-9]+$/.test(startedAtTick)) return `linux:${startedAtTick}`;
			} catch {
				// Fall through to ps on systems without a readable procfs.
			}
		}
		return psProcessIdentity(pid);
	};
	if (pid !== process.pid) return resolveIdentity();
	const pending = resolveIdentity();
	currentProcessIdentity = pending;
	const identity = await pending;
	if (!identity && currentProcessIdentity === pending) currentProcessIdentity = undefined;
	return identity;
}
