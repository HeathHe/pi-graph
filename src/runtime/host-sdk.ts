import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
   try { const pkg = JSON.parse(await readFile(join(dir,'package.json'),'utf8')); if(pkg.name === NAME) return validateRoot(dir); } catch {}
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
export async function loadHostSdk(explicit?:string): Promise<{root:string;sdk:any}> {
 const root=await resolveHostSdkRoot(explicit);
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 const exported=pkg.exports?.['.']?.import;
 if(typeof exported!=='string'||!exported.startsWith('./'))throw new Error('Host SDK lacks an import entry.');
 const entry=join(root,exported);
 const sdk=await import(pathToFileURL(entry).href);
 assertHostSdkCapabilities(sdk,pkg.version);
 return {root,sdk};
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
