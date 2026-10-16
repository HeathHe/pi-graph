import {registerHooks} from 'node:module';
import {readFileSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=realpathSync(process.env.PI_GRAPH_TEST_HOST_SDK ?? (()=>{throw Error('SDK fixture requires its parent selected host');})());
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
if(pkg.name!=='@earendil-works/pi-coding-agent')throw Error('Invalid SDK fixture host');
export const SDK=root;
const hostEntry=pathToFileURL(join(root,pkg.exports['.'].import)).href;
function dependency(name){for(let dir=root;;dir=dirname(dir)){try{const dep=realpathSync(join(dir,'node_modules',name));const meta=JSON.parse(readFileSync(join(dep,'package.json'),'utf8'));if(meta.name!==name)throw Error('Dependency identity mismatch');return dep;}catch(error){if(error.code!=='ENOENT')throw error;}if(dirname(dir)===dir)throw Error('Host dependency missing: '+name);}}
export const AI=dependency('@earendil-works/pi-ai');
registerHooks({resolve(specifier,context,next){
 if(['@earendil-works/pi-coding-agent','@earendil-works/pi-ai','@earendil-works/pi-agent-core','@earendil-works/pi-tui'].some(name=>specifier===name||specifier.startsWith(name+'/'))){
  return next(specifier,{...context,parentURL:hostEntry});
 }
 return next(specifier,context);
}});
