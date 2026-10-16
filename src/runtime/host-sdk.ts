import { readFile, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalDigest } from '../v3/digests.ts';
import { pathToFileURL } from 'node:url';
const NAME = '@earendil-works/pi-coding-agent';
/** Resolve the host installation, never an extension-owned development SDK. */
export async function resolveHostSdkRoot(explicit?: string): Promise<string> {
 if (explicit) return validateRoot(explicit);
 for (const executable of [process.argv[1], join(dirname(process.execPath), 'pi')]) {
  if (!executable) continue;
  let dir: string;
  try { dir = dirname(await realpath(executable)); } catch { continue; }
  for (let i=0; i<8; i++) {
   let pkg:any;try {pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));}catch{}
   if(pkg?.name===NAME)return validateRoot(dir);
   const parent=dirname(dir); if(parent===dir) break; dir=parent;
  }
 }
 throw new Error('Cannot locate host Pi SDK; refuse extension-owned SDK fallback.');
}
async function validateRoot(root: string): Promise<string> {
 const absolute=await realpath(resolve(root));
 const pkg=JSON.parse(await readFile(join(absolute,'package.json'),'utf8'));
 if(pkg.name!==NAME || typeof pkg.version!=='string' || !pkg.version) throw new Error(`Unsupported host Pi SDK identity: expected ${NAME} with version metadata.`);
 return absolute;
}
export interface HostSdkIdentity {
 version:1; root:string; packageName:string; packageVersion:string; entry:string;
 files:Array<{path:string;sha256:string}>; digest:string;
}
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
async function importEntry(root:string,pkg:any):Promise<string>{
 const exported=pkg.exports?.['.']?.import;
 if(typeof exported!=='string'||!exported.startsWith('./'))throw Error('Host SDK lacks an import entry.');
 const entry=await realpath(resolve(root,exported)),r=relative(root,entry);
 if(r.startsWith('..')||isAbsolute(r))throw Error('Host SDK import entry escapes package.');
 return entry;
}
/** Node resolution anchored at the host, never at this extension. Supports hoisted dependencies. */
export async function resolveHostDependencyRoot(root:string,name:string):Promise<string>{
 if(!['@earendil-works/pi-agent-core','@earendil-works/pi-ai','@earendil-works/pi-tui'].includes(name))throw Error('Unsupported host SDK dependency');
 root=await validateRoot(root);
 const locations:string[]=[];
 // Node's ancestor node_modules order, anchored only at the canonical host.
 // No NODE_PATH, cwd, extension-owned or separately configured global fallback.
 let parent=root;
 for(;;){if(basename(parent)!=='node_modules')locations.push(join(parent,'node_modules',name));const next=dirname(parent);if(next===parent)break;parent=next;}
 for(const location of locations){
  try{await lstat(location);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  const dir=await realpath(location),pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
  if(pkg.name!==name||typeof pkg.version!=='string'||!pkg.version)throw Error('Host SDK dependency identity mismatch: '+name);
  return dir;
 }
 throw Error('Host SDK dependency identity unavailable: '+name);
}
async function describeHost(root:string):Promise<HostSdkIdentity>{
 root=await validateRoot(root);const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 const entry=await importEntry(root,pkg);
 const paths=[join(root,'package.json'),entry,join(root,'dist/core/agent-session.js'),join(root,'dist/core/session-manager.js'),join(root,'dist/core/sdk.js')];
 for(const name of ['@earendil-works/pi-agent-core','@earendil-works/pi-ai','@earendil-works/pi-tui']){
  const dependency=await resolveHostDependencyRoot(root,name);
  const meta=JSON.parse(await readFile(join(dependency,'package.json'),'utf8'));
  const entry=meta.exports?.['.']?.import??meta.main;
  if(typeof entry!=='string')throw Error('Host dependency lacks an entry: '+name);
  const dependencyEntry=await realpath(resolve(dependency,entry)),rel=relative(dependency,dependencyEntry);
  if(rel.startsWith('..')||isAbsolute(rel))throw Error('Host dependency entry escapes package: '+name);
  paths.push(join(dependency,'package.json'),dependencyEntry);
  if(name.endsWith('pi-agent-core'))paths.push(join(dependency,'dist/agent.js'));
  if(name.endsWith('pi-ai'))paths.push(join(dependency,'dist/utils/event-stream.js'));
 }
 const files=await Promise.all([...new Set(paths)].sort().map(async path=>({path:await realpath(path),sha256:sha(await readFile(path))})));
 const body={version:1 as const,root,packageName:pkg.name,packageVersion:pkg.version,entry,files};
 return {...body,digest:canonicalDigest(body)};
}
/** Called only by the host controller; no RPC/task/environment SDK override is accepted. */
export async function captureHostSdkIdentity():Promise<HostSdkIdentity>{return describeHost(await resolveHostSdkRoot());}
export async function validateHostSdkIdentity(identity:HostSdkIdentity|undefined):Promise<HostSdkIdentity>{
 if(!identity||identity.version!==1||typeof identity.root!=='string'||identity.packageName!==NAME||!Array.isArray(identity.files)||typeof identity.digest!=='string')throw Error('Missing or invalid frozen host Pi SDK identity; legacy intent cannot be migrated.');
 const {digest,...body}=identity;if(canonicalDigest(body)!==digest)throw Error('Frozen host Pi SDK identity digest mismatch.');
 const actual=await describeHost(identity.root);
 if(actual.digest!==digest)throw Error('Frozen host Pi SDK deployment changed.');
 return actual;
}
export async function loadHostSdk(explicit?:string): Promise<{root:string;sdk:any}> {
 const root=await resolveHostSdkRoot(explicit);const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 const sdk=await import(pathToFileURL(await importEntry(root,pkg)).href);assertHostSdkCapabilities(sdk,pkg.version);return {root,sdk};
}
export async function loadFrozenHostSdk(identity:HostSdkIdentity|undefined):Promise<{root:string;sdk:any}>{
 const verified=await validateHostSdkIdentity(identity);
 const sdk=await import(pathToFileURL(verified.entry).href);assertHostSdkCapabilities(sdk,verified.packageVersion);
 await validateHostSdkIdentity(identity);return {root:verified.root,sdk};
}

/** Version numbers are diagnostic metadata; the public APIs determine compatibility. */
export function assertHostSdkCapabilities(sdk:any,version='unknown'):void {
 const functions=[['createAgentSession',sdk?.createAgentSession],['ModelRuntime.create',sdk?.ModelRuntime?.create],['SettingsManager.create',sdk?.SettingsManager?.create],['SettingsManager.inMemory',sdk?.SettingsManager?.inMemory],['SessionManager.create',sdk?.SessionManager?.create],['DefaultResourceLoader',sdk?.DefaultResourceLoader],['createEventBus',sdk?.createEventBus],['resolveCliModel',sdk?.resolveCliModel],['createBashToolDefinition',sdk?.createBashToolDefinition]];
 const missing=functions.filter(([,value])=>typeof value!=='function').map(([name])=>name);
 for(const name of ['reload','getExtensions'])if(typeof sdk?.DefaultResourceLoader?.prototype?.[name]!=='function')missing.push(`DefaultResourceLoader.${name}`);
 if(missing.length)throw new Error(`Host Pi SDK ${version} is incompatible: missing required APIs ${missing.join(', ')}. No child prompt was started.`);
}
/** Validate the returned instance before extension startup or task/provider activity. */
export function assertHostSessionCapabilities(session:any):void {
 const missing=['prompt','abort','dispose','subscribe','bindExtensions','waitForIdle','getSteeringMessages','getFollowUpMessages'].filter(name=>typeof session?.[name]!=='function');
 if(!session?.agent?.state)missing.push('agent.state');
 if(!Array.isArray(session?.messages))missing.push('messages');
 if(!Number.isSafeInteger(session?.pendingMessageCount)||session.pendingMessageCount<0)missing.push('pendingMessageCount');
 if(typeof session?.extensionRunner?.hasHandlers!=='function'||typeof session?.extensionRunner?.emit!=='function')missing.push('extensionRunner lifecycle');
 if(missing.length)throw new Error(`Host Pi SDK session is incompatible: missing required capabilities ${missing.join(', ')}. No child prompt was started.`);
}

export function assertHostModelRuntimeCapabilities(runtime:any):void {
 const missing=['getModels','registerProvider','registerNativeProvider','getAuth','hasConfiguredAuth','refresh'].filter(name=>typeof runtime?.[name]!=='function');
 if(missing.length)throw new Error(`Host Pi SDK model runtime is incompatible: missing required APIs ${missing.join(', ')}. No child prompt was started.`);
}

/** Continuation is opt-in: legacy child capability requirements stay unchanged. */
export function assertContinuationCapabilities(sdk:any,session:any):void {
 const missing=['setModel','setThinkingLevel','waitForIdle'].filter(k=>typeof session?.[k]!=='function');
 if(typeof sdk?.SessionManager?.open!=='function')missing.push('SessionManager.open');
 if(typeof session?.isIdle!=='boolean')missing.push('isIdle');
 if(typeof session?.sessionManager?.getSessionId!=='function'||typeof session?.sessionManager?.buildSessionContext!=='function')missing.push('session identity/context');
 if(missing.length)throw Error('Host SDK cannot safely continue sessions: '+missing.join(', '));
}
