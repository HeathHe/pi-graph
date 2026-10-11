import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Actual SDK tools + durable product store/broker/lease; faux only, no network.
// Full GraphHost guard/admission/root-wake filtering is a separate integration.
async function runFixture(extra: string[] = []) {
  const child = spawn(process.execPath, [
    "--import", fileURLToPath(new URL("./helpers/supervisor-sdk-loader.mjs", import.meta.url)),
    fileURLToPath(new URL("./helpers/mailbox-sdk-roundtrip.mjs", import.meta.url)),
    ...extra,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 25_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    assert.equal(code, 0, output);
    console.log(output.trim());
    return output;
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGTERM"); }
}
test("actual SDK two-child mailbox client tools communicate through isolated product durable mailbox/broker", { timeout: 30_000 }, async () => {
  const output = await runFixture();
  assert.match(output, /PASS actual SDK two-child graph_mailbox send\/read\/reply\/ack via product durable mailbox\/broker/);
  assert.match(output, /SCOPE actual SDK \+ product mailbox\/broker\/lease/);
});
test("frozen native tool plan and actual SDK guard expose mailbox and hide Graph legacy communication", {timeout:30_000}, async()=>{
  const output = await runFixture(["--guard-visibility"]);
  assert.match(output,/PASS frozen native tool plan \+ actual SDK guard registers graph_mailbox/);
  assert.match(output,/SCOPE guard session_start visibility only/);
});
test("actual SDK mailbox wait survives 11s in one tool and aborts promptly without extra model rounds",{timeout:30_000},async()=>{
  const output=await runFixture(["--wait-bounds"]);
  assert.match(output,/PASS actual SDK mailbox long-lived wait and bounded abort/);
  assert.match(output,/WAIT_PROOF/);
});
test("actual frozen Graph guard executes both SDK children mailbox tool calls with isolated public faux transport",{timeout:30_000},async()=>{
  const output=await runFixture(["--guarded-roundtrip"]);
  assert.match(output,/PASS actual frozen Graph guard input\/before_agent_start\/tool_call dual SDK P2P/);
});
