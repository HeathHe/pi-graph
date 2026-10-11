import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

/** Metadata only. Never store secrets or infer successful login from a file timestamp. */
export interface LocalAuthRecord {
 provider: string;
 state: "oauth_saved" | "api_key_saved" | "missing" | "unavailable";
 hasRefresh?: boolean;
}
export function isAuthError(error: string): boolean {
 return /invalid_grant|\b401\b|refresh.token.*invalid|OAuth refresh failed/i.test(error);
}
export function authProvider(model: string | undefined): string | undefined {
 const provider = model?.split("/")[0];
 return model?.includes("/") && provider && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(provider) ? provider : undefined;
}
/** No SDK auth resolution: it can run configured commands or refresh tokens. */
export async function readLocalAuthRecords(providers: readonly string[], agentDir?: string): Promise<Record<string, LocalAuthRecord>> {
 const result: Record<string, LocalAuthRecord> = Object.create(null);
 const valid = [...new Set(providers)].filter(p => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(p));
 if (!valid.length) return result;
 const setAll = (state: LocalAuthRecord["state"]) => { for (const provider of valid) result[provider] = { provider, state }; };
 let file;
 try {
  const directory = agentDir ?? (await import("@earendil-works/pi-coding-agent")).getAgentDir();
  file = await open(join(directory,"auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 }
 catch (e) { setAll((e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable"); return result; }
 try {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > 1_048_576) throw new Error("Invalid auth record file");
  const data = JSON.parse((await file.readFile("utf8")).replace(/^\uFEFF/,""));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid auth record");
  for (const provider of valid) {
   const c = Object.hasOwn(data,provider) ? data[provider] : undefined;
   let state: LocalAuthRecord["state"] = c === undefined ? "missing" : "unavailable";
   if (c?.type === "oauth" && typeof c.access === "string" && c.access.length && typeof c.refresh === "string" && Number.isFinite(c.expires)) state = "oauth_saved";
   if (c?.type === "api_key" && (typeof c.key === "string" && c.key.trim().length || c.env && typeof c.env === "object" && !Array.isArray(c.env) && Object.keys(c.env).length)) state = "api_key_saved";
   result[provider] = { provider, state, ...(state === "oauth_saved" ? { hasRefresh: !!c.refresh } : {}) };
  }
 } catch { setAll("unavailable"); }
 finally { await file.close(); }
 return result;
}
