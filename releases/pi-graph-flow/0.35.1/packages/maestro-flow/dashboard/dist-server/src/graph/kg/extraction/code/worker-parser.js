import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { getTreeSitterEngine } from './tree-sitter.js';
import { getExtractor } from './languages/index.js';
const PARSE_TIMEOUT_MS = 10_000;
const MAX_PARSE_TIMEOUT_MS = 120_000;
const WORKER_RECYCLE_INTERVAL = 250;
const __dirname = dirname(fileURLToPath(import.meta.url));
export class CodeParseRunner {
    worker = null;
    workerGeneration = 0;
    workerParseCount = 0;
    nextId = 0;
    pending = new Map();
    workerPath = join(__dirname, 'parse-worker.js');
    _usesWorker;
    constructor() {
        this._usesWorker = existsSync(this.workerPath);
    }
    get usesWorker() {
        return this._usesWorker;
    }
    async extract(sourceCode, language, filePath) {
        if (!this.usesWorker) {
            const extractor = getExtractor(language);
            if (!extractor)
                return null;
            const tree = await getTreeSitterEngine().parse(sourceCode, language);
            if (!tree)
                return null;
            try {
                const result = extractor.extract(tree, sourceCode, filePath);
                if (language === 'objc'
                    && /\.mm$/i.test(filePath)
                    && tree.rootNode.hasError === true) {
                    result.diagnostics = [
                        ...(result.diagnostics ?? []),
                        'objcxx-partial-parse: tree-sitter Objective-C grammar reported syntax errors',
                    ];
                }
                return result;
            }
            finally {
                tree.delete();
            }
        }
        if (this.workerParseCount >= WORKER_RECYCLE_INTERVAL) {
            this.recycleWorker('Parse worker reached recycle limit');
        }
        const worker = this.ensureWorker();
        const id = this.nextId++;
        this.workerParseCount++;
        const timeoutMs = Math.min(PARSE_TIMEOUT_MS + Math.floor(sourceCode.length / 100_000) * 10_000, MAX_PARSE_TIMEOUT_MS);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.recycleWorker(`Parse worker recycled after request ${id} timed out`);
                reject(new Error(`Parse timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            worker.postMessage({ type: 'extract', id, sourceCode, language, filePath });
        });
    }
    dispose() {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Parse runner disposed'));
            this.pending.delete(id);
        }
        this.recycleWorker('Parse runner disposed');
    }
    ensureWorker() {
        if (this.worker)
            return this.worker;
        const gen = ++this.workerGeneration;
        this.worker = new Worker(this.workerPath);
        this.worker.on('message', (message) => {
            if (message.type !== 'extract-result')
                return;
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.ok)
                pending.resolve(message.result);
            else
                pending.reject(new Error(message.error));
        });
        this.worker.on('error', err => {
            if (this.workerGeneration !== gen)
                return;
            this.rejectAllPending(`Parse worker error: ${err.message}`);
            this.worker = null;
            this.workerParseCount = 0;
        });
        this.worker.on('exit', code => {
            if (this.workerGeneration !== gen)
                return;
            if (this.pending.size > 0) {
                this.rejectAllPending(`Parse worker exited with code ${code}`);
            }
            this.worker = null;
            this.workerParseCount = 0;
        });
        return this.worker;
    }
    rejectAllPending(reason) {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
            this.pending.delete(id);
        }
    }
    recycleWorker(reason) {
        if (!this.worker)
            return;
        const worker = this.worker;
        this.rejectAllPending(reason);
        this.workerGeneration++;
        this.worker = null;
        this.workerParseCount = 0;
        worker.terminate().catch(() => { });
    }
}
//# sourceMappingURL=worker-parser.js.map