import { resolveHostSdkRoot } from "../../src/runtime/host-sdk.ts";
import { discoverTestPiFromPath, testCliFromRoot } from "./pi-cli-discovery.ts";
// Production host discovery remains unchanged. Node test argv needs a separate, test-only installed CLI path.
let root:string|undefined;
try { root=await resolveHostSdkRoot(); }
catch(error){if(!(error instanceof Error)||error.message!=="Cannot locate host Pi SDK; refuse extension-owned SDK fallback.")throw error;}
const installed=root?await testCliFromRoot(root):await discoverTestPiFromPath();
export const piCliPath=installed.cli;
export const piCliIdentity=installed;
