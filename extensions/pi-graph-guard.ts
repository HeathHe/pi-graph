import { MAILBOX_BINDING_NAMESPACE } from "../src/v3/mailbox-bindings.ts";
import { inputArtifactName, proveInputRead, type InputReadProof } from "../src/v3/input-integrity.ts";
import { builtinContextTools, projectGraphContext } from "../src/v3/context-projection.ts";
import { registerGraphMailboxTool } from "../src/v3/mailbox-client.ts";
import { checkNativeRuntimePatch } from "../src/v3/runtime-compatibility.ts";
import { GRAPH_READONLY_TOOLS, registerGraphReadonlyTools } from "../src/v3/readonly-tools.ts";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { canonicalDigest } from "../src/v3/digests.ts";
import type { V3NodeContract } from "../src/v3/workspace.ts";
import { isReadOnlyRemoteToolName } from "../src/v3/remote-tools.ts";

type GuardContract = V3NodeContract;

const EXTENSION_BINDINGS_ENV = "PI_GRAPH_EXTENSION_BINDINGS";
const GRAPH_GUARD_BINDING_NAMESPACE = "pi-graph/1";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

interface GraphGuardBinding {
	schemaVersion: 1;
	graphId: string;
	taskId: string;
	attempt: number;
	workspaceCwd: string;
	contractDigest: string;
}

type GuardActivation =
	| { mode: "inert" }
	| { mode: "required"; binding: GraphGuardBinding }
	| { mode: "invalid" };

type ProviderPayloadClampResult =
	| { ok: true; payload: Record<string, unknown> }
	| { ok: false };

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function graphGuardActivation(raw: string | undefined): GuardActivation {
	if (raw === undefined) return { mode: "inert" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return { mode: "invalid" };
	}
	const bindings = record(parsed);
	if (!bindings) return { mode: "invalid" };
	if (!Object.prototype.hasOwnProperty.call(bindings, GRAPH_GUARD_BINDING_NAMESPACE)) return { mode: "inert" };
	const candidate = record(bindings[GRAPH_GUARD_BINDING_NAMESPACE]);
	if (!candidate) return { mode: "invalid" };
	const expectedKeys = ["attempt", "contractDigest", "graphId", "schemaVersion", "taskId", "workspaceCwd"];
	const actualKeys = Object.keys(candidate).sort();
	if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
		return { mode: "invalid" };
	}
	if (candidate.schemaVersion !== 1
		|| typeof candidate.graphId !== "string" || !GRAPH_ID_PATTERN.test(candidate.graphId)
		|| typeof candidate.taskId !== "string" || !TASK_ID_PATTERN.test(candidate.taskId)
		|| !Number.isSafeInteger(candidate.attempt) || (candidate.attempt as number) < 1
		|| typeof candidate.workspaceCwd !== "string" || !isAbsolute(candidate.workspaceCwd)
		|| typeof candidate.contractDigest !== "string" || !DIGEST_PATTERN.test(candidate.contractDigest)) {
		return { mode: "invalid" };
	}
	return { mode: "required", binding: candidate as unknown as GraphGuardBinding };
}

function cappedValue(current: unknown, ceiling: number): number {
	return typeof current === "number" && Number.isFinite(current) && current > 0
		? Math.min(current, ceiling)
		: ceiling;
}

/**
 * Clamp the provider-native request field after Pi has built the payload. Pi's
 * supported providers use different names, so shape detection is deliberately
 * narrow and fails closed for an unknown payload instead of claiming a limit
 * that the provider may ignore.
 */
export function clampProviderPayloadMaxTokens(payload: unknown, ceiling: number): ProviderPayloadClampResult {
	const source = record(payload);
	if (!source || !Number.isSafeInteger(ceiling) || ceiling < 16) return { ok: false };
	let output = { ...source };
	let matched = false;

	for (const field of ["max_output_tokens", "max_completion_tokens", "max_tokens", "max_tokens_to_sample", "maxTokens", "maxOutputTokens"] as const) {
		if (!(field in output)) continue;
		output[field] = cappedValue(output[field], ceiling);
		matched = true;
	}

	const options = record(source.options);
	if (options && ("maxTokens" in options || ("context" in source && "model" in source))) {
		output = { ...output, options: { ...options, maxTokens: cappedValue(options.maxTokens, ceiling) } };
		matched = true;
	}
	const inferenceConfig = record(source.inferenceConfig);
	if (inferenceConfig) {
		output = { ...output, inferenceConfig: { ...inferenceConfig, maxTokens: cappedValue(inferenceConfig.maxTokens, ceiling) } };
		matched = true;
	}
	const generationConfig = record(source.generationConfig);
	if (generationConfig) {
		output = { ...output, generationConfig: { ...generationConfig, maxOutputTokens: cappedValue(generationConfig.maxOutputTokens, ceiling) } };
		matched = true;
	}

	// The OpenAI Codex Responses adapter currently omits its StreamOptions
	// maxTokens field. Its payload is still a Responses request and accepts the
	// standard max_output_tokens property.
	if (!matched && typeof source.model === "string" && Array.isArray(source.input)
		&& typeof source.instructions === "string" && record(source.text)) {
		output.max_output_tokens = ceiling;
		matched = true;
	}

	return matched ? { ok: true, payload: output } : { ok: false };
}

function canonical(path: string): string {
	let candidate = resolve(path);
	const suffix: string[] = [];
	while (!existsSync(candidate)) {
		const parent = dirname(candidate);
		if (parent === candidate) break;
		suffix.unshift(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		candidate = parent;
	}
	return resolve(existsSync(candidate) ? realpathSync.native(candidate) : candidate, ...suffix);
}

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function hasProtectedControlSegment(root: string, target: string): boolean {
	if (!within(root, target)) return false;
	const parts = relative(root, target).split(sep).filter(Boolean);
	return parts.some((part, index) => part === ".git" || part === ".pi-graph" || part === ".pi-subagents" || (part === "agents" && parts[index - 1] === ".pi"));
}

function isNestedProtectedControlPath(root: string, target: string): boolean {
	if (!within(root, target)) return false;
	const parts = relative(root, target).split(sep).filter(Boolean);
	return parts.some((part, index) => index > 0 && (part === ".git" || part === ".pi-graph" || part === ".pi-subagents" || (part === "agents" && parts[index - 1] === ".pi")));
}

function inScopes(path: string, scopes: GuardContract["readScope"]): boolean {
	const target = canonical(path);
	return scopes.some((scope) => scope.kind === "file" ? canonical(scope.path) === target : within(canonical(scope.path), target));
}

function isAbsolutePathList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((path) => typeof path === "string" && isAbsolute(path));
}

function isScopeList(value: unknown, workspaceCwd: string): value is GuardContract["readScope"] {
	return Array.isArray(value) && value.every((scope) => {
		const candidate = record(scope);
		return candidate !== undefined
			&& Object.keys(candidate).sort().join(",") === "kind,path"
			&& (candidate.kind === "file" || candidate.kind === "tree")
			&& typeof candidate.path === "string" && isAbsolute(candidate.path)
			&& within(canonical(workspaceCwd), canonical(candidate.path));
	});
}

function isDigestMap(value: unknown): value is Record<string, string | null> {
	const candidate = record(value);
	return candidate !== undefined && Object.entries(candidate).every(([path, digest]) =>
		isAbsolute(path) && (digest === null || (typeof digest === "string" && DIGEST_PATTERN.test(digest))));
}

function isInputBaseline(value: unknown): value is GuardContract["inputBaseline"] {
	const candidate = record(value);
	return candidate !== undefined && Object.entries(candidate).every(([name, entry]) => {
		const baseline = record(entry);
		const segments = name.split("/");
		const protectedSegment = segments.some((segment, index) => {
			const folded = segment.normalize("NFKC").toLowerCase();
			return folded === ".git" || folded === ".pi-graph" || folded === ".pi-subagents"
				|| (folded === ".pi" && segments[index + 1]?.normalize("NFKC").toLowerCase() === "agents");
		});
		return name.length > 0
			&& !name.includes("\0") && !name.includes("\\") && !name.startsWith("/")
			&& !/^[a-zA-Z]:\//u.test(name) && posix.normalize(name) === name
			&& segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
			&& !protectedSegment
			&& baseline !== undefined
			&& Object.keys(baseline).sort().join(",") === "digest,sourcePath"
			&& typeof baseline.sourcePath === "string" && isAbsolute(baseline.sourcePath)
			&& (baseline.digest === null || (typeof baseline.digest === "string" && DIGEST_PATTERN.test(baseline.digest)));
	});
}

function contractAt(cwd: string): GuardContract | null {
	const path = join(cwd, ".pi-graph", "node-contract.json");
	if (!existsSync(path)) return null;
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	const candidate = record(raw);
	if (!candidate) throw new Error("invalid node contract");
	const allowedKeys = new Set([
		"contextTools", "contextPolicy", "permissionPolicy", "parentToolAllowlist", "allowBash", "attempt", "attemptDir", "graphId", "inputBaseline", "maxTokens",
		"protectedSourceRoots", "protectedWorkspaceRoots", "readBaseline", "readOnly", "readScope", "schemaVersion",
		"sideEffect", "sourceCwd", "taskId", "toolFilter", "workspaceCwd", "writeBaseline", "writeScope",
	]);
	if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) throw new Error("invalid node contract");
	const contract = candidate as unknown as Partial<V3NodeContract>;
	if (contract.schemaVersion !== 1
		|| typeof contract.graphId !== "string" || !GRAPH_ID_PATTERN.test(contract.graphId)
		|| typeof contract.taskId !== "string" || !TASK_ID_PATTERN.test(contract.taskId)
		|| !Number.isSafeInteger(contract.attempt) || contract.attempt! < 1
		|| typeof contract.attemptDir !== "string" || !isAbsolute(contract.attemptDir)
		|| typeof contract.sourceCwd !== "string" || !isAbsolute(contract.sourceCwd)
		|| contract.workspaceCwd !== cwd || !isAbsolute(contract.workspaceCwd)
		|| !isScopeList(contract.readScope, cwd) || !isScopeList(contract.writeScope, cwd)
		|| !["none", "local_read", "local_write", "external_read", "external_write"].includes(contract.sideEffect ?? "")
		|| contract.allowBash !== (contract.permissionPolicy === "inherited" && !contract.readOnly)
		|| (contract.contextTools !== undefined && (!Array.isArray(contract.contextTools) || contract.contextTools.some(name=>!["read","grep","find","ls"].includes(name))))
		|| (contract.contextPolicy !== undefined && contract.contextPolicy !== "v1" && contract.contextPolicy !== "disabled")
		|| (contract.permissionPolicy !== undefined && contract.permissionPolicy !== "strict" && contract.permissionPolicy !== "inherited")
		|| (contract.permissionPolicy === "inherited" && (!Array.isArray(contract.parentToolAllowlist) || contract.parentToolAllowlist.some((name) => typeof name !== "string")))
		|| typeof contract.readOnly !== "boolean"
		|| !Array.isArray(contract.toolFilter) || contract.toolFilter.some((name: unknown) => typeof name !== "string" || !name)
		|| new Set(contract.toolFilter).size !== contract.toolFilter.length
		|| (contract.maxTokens !== undefined && (!Number.isSafeInteger(contract.maxTokens) || contract.maxTokens < 16))
		|| !isDigestMap(contract.writeBaseline) || !isDigestMap(contract.readBaseline)
		|| !isAbsolutePathList(contract.protectedSourceRoots) || !isAbsolutePathList(contract.protectedWorkspaceRoots)
		|| contract.protectedWorkspaceRoots.some((root) => !within(canonical(cwd), canonical(root)))
		|| !isInputBaseline(contract.inputBaseline)) throw new Error("invalid node contract");
	return contract as GuardContract;
}

function requiredContractAt(cwd: string, activation: Exclude<GuardActivation, { mode: "inert" }>): GuardContract {
	if (activation.mode === "invalid") throw new Error("invalid pi-graph extension binding");
	const { binding } = activation;
	if (binding.workspaceCwd !== cwd) throw new Error("pi-graph extension binding targets another workspace");
	const contract = contractAt(cwd);
	if (!contract) throw new Error("required node contract is missing");
	if (canonicalDigest(contract) !== binding.contractDigest
		|| contract.graphId !== binding.graphId
		|| contract.taskId !== binding.taskId
		|| contract.attempt !== binding.attempt
		|| contract.workspaceCwd !== binding.workspaceCwd) {
		throw new Error("node contract does not match its pi-graph extension binding");
	}
	return contract;
}

function registeredProviderIds(
	modelRegistry: { getRegisteredProviderIds?: () => readonly string[] } | undefined,
): ReadonlySet<string> | null {
	try {
		const registered = modelRegistry?.getRegisteredProviderIds?.call(modelRegistry);
		if (!Array.isArray(registered) || registered.some((provider) => typeof provider !== "string")) return null;
		return new Set(registered);
	} catch {
		return null;
	}
}

/** Owned custom models use SDK transports, never extension streamSimple overrides. */
function trustedOwnedModel(ctx:any):boolean {
 try {
  if(process.env.PI_GRAPH_CHILD!=="1")return false;
  const definitions=JSON.parse(process.env.PI_GRAPH_CUSTOM_MODELS??"[]");
  const m=definitions.find((m:any)=>m.provider===ctx.model?.provider&&m.id===ctx.model?.id);
  const config=ctx.modelRegistry?.getRegisteredProviderConfig?.(ctx.model.provider);
  return !!m && m.api===ctx.model.api && m.baseUrl===ctx.model.baseUrl && !!config && config.streamSimple===undefined;
 }catch{return false;}
}

function pathInput(event: ToolCallEvent, cwd: string): string | null {
	const input = event.input as Record<string, unknown>;
	if (!["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) return null;
	const value = input.path;
	return typeof value === "string" && value.trim() ? resolve(cwd, value) : cwd;
}

function hasPathLikeInput(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(hasPathLikeInput);
	return Object.entries(value as Record<string, unknown>).some(([key, child]) => /(?:path|file|dir|cwd|root)/i.test(key) || hasPathLikeInput(child));
}

function bashViolation(command: string, contract: GuardContract): string | null {
	void command;
	void contract;
	return "bash is disabled for graph child nodes because shell path authority cannot be proven soundly.";
}

export function remoteToolViolation(toolName: string, contract: Pick<V3NodeContract, "toolFilter">): string | null {
	if (!contract.toolFilter.includes(toolName)) return `non-file tool '${toolName}' is outside the exact graph toolFilter.`;
	if (!isReadOnlyRemoteToolName(toolName)) return `non-file tool '${toolName}' is not an attested read-only operation.`;
	return null;
}

export default function piGraphGuard(pi: ExtensionAPI): void {
	if (process.env.PI_GRAPH_CHILD !== "1") pi.on("session_start", (_event, ctx) => {
  const issue = checkNativeRuntimePatch();
  if (issue) ctx.ui.notify(issue, "warning");
 });
 const activationForTools = graphGuardActivation(process.env[EXTENSION_BINDINGS_ENV]);
 registerGraphReadonlyTools(pi, (cwd) => {
  if (activationForTools.mode === "inert") return {cwd, scopes: [{kind: "tree", path: cwd}]};
  const contract = requiredContractAt(cwd, activationForTools);
  return {cwd: contract.workspaceCwd, scopes: [...contract.readScope, ...contract.writeScope], deniedRoots: contract.protectedWorkspaceRoots, inputFiles: Object.keys(contract.inputBaseline).map(name => join(contract.workspaceCwd, ".pi-graph", "inputs", name))};
 });
 if (process.env.PI_GRAPH_CHILD !== "1") return;
	pi.events.emit("pi-graph:acknowledge-extension", { id: "pi-graph-guard" });
	const activation = graphGuardActivation(process.env[EXTENSION_BINDINGS_ENV]);
	// pi-graph is package-autoloaded, so ordinary subagents must not inherit its
	// workspace or provider policy merely because they are child processes.
	if (activation.mode === "inert") return;
 let mailbox: {socketPath:string;token:string}|undefined;
 try { const raw=JSON.parse(process.env[EXTENSION_BINDINGS_ENV]??"{}")[MAILBOX_BINDING_NAMESPACE]; if(raw && typeof raw.socketPath==="string" && typeof raw.token==="string") mailbox=raw; } catch {}
 if(mailbox) registerGraphMailboxTool(pi,mailbox);
 const restrictCommunication=()=>pi.setActiveTools(pi.getActiveTools().filter(name=>name!=="contact_supervisor" && name!=="subagent_supervisor" && !name.startsWith("intercom")));
 pi.on("session_start",restrictCommunication);
 pi.on("before_agent_start",restrictCommunication);

	pi.on("input", (_event, ctx) => {
		try {
			requiredContractAt(ctx.cwd, activation);
			const providerIds = registeredProviderIds(ctx.modelRegistry);
			const currentProvider = ctx.model?.provider;
			// `input` is the last cancellable boundary before Pi starts the Agent. An
			// extension Provider may supply streamSimple and skip Pi's payload hook,
			// while built-in/models.json Providers are absent from this registry.
			if (providerIds === null || typeof currentProvider !== "string" || (providerIds.has(currentProvider) && !trustedOwnedModel(ctx))) {
				return { action: "handled" as const };
			}
		} catch {
			return { action: "handled" as const };
		}
		return { action: "continue" as const };
	});
	pi.on("context", (event, ctx) => {
  const contract = requiredContractAt(ctx.cwd, activation);
  if (contract.contextPolicy !== "v1") return;
  return { messages: projectGraphContext(event.messages, new Set([...builtinContextTools(pi.getAllTools())].filter(name=>contract.contextTools?.includes(name)))) };
 });
	pi.on("before_provider_request", (event, ctx) => {
		let contract: GuardContract;
		try {
			contract = requiredContractAt(ctx.cwd, activation);
		} catch {
			// A non-undefined return value only replaces Pi's payload. Abort first so
			// the provider transport cannot send the replacement body.
			ctx.abort();
			return null;
		}
		if (!contract.maxTokens) return;
		const clamped = clampProviderPayloadMaxTokens(event.payload, contract.maxTokens);
		if (clamped.ok) return clamped.payload;
		ctx.abort();
		return null;
	});
	const permissionGate = (event:ToolCallEvent, ctx:ExtensionContext) => {
		let contract: GuardContract;
		try {
			contract = requiredContractAt(ctx.cwd, activation);
		} catch {
			ctx.abort();
			return { block: true, reason: "pi-graph guard: required node contract or binding is missing, malformed, or changed; failing closed." };
		}
		if(event.toolName === "contact_supervisor" || event.toolName === "subagent_supervisor" || event.toolName.startsWith("intercom")) return {block:true,reason:"Graph uses only graph_mailbox communication."};
  if(event.toolName === "graph_mailbox") return mailbox ? undefined : {block:true,reason:"Mailbox capability unavailable."};
  if (contract.parentToolAllowlist !== undefined && event.toolName !== "graph_mailbox" && !contract.parentToolAllowlist.includes(event.toolName)) return { block: true, reason: "pi-graph guard: tool is outside parent tool ceiling." };
		if (contract.toolFilter.length > 0 && !contract.toolFilter.includes(event.toolName)) {
			return { block: true, reason: `pi-graph guard: tool '${event.toolName}' is outside the graph toolFilter.` };
		}
  // Control-plane protection applies even when business file authority is inherited.
  let ownedRoots:{writes:string[];reads:string[]}={writes:[],reads:[]};
  try{ownedRoots=JSON.parse(process.env.PI_GRAPH_PROTECTED_ROOTS??'{"writes":[],"reads":[]}');}catch{return {block:true,reason:"Malformed owned control protection."};}
  const ownedTarget=pathInput(event,ctx.cwd),ownedWriting=event.toolName==="write"||event.toolName==="edit";
  if(ownedTarget&&[...(ownedWriting?ownedRoots.writes:ownedRoots.reads)].some(root=>within(canonical(root),canonical(ownedTarget))))return {block:true,reason:"Owned Graph runtime/proof/config control paths are protected."};
		if ((GRAPH_READONLY_TOOLS as readonly string[]).includes(event.toolName)) return;
		if (contract.permissionPolicy === "inherited") {
			const readonlyTool = [...GRAPH_READONLY_TOOLS, "read", "grep", "find", "ls"].includes(event.toolName) || isReadOnlyRemoteToolName(event.toolName);
			if (contract.readOnly && !readonlyTool) return { block: true, reason: "pi-graph guard: this graph is read-only." };
			return;
		}
		// Native upward coordination is control-plane traffic, not remote task I/O.
		// Keep explicit opt-in even when the file-tool filter is unrestricted ([]).
		// Pi exposes a tool name here, not attested implementation provenance: the
		// host and configured extensions remain trusted. Do not register/replace it.
		// Native interview fields (including path-like keys) are message data; the
		// runtime supplies the channel/run identity, never the caller's arguments.

		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			const violation = bashViolation(typeof command === "string" ? command : "", contract);
			if (violation) return { block: true, reason: `pi-graph guard: ${violation}` };
			return;
		}
		const target = pathInput(event, ctx.cwd);
			if (!target) {
				if (hasPathLikeInput(event.input)) return { block: true, reason: `pi-graph guard: unsupported path-bearing tool '${event.toolName}' is blocked.` };
			const remoteViolation = remoteToolViolation(event.toolName, contract);
			if (remoteViolation) return { block: true, reason: `pi-graph guard: ${remoteViolation}` };
			return;
		}
		const contractFile = join(contract.workspaceCwd, ".pi-graph", "node-contract.json");
		const writing = event.toolName === "write" || event.toolName === "edit";
		if (writing && contract.readOnly) return { block: true, reason: "pi-graph guard: this graph is read-only." };
		if (isNestedProtectedControlPath(contract.workspaceCwd, target)) {
			return { block: true, reason: "pi-graph guard: nested runtime, Agent, and repository control paths are not accessible." };
		}
		if (hasProtectedControlSegment(contract.workspaceCwd, target) && canonical(target) !== canonical(contractFile) && !inScopes(target, writing ? contract.writeScope : contract.readScope)) {
			return { block: true, reason: "pi-graph guard: nested runtime, Agent, and repository control paths are not accessible." };
		}
		const protectedWriteRoots = [join(contract.workspaceCwd, ".pi-graph"), join(contract.workspaceCwd, ".pi", "agents"), join(contract.workspaceCwd, ".pi-subagents"), join(contract.workspaceCwd, ".git"), ...(contract.protectedWorkspaceRoots ?? [])];
		if (writing && protectedWriteRoots.some((root) => within(canonical(root), canonical(target)))) {
			return { block: true, reason: "pi-graph guard: runtime, Agent, and repository control files are read-only." };
		}
        const authorizedInputRead = contract.contextPolicy === "v1" && event.toolName === "read"
         && contract.contextTools?.includes("read") && builtinContextTools(pi.getAllTools()).has("read")
         && inputArtifactName(contract,event.input) !== undefined && inScopes(target,contract.readScope);
		const protectedReadRoots = [join(contract.workspaceCwd, ".pi", "agents"), join(contract.workspaceCwd, ".pi-subagents"), join(contract.workspaceCwd, ".git"), ...(contract.protectedWorkspaceRoots ?? [])];
		if (!writing && !authorizedInputRead && protectedReadRoots.some((root) => within(canonical(root), canonical(target)))) {
			return { block: true, reason: "pi-graph guard: runtime, Agent, and repository control files are not child-readable." };
		}
		if (canonical(target) === canonical(contractFile)) {
			return;
		}
		const scopes = writing ? contract.writeScope : [...contract.readScope, ...contract.writeScope];
		if (!inScopes(target, scopes)) return { block: true, reason: `pi-graph guard: ${event.toolName} path is outside declared ${writing ? "write" : "read"} scope: ${target}` };
};
 const inputReads=new Map<string,InputReadProof>();
 pi.on("tool_call",(event,ctx)=>{
  try {
   const permission=permissionGate(event,ctx);if(permission)return permission;
   const contract=requiredContractAt(ctx.cwd,activation);
   if(contract.contextPolicy!=="v1" || event.toolName!=="read")return;
   const name=inputArtifactName(contract,event.input);if(name===undefined)return;
   if(!builtinContextTools(pi.getAllTools()).has("read"))return {block:true,reason:"Graph input requires the attested builtin read tool."};
   return proveInputRead(contract,name).then(proof=>{inputReads.set(event.toolCallId,proof);}).catch(()=>{
    inputReads.delete(event.toolCallId);return {block:true,reason:"Graph input integrity check failed; material must not be read."};
   });
  }catch { inputReads.delete(event.toolCallId);return {block:true,reason:"Graph input integrity check failed; material must not be read."}; }
 });
 pi.on("tool_result",async(event,ctx)=>{
  const proof=inputReads.get(event.toolCallId);inputReads.delete(event.toolCallId);
  let protectedRead=!!proof;
  try {
   const contract=requiredContractAt(ctx.cwd,activation);
   const name=inputArtifactName(contract,event.input);
   protectedRead ||= contract.contextPolicy==="v1" && event.toolName==="read" && name!==undefined;
   if(!protectedRead)return;
   if(!proof || name!==proof.name || contract.contextPolicy!=="v1" || event.toolName!=="read" || !builtinContextTools(pi.getAllTools()).has("read"))throw new Error("missing or changed proof");
   const after=await proveInputRead(contract,proof.name);
   if(after.identity!==proof.identity || after.digest!==proof.digest)throw new Error("changed material");
  }catch {
   if(protectedRead || event.toolName==="read")return {content:[{type:"text" as const,text:"Graph input integrity check failed; read output withheld."}],details:{graphInputIntegrity:"failed"},isError:true};
  }
 });
 pi.on("session_shutdown",()=>{inputReads.clear();});
 pi.on("agent_end",()=>{inputReads.clear();});

}
