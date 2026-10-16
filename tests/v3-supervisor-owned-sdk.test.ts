import {captureHostSdkIdentity} from '../src/runtime/host-sdk.ts';
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const existing of [false, true]) {
 test(`owned SDK Graph mailbox decision ${existing ? "already pending" : "arrives during wait"}; parent abort preserves child`, { timeout: 45000 }, async () => {
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("./helpers/supervisor-sdk-loader.mjs", import.meta.url)), fileURLToPath(new URL("./helpers/supervisor-sdk-roundtrip.mjs", import.meta.url)), ...(existing ? ["--existing"] : [])], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,PI_GRAPH_TEST_HOST_SDK:(await captureHostSdkIdentity()).root } });
  let output = "";
  child.stdout.on("data", value => { output += String(value); });
  child.stderr.on("data", value => { output += String(value); });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 40000);
  try {
   const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
   assert.equal(code, 0, output);
   assert.match(output, /actual Graph mailbox client\/broker/);
   assert.match(output, /active child survives until explicit child cleanup/);
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }
 });
}
