import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function createDurableFile(path: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
	const handle = await open(path, "wx", mode);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(path, { force: true }).catch(() => undefined);
		throw error;
	}
	await handle.close();
	await syncDirectory(dirname(path));
}

export async function createDurableJson(path: string, value: unknown): Promise<void> {
	await createDurableFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicWriteFile(path: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", mode);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	await handle.close();
	try {
		await rename(temporary, path);
		await syncDirectory(dirname(path));
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendDurable(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, content, { encoding: "utf8", flush: true });
}
