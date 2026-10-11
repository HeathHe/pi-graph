import { atomicWriteJson } from "./durable.ts";
import { createServer, createConnection, type Socket, type Server } from "node:net";
import { mkdtemp, chmod, rm, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { GraphMailbox, MailboxRequest } from "./mailbox.ts";
export interface MailboxBinding { socketPath: string; token: string }
export class MailboxBroker {
 private server?: Server;
 private sockets=new Set<Socket>();
 private directory?: string;
 socketPath = "";
 readonly mailbox:GraphMailbox;
 constructor(mailbox:GraphMailbox){this.mailbox=mailbox;}
 async start(): Promise<void> {
  await this.mailbox.lease.withFence(async()=>{
   const endpoint=join(this.mailbox.runDir,"mailbox-v1","endpoint.json");
   let stored: {directory:string}|undefined;try{const info=await lstat(endpoint);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>1024)throw new Error("Unsafe mailbox endpoint");stored=JSON.parse(await readFile(endpoint,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   if(stored){if(!/^\/private\/tmp\/pi-graph-mb-[A-Za-z0-9]+$/.test(stored.directory))throw new Error("Invalid endpoint directory");this.directory=stored.directory;const info=await lstat(this.directory);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error("Unsafe endpoint directory");}
   else {this.directory=await mkdtemp("/private/tmp/pi-graph-mb-");await chmod(this.directory,0o700);await atomicWriteJson(endpoint,{directory:this.directory});}
   this.socketPath=join(this.directory,"s");
   const prior=await lstat(this.socketPath).catch((error)=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;});if(prior){if(!prior.isSocket()||prior.uid!==process.getuid?.())throw new Error("Unsafe stale mailbox socket");await rm(this.socketPath);}
  });
  this.server=createServer(socket=>{this.sockets.add(socket);socket.on("close",()=>this.sockets.delete(socket));let data=Buffer.alloc(0);let handled=false;socket.setTimeout(30_000,()=>socket.destroy());socket.on("error",()=>undefined);socket.on("data",chunk=>{if(handled)return;data=Buffer.concat([data,chunk]);if(data.length>7*1024*1024){socket.destroy();return;}if(!data.includes(10))return;handled=true;
   void (async()=>{try{const frame=JSON.parse(data.subarray(0,data.indexOf(10)).toString("utf8"));if(typeof frame.token!=="string")throw new Error("Missing capability");const value=await this.mailbox.request(frame.token,frame.request);socket.end(JSON.stringify({ok:true,value})+"\n");}catch(error){socket.end(JSON.stringify({ok:false,error:error instanceof Error && /^(Mailbox|Message|Recipient|Reply|Only recipient|Idempotency|Unknown mailbox|Invalid mailbox|Parent receives|Stale actor|Stale attempt)/.test(error.message) && !/[\n\r"\/]/.test(error.message) ? error.message : "Mailbox request rejected or unavailable"})+"\n");}})();});});
  await new Promise<void>((resolve,reject)=>{this.server!.once("error",reject);this.server!.listen(this.socketPath,resolve);});await chmod(this.socketPath,0o600);
 }
 async close(): Promise<void> {for(const socket of this.sockets)socket.destroy();this.sockets.clear();if(this.server)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));}
}
export function mailboxRequest(binding:MailboxBinding,request:MailboxRequest,signal?:AbortSignal):Promise<unknown>{return new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(new Error("Mailbox wait cancelled"));return;}
 const wire=JSON.stringify({token:binding.token,request})+"\n";if(Buffer.byteLength(wire)>7*1024*1024){reject(new Error("Mailbox frame limit exceeded"));return;}
 const socket=createConnection(binding.socketPath);let data=Buffer.alloc(0);let completed=false;
 const finish=(error?:Error,value?:unknown)=>{if(completed)return;completed=true;signal?.removeEventListener("abort",abort);error?reject(error):resolve(value);socket.destroy();};
 const abort=()=>finish(new Error("Mailbox wait cancelled"));signal?.addEventListener("abort",abort,{once:true});socket.setTimeout(15_000,()=>finish(new Error("Mailbox unavailable; state unknown, retry same idempotencyKey")));
 socket.on("connect",()=>socket.write(wire));socket.on("data",chunk=>{data=Buffer.concat([data,chunk]);if(data.length>16384){finish(new Error("Mailbox response too large"));return;}const end=data.indexOf(10);if(end>=0){try{const frame=JSON.parse(data.subarray(0,end).toString("utf8"));frame.ok?finish(undefined,frame.value):finish(new Error(frame.error));}catch(error){finish(error instanceof Error?error:new Error("Invalid frame"));}}});socket.on("error",error=>finish(error));socket.on("close",()=>{if(!completed)finish(new Error("Mailbox disconnected before response; state unknown"));});
});}
