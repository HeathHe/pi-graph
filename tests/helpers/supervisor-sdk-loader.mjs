import {registerHooks,createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const fromHost=createRequire('/Users/heathhe/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/package.json');
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return next(specifier,{...context,parentURL:'file:///Users/heathhe/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js'});}}});
