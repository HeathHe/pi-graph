import {constants} from 'node:fs';
import {mkdir,lstat,open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {JournalFactoryBinding,JournalPort} from 'pi-graph-observability';
import {acquirePrivateStateLock,type PrivateStateLockOptions} from '../gateway/private-state-transaction.ts';
export interface PrivateJournalOptions {root:string;lock?:Pick<PrivateStateLockOptions,'processIdentity'|'processLiveness'|'pid'|'platform'|'now'|'delay'>}
async function enforcePrivate(path:string,kind:'directory'|'file'):Promise<void>{const info=await lstat(path);if(info.isSymbolicLink()||(kind==='directory'?!info.isDirectory():!info.isFile())||(typeof process.getuid==='function'&&info.uid!==process.getuid())||(info.mode&0o077)!==0)throw new Error('Observability journal requires owned private regular storage');}
async function syncDirectory(path:string):Promise<void>{const handle=await open(path,constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}}
/** Explicit approved root only. No getAgentDir/default-home fallback lives here. */
export function createPrivateJournalPort(options:PrivateJournalOptions,binding:JournalFactoryBinding):JournalPort {
 const digests=[binding.workspaceDigest,binding.sessionDigest];if(digests.some(x=>!/^[a-f0-9]{64}$/.test(x)))throw new Error('Invalid journal partition');
 const namespace=join(options.root,'pi-graph-next'),area=join(namespace,'observability'),version=join(area,'v1'),directory=join(version,...digests),file=join(directory,'supervision.json');
 const current=()=>{if(!binding.lease.current())throw new Error('Stale Root journal lease');};
 return {async transact(scopeKey,fn){
  current();if(scopeKey!==JSON.stringify(digests))throw new Error('Foreign journal transaction');
  // Validate each created component; recursive mkdir alone must not follow a planted partition symlink.
  await enforcePrivate(options.root,'directory');
  for(const path of [namespace,area,version,join(version,digests[0]!),directory]){await mkdir(path,{recursive:false,mode:0o700}).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});await enforcePrivate(path,'directory');}
  const lock=await acquirePrivateStateLock({directory,name:'.supervision.lock',timeoutMs:1000,...options.lock,enforcePrivate,durability:{syncFile:async path=>{const h=await open(path,constants.O_RDONLY);try{await h.sync();}finally{await h.close();}},syncDirectory}});
  try{return await fn({async assertOwned(){current();await lock.assertOwned();current();},async readBounded(max){current();try{await enforcePrivate(file,'file');const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(stat.size>max)throw new Error('oversize');const buffer=Buffer.alloc(max+1),result=await handle.read(buffer,0,max+1,0);if(result.bytesRead>max)throw new Error('oversize');current();return buffer.subarray(0,result.bytesRead).toString('utf8');}finally{await handle.close();}}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}},async replaceAtomically(bytes){current();await lock.assertOwned();try{await enforcePrivate(file,'file');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const temporary=join(directory,`.supervision-${randomUUID()}.tmp`);const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await handle.writeFile(bytes,'utf8');await handle.sync();await lock.assertOwned();current();await rename(temporary,file);await syncDirectory(directory);}finally{await handle.close();await unlink(temporary).catch(()=>{});}
   }});}finally{await lock.release();}
 }};
}
