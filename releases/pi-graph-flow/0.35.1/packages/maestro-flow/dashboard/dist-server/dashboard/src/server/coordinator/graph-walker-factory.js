// ---------------------------------------------------------------------------
// GraphWalkerFactory -- cached dynamic imports + create(config) for GraphWalker
// ---------------------------------------------------------------------------
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
// ---------------------------------------------------------------------------
// GraphWalkerFactory
// ---------------------------------------------------------------------------
export class GraphWalkerFactory {
    infraPromise = null;
    /** Cache ALL dynamic imports in a single promise on first access */
    ensureInfra() {
        if (!this.infraPromise) {
            this.infraPromise = Promise.all([
                import('../../../../src/coordinator/graph-walker.js'),
                import('../../../../src/coordinator/graph-loader.js'),
                import('../../../../src/coordinator/expr-evaluator.js'),
                import('../../../../src/coordinator/output-parser.js'),
                import('../../../../src/coordinator/prompt-assembler.js'),
                import('./dashboard-executor.js'),
                import('../../../../src/coordinator/intent-router.js'),
                import('node:os'),
            ]).then(([gw, gl, ee, op, pa, de, ir, os]) => ({
                GraphWalker: gw.GraphWalker,
                GraphLoader: gl.GraphLoader,
                DefaultExprEvaluator: ee.DefaultExprEvaluator,
                DefaultOutputParser: op.DefaultOutputParser,
                DefaultPromptAssembler: pa.DefaultPromptAssembler,
                DashboardExecutor: de.DashboardExecutor,
                IntentRouter: ir.IntentRouter,
                homedir: os.homedir,
            }));
        }
        return this.infraPromise;
    }
    /** Create a fully-wired GraphWalker + IntentRouter + DashboardExecutor */
    async create(config) {
        const infra = await this.ensureInfra();
        const globalChainsRoot = resolve(infra.homedir(), '.maestro', 'chains');
        const localChainsRoot = resolve(config.workDir, 'chains');
        const chainsRoot = existsSync(localChainsRoot) ? localChainsRoot : globalChainsRoot;
        const templateDir = resolve(infra.homedir(), '.maestro', 'templates', 'cli', 'prompts');
        const loader = new infra.GraphLoader(chainsRoot);
        const executor = new infra.DashboardExecutor(config.agentManager, config.eventBus);
        const assembler = new infra.DefaultPromptAssembler(config.workDir, templateDir);
        const evaluator = new infra.DefaultExprEvaluator();
        const parser = new infra.DefaultOutputParser();
        const router = new infra.IntentRouter(loader, chainsRoot);
        const walker = new infra.GraphWalker(loader, assembler, executor, config.analyzer, parser, evaluator, config.emitter, config.sessionDir);
        return { walker, router, executor };
    }
}
//# sourceMappingURL=graph-walker-factory.js.map