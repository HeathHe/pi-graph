import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { BrowserManager } = await jiti.import('../src/tools/browser/manager.ts');
const { browserRunFailureDiagnostics } = await jiti.import('../src/tools/browser/run-diagnostics.ts');
const { browserBridge } = await jiti.import('../src/tools/browser/bridge-server.ts');
test.after(async () => { await browserBridge.shutdown(); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(work) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-browser-deadline-'));
  const manager = new BrowserManager();
  try {
    await manager.open({ name: 'test', cwd, channel: 'managed', url: 'data:text/html,<title>Deadline</title>', timeoutMs: 15000 });
    // browser.pages returns raw Pages, unlike the per-run page adapter.
    const page = (await manager.run('test', "return (await browser.pages()).find(p => p.url().startsWith('data:'));", cwd, undefined, 3000)).returnValue;
    await work({ manager, cwd, page });
  } finally {
    await manager.closeAll();
    await rm(cwd, { recursive: true, force: true });
  }
}

async function failureOf(promise) {
  try { await promise; assert.fail('expected failure'); }
  catch (error) { assert.ok(error instanceof Error); return error; }
}

test('managed timeout preserves pre-error output, screenshot metadata and the pending exposed operation without renderer probes', async () => {
  await fixture(async ({ manager, cwd, page }) => {
    const evaluate = page.evaluate.bind(page);
    let evaluations = 0;
    page.evaluate = (...args) => { evaluations++; return evaluate(...args); };
    const error = await failureOf(manager.run('test', `
      print('submitted once'); console.warn('waiting for terminal state');
      await tab.screenshot({silent:true});
      await page.evaluate(() => new Promise(() => {}));
    `, cwd, undefined, 1000));
    assert.match(error.message, /timed out after 1000ms/);
    assert.match(error.message, /reopen/i);
    const diagnostics = browserRunFailureDiagnostics(error);
    assert.equal(diagnostics.phase, 'execution');
    assert.equal(diagnostics.budgetMs, 1000);
    assert.ok(diagnostics.elapsedMs >= 900 && diagnostics.elapsedMs < 1800);
    assert.match(diagnostics.partialText, /submitted once\nwaiting for terminal state/);
    assert.deepEqual(diagnostics.activeOperations, ['page.evaluate']);
    assert.equal(diagnostics.lastOperation, 'page.evaluate');
    assert.equal(diagnostics.screenshots.length, 1);
    assert.equal(diagnostics.screenshots[0].mimeType, 'image/png');
    assert.ok(diagnostics.screenshots[0].bytes > 0);
    assert.ok(!JSON.stringify(diagnostics).includes('base64'));
    assert.equal(evaluations, 1, 'failure diagnostics must not evaluate a stalled renderer');
    assert.deepEqual((await manager.status()).namedTabs, []);
  });
});

test('unhandled confirm diagnostics are passive and open-scoped dialog handling remains unchanged', async () => {
  await fixture(async ({ manager, cwd, page }) => {
    await manager.open({ name: 'test', cwd, channel: 'managed', dialogs: 'dismiss', timeoutMs: 3000 });
    const normal = await manager.run('test', "return await page.evaluate(() => confirm('configured dismissal'));", cwd, undefined, 2000);
    assert.equal(normal.returnValue, false);
    await manager.open({ name: 'test', cwd, channel: 'managed', timeoutMs: 3000 });
    page.on('dialog', () => {}); // Deliberately leave a dialog unresolved.
    const error = await failureOf(manager.run('test', "print('before confirm'); await page.evaluate(() => confirm('SECRET_DIALOG_MESSAGE'));", cwd, undefined, 500));
    const diagnostics = browserRunFailureDiagnostics(error);
    assert.equal(diagnostics.unresolvedDialog.type, 'confirm');
    assert.match(diagnostics.unresolvedDialog.hint, /dialogs on open/);
    assert.match(diagnostics.partialText, /before confirm/);
    assert.deepEqual(diagnostics.activeOperations, ['page.evaluate']);
    assert.ok(!JSON.stringify(diagnostics).includes('SECRET_DIALOG_MESSAGE'));
  });
});

test('managed setup and tab helpers spend the same allowance', async () => {
  await fixture(async ({ manager, cwd, page }) => {
    const interception = page.setRequestInterception.bind(page);
    let first = true;
    page.setRequestInterception = async (...args) => {
      if (first) { first = false; await sleep(120); }
      return interception(...args);
    };
    let helperTimeout;
    page.goto = async (_url, options) => { helperTimeout = options.timeout; return null; };
    await manager.run('test', "await wait(80); await tab.goto('https://example.invalid');", cwd, undefined, 350);
    assert.ok(helperTimeout > 0 && helperTimeout <= 170, `remaining helper allowance was ${helperTimeout}`);
    first = true;
    const started = performance.now();
    const error = await failureOf(manager.run('test', "await wait(300);", cwd, undefined, 200));
    assert.ok(performance.now() - started < 1000, 'setup must not grant execution a fresh full budget');
    assert.equal(browserRunFailureDiagnostics(error).budgetMs, 200);
  });
});

test('setup hangs time out before code starts; late setup cannot begin execution', async () => {
  await fixture(async ({ manager, cwd, page }) => {
    let release;
    page.setRequestInterception = () => new Promise((resolve) => { release = resolve; });
    const error = await failureOf(manager.run('test', "print('must never execute');", cwd, undefined, 150));
    const diagnostics = browserRunFailureDiagnostics(error);
    assert.equal(diagnostics.phase, 'setup');
    assert.equal(diagnostics.partialText, '');
    release();
    await sleep(50);
    assert.equal(diagnostics.partialText, '');
  });
});

test('postprocessing is inside the execution deadline, not a per-target fresh allowance', async () => {
  await fixture(async ({ manager, cwd, page }) => {
    const browser = page.browser();
    const target = { type: () => 'page', url: () => 'https://example.invalid/new', page: () => new Promise(() => {}) };
    globalThis.__piDeadlineTarget = target;
    try {
      const error = await failureOf(manager.run('test', "browser.emit('targetcreated', globalThis.__piDeadlineTarget); return 'done';", cwd, undefined, 150));
      assert.equal(browserRunFailureDiagnostics(error).phase, 'postprocessing');
    } finally { delete globalThis.__piDeadlineTarget; }
  });
});

test('hanging CDP detach is bounded without claiming pending work stopped; owned browser still closes', async () => {
  await fixture(async ({ manager, cwd, page }) => {
    const session = await page.target().createCDPSession();
    // Intercept sessions' detach through the common prototype, keeping the actual
    // transport browser.close path untouched.
    const prototype = Object.getPrototypeOf(session);
    const detach = prototype.detach;
    const browser = page.browser();
    const close = browser.close.bind(browser);
    let closeStarted;
    browser.close = () => { closeStarted = performance.now(); return close(); };
    prototype.detach = () => new Promise(() => {});
    const started = performance.now();
    try {
      const error = await failureOf(manager.run('test', "await page.evaluate(() => new Promise(() => {}));", cwd, undefined, 150));
      const diagnostics = browserRunFailureDiagnostics(error);
      assert.ok(closeStarted - started < 3500, 'detach must not delay owned-browser shutdown indefinitely');
      assert.ok(diagnostics.cleanupDurationMs >= 1900);
      assert.ok(diagnostics.cleanupIssues.includes('cdp-detach-pending'));
      assert.equal(browser.connected, false);
    } finally { prototype.detach = detach; }
  });
});

test('hanging interception cleanup is bounded, reported and preserves the original failure', async () => {
  await fixture(async ({ manager, cwd, page }) => {
    const interception = page.setRequestInterception.bind(page);
    let calls = 0;
    page.setRequestInterception = (...args) => ++calls === 1 ? interception(...args) : new Promise(() => {});
    const sentinel = new Error('original run failure');
    globalThis.__piDeadlineError = sentinel;
    const browser = page.browser();
    const close = browser.close.bind(browser);
    let closeStarted;
    browser.close = () => { closeStarted = performance.now(); return close(); };
    const started = performance.now();
    try {
      const error = await failureOf(manager.run('test', "print('before error'); throw globalThis.__piDeadlineError;", cwd, undefined, 2000));
      assert.equal(error, sentinel);
      const diagnostics = browserRunFailureDiagnostics(error);
      assert.ok(closeStarted - started < 3500, 'interception cleanup must yield to owned-browser shutdown');
      assert.ok(diagnostics.cleanupDurationMs >= 1900);
      assert.ok(diagnostics.cleanupIssues.includes('request-interception-cleanup-failed-or-pending'));
      assert.match(diagnostics.partialText, /before error/);
    } finally { delete globalThis.__piDeadlineError; }
  });
});

test('borrowed CDP timeout reports continued execution without closing the user page or browser', async () => {
  await fixture(async ({ cwd, page }) => {
    const borrowed = new BrowserManager();
    const browser = page.browser();
    try {
      await borrowed.open({ name: 'borrowed', cwd, channel: 'cdp', cdpUrl: browser.wsEndpoint(), target: page.url(), timeoutMs: 15000 });
      const error = await failureOf(borrowed.run('borrowed', `
        await page.evaluate(() => new Promise(resolve => setTimeout(() => {
          globalThis.__borrowedLateEffect = 1; resolve();
        }, 300)));
      `, cwd, undefined, 150));
      assert.ok(browserRunFailureDiagnostics(error).cleanupIssues.includes('borrowed-page-execution-may-continue'));
      assert.match(error.message, /borrowed profile\/CDP pages.*may continue executing/i);
      assert.equal(browser.connected, true);
      assert.equal(page.isClosed(), false);
      await page.waitForFunction(() => globalThis.__borrowedLateEffect === 1, { timeout: 2000 });
      assert.equal(await page.evaluate(() => globalThis.__borrowedLateEffect), 1);
      assert.deepEqual((await borrowed.status()).namedTabs, []);
    } finally { await borrowed.closeAll(); }
  });
});

test('download SOP browser-target CDP progress observes completion and verifies the file', async () => {
  await fixture(async ({ manager, cwd }) => {
    const destination = join(cwd, 'downloads');
    const result = await manager.run('test', `
      const fs = await import('node:fs/promises');
      const downloadPath = ${JSON.stringify(destination)};
      await fs.mkdir(downloadPath, { recursive:true });
      const downloadCdp = await browser.target().createCDPSession();
      let timer, guid, resolveDone, rejectDone;
      const completed = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      const onBegin = event => { if (event.suggestedFilename === 'timeout-sop.txt') guid = event.guid; };
      const onProgress = event => {
        if (event.guid !== guid) return;
        if (event.state === 'completed') resolveDone();
        else if (event.state === 'canceled') rejectDone(new Error('Download canceled'));
      };
      try {
        await downloadCdp.send('Browser.setDownloadBehavior', {behavior:'allow', downloadPath, eventsEnabled:true});
        downloadCdp.on('Browser.downloadWillBegin', onBegin);
        downloadCdp.on('Browser.downloadProgress', onProgress);
        timer = setTimeout(() => rejectDone(new Error('Download progress timed out')), 5000);
        await Promise.all([page.evaluate(() => {
          const link = document.createElement('a');
          link.href = URL.createObjectURL(new Blob(['browser SOP download evidence'], {type:'text/plain'}));
          link.download = 'timeout-sop.txt'; document.body.append(link); link.click();
        }), completed]);
        return { completed:true, guid };
      } finally {
        clearTimeout(timer);
        downloadCdp.off('Browser.downloadWillBegin', onBegin);
        downloadCdp.off('Browser.downloadProgress', onProgress);
        await downloadCdp.detach();
      }
    `, cwd, undefined, 8000);
    assert.equal(result.returnValue.completed, true);
    assert.equal(typeof result.returnValue.guid, 'string');
    assert.equal(await readFile(join(destination, 'timeout-sop.txt'), 'utf8'), 'browser SOP download evidence');
  });
});

test('overflow preserves its original error and pre-limit artifact semantics', async () => {
  await fixture(async ({ manager, cwd }) => {
    const error = await failureOf(manager.run('test', "print('overflow evidence'.repeat(100));", cwd, undefined, 2000, 32));
    assert.match(error.message, /Browser output exceeds 32 UTF-8 bytes/);
    const artifact = error.message.match(/Captured output \(pre-limit\): (.+)$/)?.[1];
    assert.ok(artifact);
    try { assert.match(await readFile(artifact, 'utf8'), /overflow evidence/); }
    finally { await rm(artifact, { force: true }); }
    assert.match(browserRunFailureDiagnostics(error).partialText, /overflow evidence/);
  });
});
