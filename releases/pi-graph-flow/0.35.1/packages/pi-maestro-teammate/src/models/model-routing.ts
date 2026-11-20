import { modelMappingUpdate, thinkingLevelUpdate, fastModeUpdate, fallbackMappingUpdate, roleMappingUpdate, typeRolesUpdate, typeMetaUpdate, customTypeUpdate, deleteCustomTypeUpdate, profileNameUpdate, requireRoutingProfileName, addRoutingProfile, setRoutingDefaultProfile, activateRoutingProjectProfile, setRoutingProjectOverridesEnabled, clearRoutingProjectOverrides, promoteRoutingProjectOverrides, assertDeletableRoutingProfile, deleteRoutingProfile } from 'pi-graph-model-role';
import { cloneRules, normalizeRules, normalizeProjectStore, requireProfile, sortedProfileSummaries, resolveProfileId, resolveRoutingState, discoverRoutingTaskTypesFromConfig, deriveRoleSelectionSource, resolveTaskRoutingFields, normalizeGlobalStore as normalizeRoutingGlobalStore, createModelRoutingEligibility as eligibility, canonicalModelRegistrationId as canonicalRegistration, TEAMMATE_SMART_MODES, type TeammateSmartMode, type ModelRoutingRoleRules, type ModelRoutingTypeMeta, type ModelRoutingRules, type ModelRoutingProfile, type GlobalModelRoutingStore, type ProjectModelRoutingStore, type ModelRoutingConfig, type ModelRoutingState, type SessionModelRoutingStore, type ModelRoutingProfileSummary } from 'pi-graph-model-role';
export { validateModelRoutingV3Rules, validateModelRoutingV4Rules, resolveTaskTypeMeta, inferTaskType, inferTaskTypeByKeywords, isModelRoutingProfileId, resolveModelRegistrationRouting, canHotSwitchModelRegistration, TEAMMATE_SMART_MODES } from 'pi-graph-model-role';
export type { ModelRoutingRoleRules, ModelRoutingTypeMeta, ModelRoutingRules, ModelRoutingProfile, GlobalModelRoutingStore, ProjectModelRoutingStore, ModelRoutingConfig, ModelRoutingState, TaskTypeInput, SessionModelRoutingStore, ModelRoutingProfileSummary, ModelRegistrationRoutingInput, ResolvedModelRegistrationCandidate, ResolvedModelRegistrationRouting, TeammateSmartMode } from 'pi-graph-model-role';
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TeammateModelCapability } from "./model-catalog.ts";
import { selectModel, verifySelection, snapshotHash, type SelectionDecision } from "pi-graph-model-role";
import { execFileSync } from "node:child_process";
import { logDiagnosticError } from "../shared/diagnostic-log.ts";

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunTeammateParams } from "../runs/execution.ts";
import { resolveAgent, inspectBuiltinRoleModelSource, type AgentConfig } from "../agents/agents.ts";
import { TEAMMATE_TASK_TYPES, type TeammateTaskType } from "../shared/task-types.ts";
import { parseTeammateThinkingLevel, type TeammateThinkingLevel } from "../shared/thinking.ts";
import {
  BACKGROUND_STATUS_HEARTBEAT_DEFAULT_MS,
  BACKGROUND_STATUS_HEARTBEAT_MAX_MS,
  BACKGROUND_STATUS_HEARTBEAT_MIN_MS,
} from "../shared/limits.ts";
import type { ModelCircuitBreaker, ModelHealthCoordinator } from "./model-circuit-breaker.ts";
import type { DispatchAuthorityProjection } from "./model-registry.ts";

export { TEAMMATE_TASK_TYPES, parseTeammateTaskType } from "../shared/task-types.ts";
export type { TeammateTaskType } from "../shared/task-types.ts";


function canonical(id: string, authority?: DispatchAuthorityProjection): string {
  return authority ? canonicalRegistration(authority, id) : id;
}

export const TEAMMATE_TASK_TYPE_META: Record<
  string,
  { label: string; roles: string; description: string }
> = {
  explore: { label: "Explore", roles: "explorer", description: "File discovery, definitions, and call sites" },
  analysis: { label: "Analysis", roles: "analyst / research / general", description: "Read-only tracing and technical investigation" },
  debug: { label: "Debug", roles: "analyst / general", description: "Root-cause diagnosis and runtime debugging" },
  planning: { label: "Planning", roles: "planner / workflow", description: "Architecture and execution planning" },
  development: { label: "Development", roles: "general", description: "Implementation and refactoring" },
  review: { label: "Review", roles: "analyst", description: "Correctness, quality, and security review" },
  testing: { label: "Testing", roles: "general / analyst", description: "Tests, coverage, and regression validation" },
};

interface ModelRoutingTransaction {
  version: 1;
  mode: "forward" | "rollback";
  projectFilePath: string;
  globalBefore: GlobalModelRoutingStore;
  globalAfter: GlobalModelRoutingStore;
  projectAfter: ProjectModelRoutingStore;
  /** Preserve pre-migration bytes across Settings rollback and crash recovery. */
  content?: { globalBefore: string; globalAfter?: string; projectAfter?: string };
}

const CONFIG_FILE = "teammate-models.json";
const LOCK_WAIT_MS = 15_000;
const LOCK_RENAME_WAIT_MS = 1_000;
const LOCK_RETRY_MS = 20;
const LOCK_IDENTITY_CHECK_MS = 5_000;

export function getGlobalModelRoutingPath(agentDir = getAgentDir()): string {
  return path.join(agentDir, "pi-graph-next", CONFIG_FILE);
}

export function getProjectModelRoutingPath(cwd: string): string {
  return path.join(cwd, ".pi", "pi-graph-next", CONFIG_FILE);
}

/**
 * Per-session routing overrides file path. The sessionId is sanitized to a
 * filesystem-safe slug so an untrusted id cannot escape the `.pi/` directory.
 * Session overrides stack on top of project overrides at the task-type mapping
 * layer and are scoped to the single Pi session that wrote them.
 */
export function getSessionModelRoutingPath(cwd: string, sessionId: string): string {
  // Strip everything except [a-zA-Z0-9_-] and collapse runs so an untrusted
  // session id cannot smuggle path separators or traversal sequences into the
  // `.pi/` directory. Dots are excluded on purpose: a slug like `..etcpasswd`
  // would otherwise survive path.join and leak a traversal into the filename.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unknown";
  return path.join(cwd, ".pi", "pi-graph-next", `teammate-models.session.${safe}.json`);
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in teammate model config: ${filePath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid teammate model config object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}
function normalizeGlobalStore(parsed: Record<string, unknown> | undefined): GlobalModelRoutingStore {
  return normalizeRoutingGlobalStore(parsed, { heartbeatMinMs: BACKGROUND_STATUS_HEARTBEAT_MIN_MS, heartbeatMaxMs: BACKGROUND_STATUS_HEARTBEAT_MAX_MS });
}

function readGlobalStore(filePath = getGlobalModelRoutingPath()): GlobalModelRoutingStore {
  return normalizeGlobalStore(readJsonObject(filePath));
}

function readProjectStore(filePath: string): ProjectModelRoutingStore {
  return normalizeProjectStore(readJsonObject(filePath));
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

interface ConfigLockOwner {
  version: 1;
  pid: number;
  token: string;
  createdAtMs: number;
  startedAtMs: number;
  startIdentity?: string;
  startObserved?: boolean;
}

function lockOwner(lockPath: string): ConfigLockOwner | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as Partial<ConfigLockOwner>;
    if (
      parsed.version !== 1
      || typeof parsed.pid !== "number"
      || !Number.isInteger(parsed.pid)
      || typeof parsed.token !== "string"
      || !/^[a-f0-9-]{36}$/.test(parsed.token)
      || typeof parsed.createdAtMs !== "number"
      || !Number.isFinite(parsed.createdAtMs)
      || typeof parsed.startedAtMs !== "number"
      || !Number.isFinite(parsed.startedAtMs)
      || (parsed.startIdentity !== undefined && typeof parsed.startIdentity !== "string")
      || (parsed.startObserved !== undefined && typeof parsed.startObserved !== "boolean")
    ) return undefined;
    return parsed as ConfigLockOwner;
  } catch {
    return undefined;
  }
}

interface ProcessStartObservation {
  identity?: string;
  startedAtMs?: number;
}

const nextIdentityCheck = new Map<string, number>();
let ownStartObservation: ProcessStartObservation | undefined;
let ownStartObservationLoaded = false;

function processStartObservation(pid: number): ProcessStartObservation | undefined {
  try {
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
      const startTime = fields[19];
      return startTime ? { identity: `linux:${startTime}` } : undefined;
    }
    if (process.platform === "win32") {
      const output = execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`,
      ], {
        encoding: "utf8",
        timeout: 2_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const startedAtMs = Number(output);
      return Number.isFinite(startedAtMs) ? { startedAtMs } : undefined;
    }
    const output = execFileSync("ps", ["-o", "state=", "-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
    const [state, ...startedAtParts] = output.split(/\s+/);
    if (state?.startsWith("Z")) return { identity: "dead:zombie" };
    const startedAtMs = Date.parse(startedAtParts.join(" "));
    return Number.isFinite(startedAtMs) ? { startedAtMs } : undefined;
  } catch {
    return undefined;
  }
}

function currentProcessStartObservation(): ProcessStartObservation | undefined {
  if (!ownStartObservationLoaded) {
    ownStartObservation = processStartObservation(process.pid);
    ownStartObservationLoaded = true;
  }
  return ownStartObservation;
}

function lockOwnerIsLive(lockPath: string, owner: ConfigLockOwner): boolean {
  // A process start that was explicitly observed cannot be the Unix epoch for
  // a live Pi process. Treat contradictory owner metadata as stale instead of
  // letting a recycled PID hold the lock when process inspection is unavailable.
  if (owner.startObserved && owner.startedAtMs <= 0) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
  if (Date.now() - owner.createdAtMs < LOCK_IDENTITY_CHECK_MS) return true;
  const checkKey = `${lockPath}:${owner.token}`;
  const now = Date.now();
  if ((nextIdentityCheck.get(checkKey) ?? 0) > now) return true;
  nextIdentityCheck.set(checkKey, now + 1_000);
  const observed = processStartObservation(owner.pid);
  if (!observed) return true;
  if (observed.identity === "dead:zombie") return false;
  if (owner.startIdentity && observed.identity) return owner.startIdentity === observed.identity;
  if (owner.startObserved && observed.startedAtMs !== undefined) {
    return Math.abs(observed.startedAtMs - owner.startedAtMs) <= 2_000;
  }
  return true;
}

function reclaimDeadLock(lockPath: string): boolean {
  const owner = lockOwner(lockPath);
  if (!owner || lockOwnerIsLive(lockPath, owner)) return false;
  const quarantinePath = `${lockPath}.stale.${owner.token}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
    nextIdentityCheck.delete(`${lockPath}:${owner.token}`);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return true;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM" || code === "EACCES") return false;
    throw error;
  }
}

function renameLockDirectory(sourcePath: string, destinationPath: string): void {
  const startedAt = Date.now();
  while (true) {
    try {
      fs.renameSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      const code = errorCode(error);
      if ((code !== "EPERM" && code !== "EACCES") || Date.now() - startedAt >= LOCK_RENAME_WAIT_MS) throw error;
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function withConfigLock<T>(filePath: string, action: () => T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const token = randomUUID();
  const candidatePath = `${lockPath}.candidate.${process.pid}.${token}`;
  const observedStart = currentProcessStartObservation();
  const startedAtMs = observedStart?.startedAtMs ?? Date.now() - process.uptime() * 1_000;
  const owner: ConfigLockOwner = {
    version: 1,
    pid: process.pid,
    token,
    createdAtMs: Date.now(),
    startedAtMs,
    ...(observedStart?.identity ? { startIdentity: observedStart.identity } : {}),
    ...(observedStart?.startedAtMs !== undefined ? { startObserved: true } : {}),
  };
  const startedAt = Date.now();
  let acquired = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    fs.mkdirSync(candidatePath, { mode: 0o700 });
    fs.writeFileSync(path.join(candidatePath, "owner.json"), JSON.stringify(owner), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    while (!acquired) {
      try {
        fs.renameSync(candidatePath, lockPath);
        acquired = true;
      } catch (error) {
        const code = errorCode(error);
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") throw error;
        if (reclaimDeadLock(lockPath)) continue;
        if (Date.now() - startedAt >= LOCK_WAIT_MS) {
          throw new Error(`Timed out waiting for teammate model config lock: ${lockPath}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    return action();
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    if (!acquired) {
      try {
        fs.rmSync(candidatePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch (cleanupError) {
        if (operationFailed) {
          throw new AggregateError(
            [operationError, cleanupError],
            `Teammate model lock initialization and candidate cleanup both failed: ${candidatePath}`,
          );
        }
        throw cleanupError;
      }
    } else {
      const current = lockOwner(lockPath);
      if (current?.token !== token) throw new Error(`Teammate model config lock ownership changed: ${lockPath}`);
      const releasedPath = `${lockPath}.released.${token}`;
      renameLockDirectory(lockPath, releasedPath);
      nextIdentityCheck.delete(`${lockPath}:${token}`);
      try {
        fs.rmSync(releasedPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // The canonical lock is already released. Cleanup failure must not invalidate a committed action.
      }
    }
  }
}

function withGlobalConfigLock<T>(globalFilePath: string, action: () => T): T {
  return withConfigLock(globalFilePath, () => {
    recoverPendingTransactionLocked(globalFilePath);
    return action();
  });
}

function withGlobalAndProjectLocks<T>(
  cwd: string,
  globalFilePath: string,
  action: (projectFilePath: string) => T,
): T {
  const projectFilePath = path.resolve(getProjectModelRoutingPath(cwd));
  return withGlobalConfigLock(globalFilePath, () =>
    withConfigLock(projectFilePath, () => action(projectFilePath))
  );
}

function fsyncDirectory(directoryPath: string): void {
  if (process.platform === "win32") return;
  const handle = fs.openSync(directoryPath, "r");
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function fsyncFile(filePath: string): void {
  const handle = fs.openSync(filePath, "r+");
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

class PublishedWriteError extends Error {
  readonly published = true;

  constructor(filePath: string, cause: unknown) {
    super(`Teammate model config was published but durability sync failed: ${filePath}`, { cause });
  }
}

function isPublishedWriteError(error: unknown): error is PublishedWriteError {
  return error instanceof PublishedWriteError;
}

function writeJson(filePath: string, value: unknown, content?: string): void {
  if (content === "") { fs.rmSync(filePath, { force: true }); return; }
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  let published = false;
  try {
    handle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(handle, content ?? `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporaryPath, filePath);
    published = true;
    fsyncFile(filePath);
    fsyncDirectory(directoryPath);
  } catch (error) {
    if (published) throw new PublishedWriteError(filePath, error);
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
}

/**
 * Write a single store and, if the rename already published the new bytes before a
 * durability-sync failure, immediately restore the previous value so a failed single-file
 * commit cannot leave a published-but-unreported change on disk.
 */
function writeJsonRestoringOnPublish(filePath: string, next: unknown, previous: unknown, previousContent?: string, nextContent?: string): void {
  try {
    writeJson(filePath, next, nextContent);
  } catch (error) {
    if (!isPublishedWriteError(error)) throw error;
    try {
      writeJson(filePath, previous, previousContent);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Teammate routing was published for ${filePath} but its restore failed`,
      );
    }
    throw error;
  }
}

function transactionPath(globalFilePath: string): string {
  return `${globalFilePath}.transaction.json`;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} in teammate model transaction`);
  return value as Record<string, unknown>;
}

function readTransaction(globalFilePath: string): ModelRoutingTransaction | undefined {
  const journalPath = transactionPath(globalFilePath);
  if (!fs.existsSync(journalPath)) return undefined;
  const parsed = readJsonObject(journalPath);
  if (!parsed) throw new Error("Invalid teammate model transaction journal");
  if (parsed.version !== 1 || (parsed.mode !== "forward" && parsed.mode !== "rollback")) {
    throw new Error("Invalid teammate model transaction journal");
  }
  if (typeof parsed.projectFilePath !== "string") throw new Error("Invalid project path in teammate model transaction");
  const projectFilePath = path.resolve(parsed.projectFilePath);
  if (path.basename(projectFilePath) !== CONFIG_FILE
    || path.basename(path.dirname(projectFilePath)) !== "pi-graph-next"
    || path.basename(path.dirname(path.dirname(projectFilePath))) !== ".pi") {
    throw new Error("Unsafe project path in teammate model transaction");
  }
  const globalBeforeValue = requiredRecord(parsed.globalBefore, "globalBefore");
  const globalAfterValue = requiredRecord(parsed.globalAfter, "globalAfter");
  const projectAfterValue = requiredRecord(parsed.projectAfter, "projectAfter");
  if (![3, 4].includes(Number(globalBeforeValue.version)) || ![3, 4].includes(Number(globalAfterValue.version)) || ![3, 4].includes(Number(projectAfterValue.version))) {
    throw new Error("Invalid store version in teammate model transaction");
  }
  let content: ModelRoutingTransaction["content"];
  if (parsed.content !== undefined) {
    const raw = requiredRecord(parsed.content, "content");
    if (typeof raw.globalBefore !== "string") throw new Error("Invalid transaction content");
    content = { globalBefore: raw.globalBefore };
    for (const key of ["globalAfter", "projectAfter"] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "string") throw new Error("Invalid transaction content");
        content[key] = raw[key];
      }
    }
    for (const [key, normalized] of [
      ["globalBefore", normalizeGlobalStore(globalBeforeValue)],
      ["globalAfter", normalizeGlobalStore(globalAfterValue)],
      ["projectAfter", normalizeProjectStore(projectAfterValue)],
    ] as const) {
      const text = content[key];
      if (text === undefined) continue;
      const value = text ? JSON.parse(text) : undefined;
      const store = key === "projectAfter" ? normalizeProjectStore(value) : normalizeGlobalStore(value);
      if (JSON.stringify(store) !== JSON.stringify(normalized)) throw new Error("Transaction content disagrees with store");
    }
  }
  return {
    version: 1,
    mode: parsed.mode,
    projectFilePath,
    ...(content ? { content } : {}),
    globalBefore: normalizeGlobalStore(globalBeforeValue),
    globalAfter: normalizeGlobalStore(globalAfterValue),
    projectAfter: normalizeProjectStore(projectAfterValue),
  };
}

function removeTransaction(globalFilePath: string): void {
  const journalPath = transactionPath(globalFilePath);
  try {
    fs.rmSync(journalPath);
    fsyncDirectory(path.dirname(journalPath));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function recoverPendingTransactionLocked(globalFilePath: string): void {
  const transaction = readTransaction(globalFilePath);
  if (!transaction) return;
  if (transaction.mode === "rollback") {
    writeJson(globalFilePath, transaction.globalBefore, transaction.content?.globalBefore);
    removeTransaction(globalFilePath);
    return;
  }
  withConfigLock(transaction.projectFilePath, () => {
    writeJson(globalFilePath, transaction.globalAfter, transaction.content?.globalAfter);
    writeJson(transaction.projectFilePath, transaction.projectAfter, transaction.content?.projectAfter);
    removeTransaction(globalFilePath);
  });
}

function writeGlobalAndProject(
  globalFilePath: string,
  originalGlobal: GlobalModelRoutingStore,
  global: GlobalModelRoutingStore,
  projectFilePath: string,
  project: ProjectModelRoutingStore,
  content?: ModelRoutingTransaction["content"],
): void {
  const journal: ModelRoutingTransaction = {
    version: 1,
    mode: "forward",
    projectFilePath: path.resolve(projectFilePath),
    globalBefore: originalGlobal,
    globalAfter: global,
    projectAfter: project,
    ...(content ? { content } : {}),
  };
  writeJson(transactionPath(globalFilePath), journal);
  try {
    writeJson(globalFilePath, global, content?.globalAfter);
  } catch (error) {
    if (isPublishedWriteError(error)) {
      try {
        writeJson(globalFilePath, global, content?.globalAfter);
      } catch (retryError) {
        throw new AggregateError(
          [error, retryError],
          "Global Profile was published but its durability retry failed; forward recovery remains journaled",
        );
      }
    } else {
      try {
        if (JSON.stringify(readGlobalStore(globalFilePath)) === JSON.stringify(originalGlobal)) {
          removeTransaction(globalFilePath);
        }
      } catch {}
      throw error;
    }
  }
  try {
    writeJson(projectFilePath, project, content?.projectAfter);
  } catch (projectError) {
    if (isPublishedWriteError(projectError)) {
      try {
        writeJson(projectFilePath, project, content?.projectAfter);
      } catch (retryError) {
        throw new AggregateError(
          [projectError, retryError],
          "Project selection was published but its durability retry failed; forward recovery remains journaled",
        );
      }
    } else {
      let journalError: unknown;
      try {
        writeJson(transactionPath(globalFilePath), { ...journal, mode: "rollback" });
      } catch (error) {
        journalError = error;
      }
      try {
        writeJson(globalFilePath, originalGlobal, content?.globalBefore);
        removeTransaction(globalFilePath);
      } catch (rollbackError) {
        throw new AggregateError(
          [projectError, ...(journalError ? [journalError] : []), rollbackError],
          "Project routing write failed and the global Profile rollback could not be completed",
        );
      }
      if (journalError) {
        throw new AggregateError(
          [projectError, journalError],
          "Project routing write failed; global rollback succeeded but rollback intent could not be journaled",
        );
      }
      throw projectError;
    }
  }
  try {
    removeTransaction(globalFilePath);
  } catch {
    // A forward journal is idempotent and will be cleared on the next locked read.
  }
}

function readSessionStore(filePath: string): SessionModelRoutingStore | undefined {
  const parsed = readJsonObject(filePath);
  if (!parsed || (parsed.version !== 3 && parsed.version !== 4) || typeof parsed.sessionId !== "string") return undefined;
  return {
    version: 4,
    sessionId: parsed.sessionId as string,
    createdAtMs: typeof parsed.createdAtMs === "number" && Number.isFinite(parsed.createdAtMs)
      ? parsed.createdAtMs
      : Date.now(),
    rules: normalizeRules(parsed.rules),
  };
}

/**
 * Persist a session-scoped routing override. Session overrides stack on top
 * of project overrides (and the active profile) and apply only to the single
 * Pi session identified by `sessionId`. The file is written atomically under
 * the same lock protocol as the project config. A corrupted session file is
 * ignored at read time, so a bad write never blocks dispatch.
 */
export function saveSessionModelRoutingOverrides(
  cwd: string,
  sessionId: string,
  rules: ModelRoutingRules,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  const sessionFilePath = getSessionModelRoutingPath(cwd, sessionId);
  return withConfigLock(sessionFilePath, () => {
    const store: SessionModelRoutingStore = {
      version: 4,
      sessionId,
      createdAtMs: Date.now(),
      rules: normalizeRules(rules),
    };
    writeJson(sessionFilePath, store);
    return loadModelRoutingConfig(cwd, globalFilePath, sessionId);
  });
}
function resolvedState(cwd: string, globalFilePath = getGlobalModelRoutingPath(), sessionId?: string): ModelRoutingState {
  const global = readGlobalStore(globalFilePath);
  const project = readProjectStore(getProjectModelRoutingPath(cwd));
  let session: SessionModelRoutingStore | undefined;
  if (sessionId) {
    try { session = readSessionStore(getSessionModelRoutingPath(cwd, sessionId)); }
    catch { /* Preserve the original unreadable-session fallback. */ }
  }
  return resolveRoutingState(global, project, session);
}

/** Persist the smart model-selection strategy on the global teammate model config. */
export function setGlobalSmartMode(
  value: TeammateSmartMode | boolean,
  globalFilePath = getGlobalModelRoutingPath(),
): TeammateSmartMode {
  const mode: TeammateSmartMode = value === true ? "balanced" : value === false ? "off" : value;
  if (!(TEAMMATE_SMART_MODES as readonly string[]).includes(mode)) {
    throw new Error(`Invalid teammate smart mode: ${String(value)}`);
  }
  return withGlobalConfigLock(globalFilePath, () => {
    const store = readGlobalStore(globalFilePath);
    const next: GlobalModelRoutingStore = mode === "off"
      ? (() => {
        const { smartMode: _dropped, ...rest } = store;
        return rest;
      })()
      : { ...store, smartMode: mode };
    writeJson(globalFilePath, next);
    return mode;
  });
}

/** Effective smart model-selection strategy without a cwd (global store only). */
export function getGlobalSmartMode(
  globalFilePath = getGlobalModelRoutingPath(),
): TeammateSmartMode {
  try {
    return readGlobalStore(globalFilePath).smartMode ?? "off";
  } catch {
    return "off";
  }
}

/**
 * Persist the ask-before-dispatch flag on the global teammate model config.
 * The flag is user-level (not per profile/project): it controls whether the
 * root teammate tool asks the user to confirm or pick model provider/thinking
 * before every dispatch.
 */
export function setGlobalAskBeforeDispatch(
  enabled: boolean,
  globalFilePath = getGlobalModelRoutingPath(),
): boolean {
  return withGlobalConfigLock(globalFilePath, () => {
    const store = readGlobalStore(globalFilePath);
    const next: GlobalModelRoutingStore = enabled
      ? { ...store, askBeforeDispatch: true }
      : (() => {
        const { askBeforeDispatch: _dropped, ...rest } = store;
        return rest;
      })();
    writeJson(globalFilePath, next);
    return enabled;
  });
}

/** Effective ask-before-dispatch flag without a cwd (global store only). */
export function getGlobalAskBeforeDispatch(
  globalFilePath = getGlobalModelRoutingPath(),
): boolean {
  try {
    return readGlobalStore(globalFilePath).askBeforeDispatch === true;
  } catch {
    return false;
  }
}

/** Effective monitoring-only background status heartbeat interval. */
export function getGlobalBackgroundStatusHeartbeatMs(
  globalFilePath = getGlobalModelRoutingPath(),
): number {
  try {
    return readGlobalStore(globalFilePath).backgroundStatusHeartbeatMs ?? BACKGROUND_STATUS_HEARTBEAT_DEFAULT_MS;
  } catch {
    return BACKGROUND_STATUS_HEARTBEAT_DEFAULT_MS;
  }
}

function fileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

function readConsistentState(cwd: string, globalFilePath: string, sessionId?: string): ModelRoutingState {
  const projectFilePath = getProjectModelRoutingPath(cwd);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (fs.existsSync(transactionPath(globalFilePath))) {
      return withGlobalConfigLock(globalFilePath, () => resolvedState(cwd, globalFilePath, sessionId));
    }
    const globalBefore = fileSignature(globalFilePath);
    const projectBefore = fileSignature(projectFilePath);
    const state = resolvedState(cwd, globalFilePath, sessionId);
    const globalAfter = fileSignature(globalFilePath);
    const projectAfter = fileSignature(projectFilePath);
    if (
      !fs.existsSync(transactionPath(globalFilePath))
      && globalBefore === globalAfter
      && projectBefore === projectAfter
    ) return state;
  }
  return withGlobalConfigLock(globalFilePath, () => resolvedState(cwd, globalFilePath, sessionId));
}

export function loadModelRoutingState(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
  sessionId?: string,
): ModelRoutingState {
  return readConsistentState(cwd, globalFilePath, sessionId);
}

export function loadModelRoutingConfig(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
  sessionId?: string,
): ModelRoutingConfig {
  return readConsistentState(cwd, globalFilePath, sessionId).config;
}

export interface ModelRoutingStorePair {
  global: GlobalModelRoutingStore;
  project: ProjectModelRoutingStore;
}

export interface ModelRoutingStoreContentPair {
  global: string;
  project: string;
}

/** @internal Shared persistence bridge for the unified Settings provider. */
export function loadModelRoutingStores(
  globalFilePath: string,
  projectFilePath: string,
): ModelRoutingStorePair {
  const resolvedProjectPath = path.resolve(projectFilePath);
  return withGlobalConfigLock(globalFilePath, () => withConfigLock(resolvedProjectPath, () => ({
    global: readGlobalStore(globalFilePath),
    project: readProjectStore(resolvedProjectPath),
  })));
}

/** @internal Publish a prepared Settings transaction through the routing lock/journal protocol. */
export function replaceModelRoutingStores(
  globalFilePath: string,
  projectFilePath: string,
  expected: ModelRoutingStorePair,
  next: ModelRoutingStorePair,
  expectedContent?: ModelRoutingStoreContentPair,
  restoreContent?: ModelRoutingStoreContentPair,
): ModelRoutingStorePair {
  const resolvedProjectPath = path.resolve(projectFilePath);
  return withGlobalConfigLock(globalFilePath, () => withConfigLock(resolvedProjectPath, () => {
    if (expectedContent
      && (readConfigContent(globalFilePath) !== expectedContent.global
        || readConfigContent(resolvedProjectPath) !== expectedContent.project)) {
      throw new Error("Teammate model routing bytes changed after Settings preparation");
    }
    const current = {
      global: readGlobalStore(globalFilePath),
      project: readProjectStore(resolvedProjectPath),
    };
    if (JSON.stringify(current.global) !== JSON.stringify(expected.global)
      || JSON.stringify(current.project) !== JSON.stringify(expected.project)) {
      throw new Error("Teammate model routing changed after Settings preparation");
    }
    const normalized = {
      global: normalizeGlobalStore(next.global as unknown as Record<string, unknown>),
      project: normalizeProjectStore(next.project as unknown as Record<string, unknown>),
    };
    const globalChanged = JSON.stringify(current.global) !== JSON.stringify(normalized.global);
    const projectChanged = JSON.stringify(current.project) !== JSON.stringify(normalized.project);
    if (globalChanged && projectChanged) {
      writeGlobalAndProject(
        globalFilePath,
        current.global,
        normalized.global,
        resolvedProjectPath,
        normalized.project,
        { globalBefore: readConfigContent(globalFilePath), ...restoreContent && { globalAfter: restoreContent.global, projectAfter: restoreContent.project } },
      );
    } else if (globalChanged) {
      writeJsonRestoringOnPublish(globalFilePath, normalized.global, current.global, readConfigContent(globalFilePath), restoreContent?.global);
    } else if (projectChanged) {
      writeJsonRestoringOnPublish(resolvedProjectPath, normalized.project, current.project, readConfigContent(resolvedProjectPath), restoreContent?.project);
    }
    return normalized;
  }));
}

function readConfigContent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    throw error;
  }
}
export function discoverRoutingTaskTypes(
  cwd: string,
  _agents: readonly { taskType?: TeammateTaskType }[] = [],
  loadedConfig?: ModelRoutingConfig,
): TeammateTaskType[] {
  return discoverRoutingTaskTypesFromConfig(loadedConfig ?? loadModelRoutingConfig(cwd));
}

function projectStoreForWrite(cwd: string, globalFilePath: string): ProjectModelRoutingStore {
  const state = resolvedState(cwd, globalFilePath);
  return {
    ...state.project,
    activeProfile: state.project.activeProfile ?? state.config.profileId,
    overrides: cloneRules(state.project.overrides),
  };
}

function saveProjectOverride(
  cwd: string,
  update: (rules: ModelRoutingRules) => void,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const store = projectStoreForWrite(cwd, globalFilePath);
    update(store.overrides);
    store.applyOverrides = true;
    writeJson(projectFilePath, store);
    return resolvedState(cwd, globalFilePath).config;
  });
}
export function saveProjectThinkingLevel(
  cwd: string,
  taskType: TeammateTaskType,
  thinking: TeammateThinkingLevel | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  return saveProjectOverride(cwd, thinkingLevelUpdate(taskType, thinking), globalFilePath);
}
export function saveProjectFastMode(
  cwd: string, taskType: TeammateTaskType, fast: boolean | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  return saveProjectOverride(cwd, fastModeUpdate(taskType, fast), globalFilePath);
}
export function saveProjectModelMapping(
  cwd: string,
  taskType: TeammateTaskType,
  model: string | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  return saveProjectOverride(cwd, modelMappingUpdate(taskType, model), globalFilePath);
}
export function saveProjectFallbackMapping(
  cwd: string,
  taskType: TeammateTaskType,
  models: string[] | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  return saveProjectOverride(cwd, fallbackMappingUpdate(taskType, models), globalFilePath);
}
export function saveProjectRoleMapping(
  cwd: string,
  role: string,
  rules: ModelRoutingRoleRules | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  return saveProjectOverride(cwd, roleMappingUpdate(role, rules), globalFilePath);
}

/** List saved routing templates with the current project's active selection. */
export function listModelRoutingProfiles(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingProfileSummary[] {
  const state = loadModelRoutingState(cwd, globalFilePath);
  return sortedProfileSummaries(state.global, state.config.profileId);
}

/** Resolve a stable Profile id or display name without changing the selection. */
export function resolveModelRoutingProfile(
  cwd: string,
  reference: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingProfileSummary {
  const state = loadModelRoutingState(cwd, globalFilePath);
  const profileId = resolveProfileId(state.global, reference);
  return sortedProfileSummaries(state.global, state.config.profileId)
    .find((profile) => profile.id === profileId)!;
}

function saveGlobalProfile(
  cwd: string,
  profileId: string,
  update: (profile: ModelRoutingProfile) => void,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalConfigLock(globalFilePath, () => {
    const store = readGlobalStore(globalFilePath);
    update(requireProfile(store, profileId));
    writeJson(globalFilePath, store);
    return resolvedState(cwd, globalFilePath);
  });
}
export function saveGlobalProfileModelMapping(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  model: string | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return saveGlobalProfile(cwd, profileId, modelMappingUpdate(taskType, model), globalFilePath);
}
export function saveGlobalProfileThinkingLevel(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  thinking: TeammateThinkingLevel | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return saveGlobalProfile(cwd, profileId, thinkingLevelUpdate(taskType, thinking), globalFilePath);
}
export function saveGlobalProfileFastMode(
  cwd: string, profileId: string, taskType: TeammateTaskType, fast: boolean | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return saveGlobalProfile(cwd, profileId, fastModeUpdate(taskType, fast), globalFilePath);
}
export function saveGlobalProfileFallbackMapping(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  models: string[] | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return saveGlobalProfile(cwd, profileId, fallbackMappingUpdate(taskType, models), globalFilePath);
}
export function saveGlobalProfileRoleMapping(
  cwd: string,
  profileId: string,
  role: string,
  rules: ModelRoutingRoleRules | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return saveGlobalProfile(cwd, profileId, roleMappingUpdate(role, rules), globalFilePath);
}
export function saveGlobalProfileTypeRoles(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  roles: readonly string[],
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return saveGlobalProfile(cwd, profileId, typeRolesUpdate(taskType, roles), globalFilePath);
}
export function saveGlobalProfileTypeMeta(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  meta: ModelRoutingTypeMeta | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return saveGlobalProfile(cwd, profileId, typeMetaUpdate(taskType, meta), globalFilePath);
}
export function saveGlobalProfileCustomType(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  meta: ModelRoutingTypeMeta | null = null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return saveGlobalProfile(cwd, profileId, customTypeUpdate(taskType, meta), globalFilePath);
}
export function deleteGlobalProfileCustomType(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return saveGlobalProfile(cwd, profileId, deleteCustomTypeUpdate(taskType), globalFilePath);
}
export function createGlobalModelRoutingProfile(
  cwd: string,
  name: string,
  sourceProfileId?: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedName = requireRoutingProfileName(name);
  return withGlobalConfigLock(globalFilePath, () => {
    const store = readGlobalStore(globalFilePath);
    const profileId = addRoutingProfile(store, normalizedName, sourceProfileId);
    writeJson(globalFilePath, store);
    return { ...resolvedState(cwd, globalFilePath), changedProfileId: profileId };
  });
}
export function createAndActivateGlobalModelRoutingProfile(
  cwd: string,
  name: string,
  sourceProfileId?: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedName = requireRoutingProfileName(name);
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    const originalGlobal = structuredClone(global);
    const profileId = addRoutingProfile(global, normalizedName, sourceProfileId);
    const project = readProjectStore(projectFilePath);
    activateRoutingProjectProfile(global, project, profileId);
    writeGlobalAndProject(globalFilePath, originalGlobal, global, projectFilePath, project);
    return { ...resolvedState(cwd, globalFilePath), changedProfileId: profileId };
  });
}
export function renameGlobalModelRoutingProfile(
  cwd: string,
  profileId: string,
  name: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return saveGlobalProfile(cwd, profileId, profileNameUpdate(name), globalFilePath);
}
export function setDefaultGlobalModelRoutingProfile(
  cwd: string,
  profileId: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalConfigLock(globalFilePath, () => {
    const store = readGlobalStore(globalFilePath);
    setRoutingDefaultProfile(store, profileId);
    writeJson(globalFilePath, store);
    return resolvedState(cwd, globalFilePath);
  });
}
export function setProjectActiveModelRoutingProfile(
  cwd: string,
  profileId: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    requireProfile(global, profileId);
    const project = readProjectStore(projectFilePath);
    activateRoutingProjectProfile(global, project, profileId);
    writeJson(projectFilePath, project);
    return resolvedState(cwd, globalFilePath);
  });
}
export function activateModelRoutingProfile(
  cwd: string,
  reference: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    const profileId = resolveProfileId(global, reference);
    const project = readProjectStore(projectFilePath);
    activateRoutingProjectProfile(global, project, profileId);
    writeJson(projectFilePath, project);
    return resolvedState(cwd, globalFilePath);
  });
}
export function setProjectModelRoutingOverridesEnabled(
  cwd: string,
  enabled: boolean,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const project = projectStoreForWrite(cwd, globalFilePath);
    setRoutingProjectOverridesEnabled(project, enabled);
    writeJson(projectFilePath, project);
    return resolvedState(cwd, globalFilePath);
  });
}
export function clearProjectModelRoutingOverrides(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const project = projectStoreForWrite(cwd, globalFilePath);
    clearRoutingProjectOverrides(project);
    writeJson(projectFilePath, project);
    return resolvedState(cwd, globalFilePath);
  });
}
export function promoteProjectModelRoutingOverrides(
  cwd: string,
  name: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedName = requireRoutingProfileName(name);
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    const originalGlobal = structuredClone(global);
    const project = readProjectStore(projectFilePath);
    const profileId = promoteRoutingProjectOverrides(global, project, normalizedName);
    writeGlobalAndProject(globalFilePath, originalGlobal, global, projectFilePath, project);
    return { ...resolvedState(cwd, globalFilePath), changedProfileId: profileId };
  });
}
export function deleteGlobalModelRoutingProfile(
  cwd: string,
  profileId: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    assertDeletableRoutingProfile(global, profileId);
    const originalGlobal = structuredClone(global);
    const project = readProjectStore(projectFilePath);
    const projectChanged = deleteRoutingProfile(global, project, profileId);
    if (projectChanged) writeGlobalAndProject(globalFilePath, originalGlobal, global, projectFilePath, project);
    else writeJson(globalFilePath, global);
    return resolvedState(cwd, globalFilePath);
  });
}

/** Configuration remains in the host bridge; M07 receives only explicit snapshots. */
interface SelectionSource {
  cwd: string; configPath: string; roleHash: string; authorityHash?: string;
  read: () => ReturnType<typeof captureRoleSource>;
  originalRequest: Readonly<{ hasModel: boolean; model?: string; hasFallbacks: boolean; fallbackModels?: readonly string[]; fields?: Readonly<{taskModel: boolean; topModel: boolean; taskFallbacks: boolean; topFallbacks: boolean}> }>;
  modelInputHash: string;
  readOriginalRequest: () => SelectionSource["originalRequest"];
}
const selectionSources = new WeakMap<SelectionDecision, SelectionSource>();
type CatalogInput = readonly (string | TeammateModelCapability)[];
function roleIdentity(role: AgentConfig): string {
  return snapshotHash({...role, filePath: fs.existsSync(role.filePath) ? fs.realpathSync(role.filePath) : role.filePath});
}
function captureRoleSource(agent: string, cwd: string, configPath: string, taskType?: string,
  sessionId?: string, authority?: DispatchAuthorityProjection, inheritModel?: string) {
  const role = resolveAgent(cwd, agent);
  if (!role) throw new Error(`Unknown teammate agent "${agent}"`);
  const state = loadModelRoutingState(cwd, configPath, sessionId);
  const builtin = inheritModel === undefined ? undefined : inspectBuiltinRoleModelSource(role);
  return deriveRoleSelectionSource(agent, role, state, { cwd, configPath, taskType, authority,
    ...(builtin ? { defaultSource: { kind: "host-builtin-inherit", model: inheritModel!, roleSourceIdentity: snapshotHash(builtin) } } : {}) });
}
export function freezeRoleModelSelection(input: { agent: string; model?: string; fallbackModels?: string[]; taskType?: string },
  cwd: string, ids: CatalogInput | undefined, globalFilePath?: string, sessionId?: string,
  authority?: DispatchAuthorityProjection, inheritModel?: string): SelectionDecision {
  const actualCwd = fs.realpathSync(cwd);
  const configPath = path.resolve(globalFilePath ?? getGlobalModelRoutingPath());
  const read = () => captureRoleSource(input.agent, actualCwd, configPath, input.taskType, sessionId, authority, inheritModel);
  const source = read();
  const decision = selectModel(source.snapshot, eligibility(ids, authority), {
    model: input.model,
    fallbackModels: input.fallbackModels,
    taskDefaults: source.taskDefaults,
    canonicalizeModel: model => canonical(model, authority),
  });
  const originalRequest = Object.freeze({hasModel: Object.hasOwn(input, "model"), model: input.model,
    hasFallbacks: Object.hasOwn(input, "fallbackModels"),
    ...(input.fallbackModels === undefined ? {} : {fallbackModels: Object.freeze([...input.fallbackModels])})});
  selectionSources.set(decision, {cwd: actualCwd, configPath, roleHash: roleIdentity(source.role), authorityHash: authority?.hash, read,
    originalRequest, modelInputHash: snapshotHash(originalRequest),
    readOriginalRequest: () => ({hasModel: Object.hasOwn(input, "model"), model: input.model,
      hasFallbacks: Object.hasOwn(input, "fallbackModels"),
      ...(input.fallbackModels === undefined ? {} : {fallbackModels: [...input.fallbackModels]})})});
  return decision;
}
export function verifyRoleModelSelection(decision: SelectionDecision, input: { agent: string; model?: string; fallbackModels?: string[] },
  ids: CatalogInput | undefined, actual: {cwd: string; role: AgentConfig; globalFilePath?: string; authority?: DispatchAuthorityProjection}): void {
  const source = selectionSources.get(decision);
  if (source && snapshotHash(source.readOriginalRequest()) !== source.modelInputHash) {
    throw new Error("ModelRole: original model request changed after selection");
  }
  if (!source || input.agent !== decision.role) throw new Error("ModelRole: unknown or mismatched frozen role decision");
  if (fs.realpathSync(actual.cwd) !== source.cwd || roleIdentity(actual.role) !== source.roleHash
    || path.resolve(actual.globalFilePath ?? getGlobalModelRoutingPath()) !== source.configPath
    || actual.authority?.hash !== source.authorityHash) {
    throw new Error("ModelRole: selection snapshot changed before admission (actual role/workspace/config scope)");
  }
  verifySelection(decision, source.read().snapshot, eligibility(ids, actual.authority), input.model, input.fallbackModels);
}
/** A display/eligibility query only: deployment authorization is separate. */
export function isImplicitBuiltinModelSelection(decision: SelectionDecision | undefined): boolean {
  if (!decision) return false;
  const source = selectionSources.get(decision);
  if (!source || source.authorityHash !== undefined) return false;
  if (snapshotHash(source.readOriginalRequest()) !== source.modelInputHash) {
    throw new Error("ModelRole: original model request changed after selection");
  }
  const current = source.read();
  if (roleIdentity(current.role) !== source.roleHash || current.snapshot.revision !== decision.roleRevision
    || snapshotHash(current.snapshot) !== decision.roleHash) throw new Error("ModelRole: default source changed before admission");
  return current.sourceProvenance.onlyImplicitHostDefault
    && source.originalRequest.model === undefined && (source.originalRequest.fallbackModels?.length ?? 0) === 0;
}
/** Keeps the same private role source; no serializable default permit is issued. */
export function bindRoleDeploymentDefault(decision: SelectionDecision, ids: CatalogInput | undefined,
  actual: {cwd: string; role: AgentConfig; globalFilePath?: string}, readDeployment: () => string): () => void {
  const source = selectionSources.get(decision);
  if (!source || !isImplicitBuiltinModelSelection(decision)) throw new Error("ModelRole: deployment default is not authorized by the original builtin source");
  const fingerprint = readDeployment(), inputHash = source.modelInputHash;
  const assertCurrent = (): void => {
    if (selectionSources.get(decision) !== source || snapshotHash(source.originalRequest) !== inputHash
      || !isImplicitBuiltinModelSelection(decision)) throw new Error("ModelRole: deployment default source changed");
    verifyRoleModelSelection(decision, {agent: decision.role, model: decision.selected,
      fallbackModels: [...decision.candidates.slice(1)]}, ids, actual);
    if (readDeployment() !== fingerprint) throw new Error("ModelRole: trusted deployment default changed before launch");
  };
  assertCurrent(); return assertCurrent;
}
export function applyModelRouting(
  params: RunTeammateParams, cwd: string, availableModels?: CatalogInput, globalFilePath?: string,
  inheritModel?: string, sessionId?: string, authority?: DispatchAuthorityProjection,
): RunTeammateParams {
  const configPath = globalFilePath ?? getGlobalModelRoutingPath();
  const topLevelThinking = parseTeammateThinkingLevel(params.thinking);
  const tasks = params.tasks.map(task => {
    const routingCwd = path.resolve(cwd, task.cwd ?? params.cwd ?? ".");
    const agent = task.agent ?? params.agent ?? "general";
    const taskType = task.taskType ?? params.taskType;
    const decision = freezeRoleModelSelection({agent, taskType, model: task.model ?? params.model,
      fallbackModels: task.fallbackModels ?? params.fallbackModels}, routingCwd, availableModels, configPath, sessionId, authority, inheritModel);
    const originalSource = selectionSources.get(decision)!;
    originalSource.readOriginalRequest = () => ({
      hasModel: Object.hasOwn(task, "model") || Object.hasOwn(params, "model"), model: task.model ?? params.model,
      hasFallbacks: Object.hasOwn(task, "fallbackModels") || Object.hasOwn(params, "fallbackModels"),
      ...((task.fallbackModels ?? params.fallbackModels) === undefined ? {} : {fallbackModels: [...(task.fallbackModels ?? params.fallbackModels)!]}),
      fields: {taskModel: Object.hasOwn(task, "model"), topModel: Object.hasOwn(params, "model"),
        taskFallbacks: Object.hasOwn(task, "fallbackModels"), topFallbacks: Object.hasOwn(params, "fallbackModels")}});
    originalSource.originalRequest = Object.freeze(originalSource.readOriginalRequest());
    originalSource.modelInputHash = snapshotHash(originalSource.originalRequest);
    const {config, role} = originalSource.read();
    return {...task, ...(taskType ? {taskType} : {}), model: decision.selected,
      fallbackModels: [...decision.candidates.slice(1)], modelSelection: decision,
      ...resolveTaskRoutingFields({ taskFast: task.fast, topLevelFast: params.fast, taskThinking: task.thinking,
        topLevelThinking, taskType, agent, role, config })};
  });
  return {...params, tasks, thinking: topLevelThinking};
}

/**
 * Sync per-role circuit policies from the routing config onto a circuit
 * breaker. Circuit policies apply to the role's configured model; task-type
 * routes are selected per dispatch and do not bind back to roles. The breaker's
 * policy map is rebuilt from the config on every call, so removed policies do
 * not linger.
 */
export function syncModelCircuitPolicies(
  breaker: ModelCircuitBreaker,
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
): void {
  breaker.clearPolicies();
  const config = loadModelRoutingConfig(cwd, globalFilePath);
  for (const rules of Object.values(config.roleMappings ?? {})) {
    if (!rules || !rules.circuit) continue;
    const model = rules.model;
    if (!model) continue;
    breaker.setPolicy(model, rules.circuit);
  }
}

/** Reconcile registry-mode health against the dispatch projection's stable hash. */
export function reconcileModelHealthProjection(
  health: ModelHealthCoordinator,
  projection: DispatchAuthorityProjection,
): boolean {
  return health.reconcileProjection(projection);
}

export interface ModelRegistryRefreshContext {
  modelRegistry?: { refresh?: () => Promise<unknown> } | undefined;
}

const modelRegistryRefreshInFlight = new WeakMap<object, Promise<void>>();

/**
 * Await a coalesced refresh of the host model registry before reading its
 * getAvailable() snapshot. The sync snapshot is only rebuilt by refresh();
 * without it, models deleted from config/auth stay visible to catalog,
 * routing and modelCapabilities validation until unrelated code refreshes.
 */
export async function refreshModelRegistry(ctx: ModelRegistryRefreshContext): Promise<void> {
  const registry = ctx.modelRegistry;
  if (!registry?.refresh) return;
  // Call through the registry object: the host's refresh() is a class method
  // that reads `this.runtime`. A detached call would throw
  // "Cannot read properties of undefined (reading 'runtime')" and leave the
  // synchronous getAvailable() snapshot stale. Coalesce only calls against the
  // same registry: separate extension runtimes must each refresh their snapshot.
  let refresh = modelRegistryRefreshInFlight.get(registry);
  if (!refresh) {
    refresh = Promise.resolve()
      .then(() => registry.refresh!())
      .then(() => undefined, (error) => {
        // A failed registry refresh must not block dispatch; the previous
        // snapshot stays authoritative until the next successful refresh.
        logDiagnosticError(
          `[pi-maestro-teammate] model registry refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (modelRegistryRefreshInFlight.get(registry) === refresh) {
          modelRegistryRefreshInFlight.delete(registry);
        }
      });
    modelRegistryRefreshInFlight.set(registry, refresh);
  }
  await refresh;
}

/**
 * Configured routing targets that the current teammate catalog cannot reach.
 *
 * `mappedModel` skips unreachable targets silently (the dispatch then falls
 * back down the inheritance chain), so this is the one place an operator can
 * see that a task-type or role mapping names a model no gate currently
 * admits. Empty `availableModels` means "no catalog knowledge" and yields no
 * findings — absence of evidence must not read as breakage.
 */
export interface UnreachableRoutingTarget {
  kind: "taskType" | "role";
  key: string;
  model: string;
}

export function unreachableRoutingTargets(
  config: ModelRoutingConfig,
  availableModels: readonly string[],
): UnreachableRoutingTarget[] {
  if (availableModels.length === 0) return [];
  const known = new Set(availableModels);
  const missing = (model: string | null | undefined): boolean =>
    typeof model === "string" && model.trim().length > 0 && !known.has(model);
  const targets: UnreachableRoutingTarget[] = [];
  for (const [taskType, model] of Object.entries(config.mappings)) {
    if (missing(model)) targets.push({ kind: "taskType", key: taskType, model: model! });
  }
  for (const [role, rules] of Object.entries(config.roleMappings ?? {})) {
    if (rules && missing(rules.model)) targets.push({ kind: "role", key: role, model: rules.model! });
  }
  return targets;
}

export function formatModelRoutingConfig(
  cwd: string,
  agents: readonly { taskType?: TeammateTaskType }[] = [],
  globalFilePath = getGlobalModelRoutingPath(),
  availableModels: readonly string[] = [],
): string {
  const config = loadModelRoutingConfig(cwd, globalFilePath);
  const table = discoverRoutingTaskTypes(cwd, agents, config)
    .map((taskType) => {
      const fallbacks = config.fallbackMappings?.[taskType]?.join(",") || "none";
      return `- ${taskType}: model=${config.mappings[taskType] ?? "auto"}, fallbacks=${fallbacks}, thinking=${config.thinkingLevels[taskType] ?? "inherit/default"}`;
    })
    .join("\n");
  const unreachable = unreachableRoutingTargets(config, availableModels);
  const warnings = unreachable.map((target) =>
    `- ⚠ ${target.model} (${target.kind} "${target.key}") is not in the current teammate catalog; routing will skip it and fall back to inheritance`
  );
  return [table, ...warnings].filter((part) => part.length > 0).join("\n");
}

export const TASK_TYPE_ROUTING_START_MARKER = "<!-- teammate-tasktype-routing:start -->";
export const TASK_TYPE_ROUTING_END_MARKER = "<!-- teammate-tasktype-routing:end -->";
export const SMART_MODEL_SELECTION_START_MARKER = "<!-- teammate-smart-model-selection:start -->";
export const SMART_MODEL_SELECTION_END_MARKER = "<!-- teammate-smart-model-selection:end -->";

/**
 * Inject concise taskType model-routing guidance for agents that can dispatch
 * teammates. Replaces an existing block in place so repeated injection stays
 * idempotent.
 */
export function appendTaskTypeRoutingContext(
  systemPrompt: string,
  cwd: string,
  agents: readonly { taskType?: TeammateTaskType }[] = [],
  globalFilePath = getGlobalModelRoutingPath(),
  availableModels: readonly string[] = [],
): string {
  const config = loadModelRoutingConfig(cwd, globalFilePath);
  const routingTable = formatModelRoutingConfig(cwd, agents, globalFilePath, availableModels);
  const customTypes = discoverRoutingTaskTypes(cwd, agents, config)
    .filter((taskType) => !(TEAMMATE_TASK_TYPES as readonly string[]).includes(taskType))
    .map((taskType) => `  - ${taskType}`);
  const lines = [
    TASK_TYPE_ROUTING_START_MARKER,
    "## Teammate taskType routing",
    "`taskType` selects configured model, fallback-model, and thinking defaults (and, in experts mode, the default expert agent when none is given); it never changes a chosen agent's role, tools, permissions, or task scope.",
    "Set `tasks[].taskType` by the task's actual phase; top-level `taskType` is the default for all tasks. No role or prompt inference assigns a task type.",
    "",
    "Legal task types (routing configuration may declare more):",
    ...TEAMMATE_TASK_TYPES.map((type) => `  - ${type}`),
    ...(customTypes.length > 0 ? customTypes : []),
    "",
    "Current task-type model routing:",
    ...routingTable.split("\n").map((line) => `  ${line}`),
    TASK_TYPE_ROUTING_END_MARKER,
  ];
  const block = lines.join("\n");
  const start = systemPrompt.indexOf(TASK_TYPE_ROUTING_START_MARKER);
  const end = systemPrompt.indexOf(TASK_TYPE_ROUTING_END_MARKER);
  if (start >= 0 && end >= start) {
    return `${systemPrompt.slice(0, start)}${block}${systemPrompt.slice(end + TASK_TYPE_ROUTING_END_MARKER.length)}`;
  }
  return `${systemPrompt}\n\n${block}`;
}

/**
 * Inject the root-agent smart selection workflow without embedding volatile
 * benchmark data. model-availability remains the single runtime data source.
 */
export function appendSmartModelSelectionContext(
  systemPrompt: string,
  smartMode: TeammateSmartMode,
  askBeforeDispatch: boolean,
): string {
  const start = systemPrompt.indexOf(SMART_MODEL_SELECTION_START_MARKER);
  const end = systemPrompt.indexOf(SMART_MODEL_SELECTION_END_MARKER);
  if (smartMode === "off") {
    if (start < 0 || end < start) return systemPrompt;
    const before = systemPrompt.slice(0, start).trimEnd();
    const after = systemPrompt.slice(end + SMART_MODEL_SELECTION_END_MARKER.length).trimStart();
    return after ? `${before}\n\n${after}` : before;
  }

  const confirmation = askBeforeDispatch
    ? "The runtime confirmation overlay is enabled. Pass the selected candidate to `teammate`; the overlay owns user confirmation or modification. Do not ask a second confirmation question."
    : "User confirmation is disabled. Do not ask a model-selection question; proceed with the selected candidate when evidence is current and sufficiently confident.";
  const strategy = smartMode === "economy"
    ? "Economy strategy: prefer the lowest reference price among candidates with current, non-low-confidence evidence for the task; pay more only when the cheaper candidate is materially weaker on the task-relevant ranks."
    : smartMode === "sota"
      ? "SOTA strategy: prioritize the strongest task-relevant intelligence, coding, or agentic ranks regardless of reference price; use price and latency only to break an evidence-level tie."
      : "Balanced strategy: balance task-relevant ability, reference price, and latency; prefer a clear Pareto trade-off and retain configured routing when no candidate is materially better.";
  const block = [
    SMART_MODEL_SELECTION_START_MARKER,
    `## Smart teammate model selection · ${smartMode}`,
    "Before every root `teammate` dispatch containing a task without a user-explicit model:",
    `1. Assign the concrete \`taskType\`; for each distinct task type call \`model-availability\` with that \`taskType\`, \`preference: "${smartMode}"\`, and \`limit: 5\`.`,
    "2. Consider only ids in `teammate_models`. Treat `model_intelligence` as advisory reference evidence, not as availability or policy authority.",
    `3. ${strategy}`,
    "4. Preserve every user-explicit model. Otherwise pass the selected candidate's exact registration id as `model`.",
    "5. If intelligence is unavailable or stale, confidence is low, candidates materially tie, or no ranked candidate matches, omit `model` and retain configured taskType/role routing.",
    "6. Never treat unknown pricing as free, never send the task prompt to an external ranking service, and never rewrite persistent routing profiles from a recommendation.",
    confirmation,
    "This enabled smart-selection guidance authorizes model selection under the `teammate` tool description's omit-model rule; that description remains authoritative for resolution precedence.",
    SMART_MODEL_SELECTION_END_MARKER,
  ].join("\n");
  if (start >= 0 && end >= start) {
    return `${systemPrompt.slice(0, start)}${block}${systemPrompt.slice(end + SMART_MODEL_SELECTION_END_MARKER.length)}`;
  }
  return `${systemPrompt}\n\n${block}`;
}
