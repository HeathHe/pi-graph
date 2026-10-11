import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
export function ownedProtectedRoots(intent:{asyncDir:string;params:{cwd:string}},agentDir=join(homedir(),'.pi','agent')) {
 const cwd=intent.params.cwd, writes=[dirname(intent.asyncDir),fileURLToPath(new URL('../../',import.meta.url)),join(cwd,'.pi-graph'),join(cwd,'.pi','agents'),join(cwd,'.pi','graph-models.json'),join(agentDir,'agents'),join(agentDir,'settings.json'),join(agentDir,'graph-models.json'),join(agentDir,'auth.json')],reads=[dirname(intent.asyncDir),join(agentDir,'auth.json')];
 try{const c=JSON.parse(readFileSync(join(cwd,'.pi-graph','node-contract.json'),'utf8'));if(c.sourceCwd){writes.push(join(c.sourceCwd,'.pi','graph-models.json'),join(c.sourceCwd,'.pi','agents'));}if(c.attemptDir){const run=dirname(dirname(dirname(dirname(c.attemptDir))));for(const name of ['nodes','agent-profiles','mailbox-v1','sessions','authorization.json','control.json','events.jsonl','snapshot.json','supervisor-fence.json'])writes.push(join(run,name));}}catch{}
 const canonical=(p:string)=>{let base=resolve(p);const suffix:string[]=[];while(!existsSync(base)&&dirname(base)!==base){suffix.unshift(base.slice(dirname(base).length+1));base=dirname(base);}return join(realpathSync(base),...suffix);};
 return {writes:[...new Set(writes.map(canonical))],reads:[...new Set(reads.map(canonical))]};
}
const shellQuote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
export function protectOwnedShell(command:string,roots:{writes:string[];reads:string[]}) {
 if(process.platform!=='darwin'||!existsSync('/usr/bin/sandbox-exec'))throw Error('Owned Graph shell protection requires macOS sandbox-exec; refusing unprotected shell.');
 const filter=(p:string)=>`(subpath ${JSON.stringify(p)})`;
 const profile=`(version 1)(allow default)(deny file-write* ${roots.writes.map(filter).join(' ')})(deny file-read* ${roots.reads.map(filter).join(' ')})`;
 return `/usr/bin/sandbox-exec -p ${shellQuote(profile)} /bin/bash -c ${shellQuote(command)}`;
}
