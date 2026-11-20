// Candidate source only. Importing this module does not generate, build, or execute the SDK.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parse } from "acorn";
import { isBuiltin } from "node:module";

const spec = JSON.parse(readFileSync(new URL("./PATCH-SPEC.json", import.meta.url), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(`M18 adapter: ${message}`); };
function nodes(root) {
  const output = [];
  function visit(node, parents) {
    if (node === null || typeof node !== "object") return;
    if (typeof node.type === "string") {
      output.push({ node, parents });
      for (const [key, value] of Object.entries(node)) {
        if (key === "start" || key === "end") continue;
        if (Array.isArray(value)) for (const child of value) visit(child, [...parents, node]);
        else if (value !== null && typeof value === "object") visit(value, [...parents, node]);
      }
    }
  }
  visit(root, []);
  return output;
}
function unique(root, predicate, label) {
  const found = nodes(root).filter(({ node, parents }) => predicate(node, parents));
  if (found.length !== 1) fail(`${label}: expected 1 AST anchor, found ${found.length}`);
  return found[0].node;
}
const identifier = (node, name) => node?.type === "Identifier" && node.name === name;
const member = (node, object, property) => node?.type === "MemberExpression" && !node.computed && identifier(node.property, property) &&
  (object === "this" ? node.object.type === "ThisExpression" : identifier(node.object, object));
function method(ast, className, methodName) {
  const klass = unique(ast, (node) => node.type === "ClassDeclaration" && identifier(node.id, className), className);
  return unique(klass.body, (node) => node.type === "MethodDefinition" && !node.computed && identifier(node.key, methodName), `${className}.${methodName}`).value;
}
function functionNamed(ast, name) {
  return unique(ast, (node) => node.type === "FunctionDeclaration" && identifier(node.id, name), name);
}
function objectCall(root, name) {
  const call = unique(root, (node) => node.type === "CallExpression" && identifier(node.callee, name), name);
  if (call.arguments.length !== 1 || call.arguments[0].type !== "ObjectExpression") fail(`${name} argument shape changed`);
  return call.arguments[0];
}
function varStatement(root, name) {
  return unique(root, (node) => node.type === "VariableDeclaration" && node.declarations.some((d) => identifier(d.id, name)), `variable ${name}`);
}
function planEdits(path, source, ast) {
  const edits = [];
  const insert = (offset, text, label) => edits.push({ start: offset, end: offset, old: "", text, label });
  if (path === "dist/main.js") {
    const main = functionNamed(ast, "main");
    if (main.params.length !== 2 || !identifier(main.params[0], "args") || !identifier(main.params[1], "options")) fail("main signature changed");
    insert(main.params[1].end, ", hostOptions", "main-third-private-argument");
    const runtime = unique(main, (node) => node.type === "VariableDeclarator" && identifier(node.id, "createRuntime"), "main createRuntime").init;
    if (runtime.type !== "ArrowFunctionExpression" || runtime.body.type !== "BlockStatement") fail("createRuntime body changed");
    const settings = varStatement(runtime, "runtimeSettingsManager");
    insert(settings.end, "\n        const hostComposition = hostOptions?.prepareRuntime({ cwd, agentDir, sessionManager, settingsManager: runtimeSettingsManager, extensionFactories });\n        try {", "prepare-after-settings-before-services");
    insert(objectCall(runtime, "createAgentSessionServices").start + 1, "\n            resourceLoader: hostComposition?.resourceLoader,", "pre-default-loader");
    const serviceOptions = objectCall(runtime, "createAgentSessionServices");
    const loaderOptions = unique(serviceOptions, node => node.type === "Property" && identifier(node.key, "resourceLoaderOptions"), "main resourceLoaderOptions").value;
    const factories = unique(loaderOptions, node => node.type === "Property" && identifier(node.key, "extensionFactories"), "main native factory composition slot");
    if (!factories.shorthand || !identifier(factories.value, "extensionFactories")) fail("native factory slot changed");
    edits.push({ start: factories.start, end: factories.end, old: source.slice(factories.start, factories.end),
      text: "extensionFactories: hostComposition?.extensionFactories ?? extensionFactories", label: "native-factory-composition" });
    insert(objectCall(runtime, "createAgentSessionFromServices").start + 1, "\n            hostLifecycle: hostComposition?.lifecycle,", "from-services-lifecycle");
    const created = varStatement(runtime, "created");
    insert(created.end, "\n        hostComposition?.lifecycle.capture(created.session);", "capture-created-session");
    insert(runtime.body.end - 1, "\n        } catch (error) {\n            try { hostComposition?.failStartup(error); } catch {}\n            throw error;\n        }\n    ", "preserve-startup-error");
  } else if (path === "dist/core/agent-session-services.js") {
    const services = functionNamed(ast, "createAgentSessionServices");
    const ctor = unique(services, (node) => node.type === "NewExpression" && identifier(node.callee, "DefaultResourceLoader"), "default resource loader");
    insert(ctor.start, "options.resourceLoader ?? ", "optional-explicit-loader-before-construction");
    insert(objectCall(functionNamed(ast, "createAgentSessionFromServices"), "createAgentSession").start + 1,
      "\n        hostLifecycle: options.hostLifecycle,", "forward-lifecycle-to-sdk");
  } else if (path === "dist/core/sdk.js") {
    const ctor = unique(functionNamed(ast, "createAgentSession"), (node) => node.type === "NewExpression" && identifier(node.callee, "AgentSession"), "new AgentSession");
    if (ctor.arguments.length !== 1 || ctor.arguments[0].type !== "ObjectExpression") fail("AgentSession config shape changed");
    insert(ctor.arguments[0].start + 1, "\n        hostLifecycle: options.hostLifecycle,", "sdk-to-session-lifecycle");
  } else if (path === "dist/core/agent-session.js") {
    const klass = unique(ast, (node) => node.type === "ClassDeclaration" && identifier(node.id, "AgentSession"), "AgentSession");
    insert(klass.body.start + 1, '\n    #m18Lifecycle;\n    retireHostSession(reason) {\n        try { this.#m18Lifecycle?.fence(this, reason); } catch {}\n    }\n', "per-instance-private-port-and-formal-retire");
    insert(method(ast, "AgentSession", "constructor").body.start + 1, "\n        this.#m18Lifecycle = config.hostLifecycle;", "store-port");
    insert(method(ast, "AgentSession", "dispose").body.start + 1, '\n        this.retireHostSession("dispose");', "direct-dispose-fence");
    const bind = method(ast, "AgentSession", "bindExtensions");
    insert(bind.body.start + 1, "\n        try {", "bind-failure-open");
    const bindEmit = unique(bind, (node) => node.type === "ExpressionStatement" && node.expression.type === "AwaitExpression" &&
      node.expression.argument.type === "CallExpression" && node.expression.argument.callee.type === "MemberExpression" &&
      member(node.expression.argument.callee.object, "this", "_extensionRunner") && identifier(node.expression.argument.callee.property, "emit"), "bind session_start emit");
    insert(bindEmit.start, "this.#m18Lifecycle?.publish(this, this._extensionRunner);\n        ", "bind-publish-before-original-emit");
    insert(bind.body.end - 1, '\n        } catch (error) { this.retireHostSession("startup-failed"); throw error; }\n    ', "bind-preserve-error");
    const reload = method(ast, "AgentSession", "reload");
    const oldRunner = varStatement(reload, "oldRunner");
    const guards = reload.body.body.filter(node => node.end <= oldRunner.start);
    if (guards.length !== 2 || !guards.every((node, i) => node.type === "IfStatement" && member(node.test, "this", i === 0 ? "isStreaming" : "isCompacting") && node.consequent.type === "BlockStatement" && node.consequent.body.length === 1 && node.consequent.body[0].type === "ThrowStatement")) fail("reload refusal guards changed");
    insert(oldRunner.start, 'this.retireHostSession("reload");\n        try {\n        ', "reload-fence-after-refusal-before-shutdown");
    const reloadEmit = unique(reload, (node) => node.type === "ExpressionStatement" && node.expression.type === "AwaitExpression" &&
      node.expression.argument.type === "CallExpression" && node.expression.argument.callee.type === "MemberExpression" &&
      member(node.expression.argument.callee.object, "this", "_extensionRunner") && identifier(node.expression.argument.callee.property, "emit"), "reload session_start emit");
    insert(reloadEmit.start, "this.#m18Lifecycle?.publish(this, this._extensionRunner);\n            ", "reload-publish-after-beforeSessionStart");
    insert(reload.body.end - 1, '\n        } catch (error) { this.retireHostSession("startup-failed"); throw error; }\n    ', "reload-preserve-error");
  } else if (path === "dist/core/agent-session-runtime.js") {
    insert(method(ast, "AgentSessionRuntime", "teardownCurrent").body.start + 1,
      '\n        this.session.retireHostSession("replace");', "teardown-after-original-cancellation-points");
    const dispose = method(ast, "AgentSessionRuntime", "dispose");
    const abort = dispose.body.body[0];
    if (abort?.type !== "ExpressionStatement" || abort.expression.type !== "AwaitExpression" || abort.expression.argument.type !== "CallExpression" || abort.expression.argument.callee.type !== "MemberExpression" || !member(abort.expression.argument.callee.object, "this", "session") || !identifier(abort.expression.argument.callee.property, "abort")) fail("runtime dispose abort order changed");
    insert(abort.end, '\n        this.session.retireHostSession("dispose");', "runtime-dispose-after-abort-before-shutdown");
  } else if (path === "dist/core/resource-loader.js") {
    for (const name of ["resolveExtensionLoadPath", "getExtensionPathKey", "loadExtensionPaths", "loadExtensionFactories", "loadFinalExtensionSet", "addExtensionConflictDiagnostics", "detectExtensionConflicts"]) {
      method(ast, "DefaultResourceLoader", name);
    }
    insert(source.length, spec.ownedExtensionPolicyAppend, "owned-extension-policy-entry");
  } else if (path === "dist/cli.js") {
    const entry = unique(ast, node => node.type === "ImportDeclaration" && node.source.value === "./main.js", "original CLI main import");
    if (entry.specifiers.length !== 1 || entry.specifiers[0].type !== "ImportSpecifier" ||
        !identifier(entry.specifiers[0].imported, "main") || !identifier(entry.specifiers[0].local, "main")) fail("CLI main import shape changed");
    edits.push({ start: entry.start, end: entry.end, old: source.slice(entry.start, entry.end),
      text: 'import { runOwnedDefaultMain as main } from "m18:owned-default-launcher";', label: "cli-owned-default-main-import" });
  } else fail(`unapproved leaf: ${path}`);
  if (edits.length !== spec.expectedEditCounts[path]) fail(`${path}: expected ${spec.expectedEditCounts[path]} insertions, got ${edits.length}`);
  return edits;
}
export function transformLeaf(path, source) {
  if (typeof source !== "string" || !Object.hasOwn(spec.leaves, path)) fail("unknown input");
  const expected = spec.leaves[path].sha256;
  if (hash(source) !== expected) fail(`${path}: original SHA mismatch`);
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const edits = planEdits(path, source, ast).sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) if (edits[i].start <= edits[i - 1].end) fail("overlapping/ambiguous insertion");
  let output = source;
  for (const edit of [...edits].reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  parse(output, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  let offset = 0;
  const receipt = edits.map((edit) => {
    const result = { ...edit, generatedStart: edit.start + offset };
    offset += edit.text.length - edit.old.length;
    return result;
  });
  const result = { path, sourceSHA256: expected, outputSHA256: hash(output), output, edits: receipt };
  if (reverseLeaf(result) !== source) fail("reverse transform is not byte-exact");
  return result;
}
export function reverseLeaf(result) {
  let output = result.output;
  for (const edit of [...result.edits].reverse()) {
    if (output.slice(edit.generatedStart, edit.generatedStart + edit.text.length) !== edit.text) fail("reverse inserted bytes mismatch");
    output = output.slice(0, edit.generatedStart) + edit.old + output.slice(edit.generatedStart + edit.text.length);
  }
  if (hash(output) !== result.sourceSHA256) fail("reverse SHA mismatch");
  return output;
}

// Compiler metadata, never an external module permission. Fixed compiler provenance is
// additionally bound by the generator's six-file SHA preflight and exact tool loader.
const syntheticRuntimePath = "<runtime>";
const compilerNativeSHA256 = "10b6243df618d374bb2d5c9cfbe7052e1405f6aa4e53a6164f11a91b9f2e1384";
function runtimeSentinelInAST(ast, allowedDataLiterals) {
  function constantString(node) {
    if (node?.type === "Literal" && typeof node.value === "string") return node.value;
    if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
    if (node?.type === "BinaryExpression" && node.operator === "+") {
      const left = constantString(node.left), right = constantString(node.right);
      if (typeof left === "string" && typeof right === "string") return left + right;
    }
    return undefined;
  }
  // Conservatively reject every statically decoded sentinel expression, including
  // import/export/require/dynamic import and unused literals. No source text regex.
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") continue;
    if (constantString(node) === syntheticRuntimePath && allowedDataLiterals?.has(node) !== true) return true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value !== null && typeof value === "object") pending.push(value);
    }
  }
  return false;
}
// Only the original SDK's two runner error-origin labels are output data.
// The accepted nodes are literal property values, never module-load expressions.
function originalRuntimeErrorLabels(ast, source) {
  const allowed = new Set(), labels = [], pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") continue;
    if (node.type === "CallExpression" && !node.optional && node.callee.type === "MemberExpression" && !node.callee.computed && !node.callee.optional &&
        identifier(node.callee.object, "runner") && identifier(node.callee.property, "emitError") && node.arguments.length === 1) {
      const value = node.arguments[0];
      if (value.type === "ObjectExpression" && value.properties.length === 3 && value.properties.every(p => p.type === "Property" && p.kind === "init" && !p.computed && !p.method && !p.shorthand)) {
        const [origin, event, error] = value.properties;
        const errorValue = error.value;
        if (identifier(origin.key, "extensionPath") && origin.value.type === "Literal" && origin.value.value === syntheticRuntimePath &&
            identifier(event.key, "event") && event.value.type === "Literal" && ["send_message", "send_user_message"].includes(event.value.value) &&
            identifier(error.key, "error") && errorValue.type === "ConditionalExpression" && errorValue.test.type === "BinaryExpression" && errorValue.test.operator === "instanceof" &&
            errorValue.test.left.type === "Identifier" && identifier(errorValue.test.right, "Error") &&
            member(errorValue.consequent, errorValue.test.left.name, "message") && errorValue.alternate.type === "CallExpression" && identifier(errorValue.alternate.callee, "String") &&
            errorValue.alternate.arguments.length === 1 && identifier(errorValue.alternate.arguments[0], errorValue.test.left.name)) {
          allowed.add(origin.value);
          labels.push({ event: event.value.value, literalStart: origin.value.start, literalEnd: origin.value.end,
            callStart: node.start, callEnd: node.end, line: source.slice(0, origin.value.start).split("\n").length,
            originalThreeKeys: ["extensionPath", "event", "error"], receiver: "runner.emitError" });
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value !== null && typeof value === "object") pending.push(value);
    }
  }
  return { allowed, labels };
}
function requireOriginalLabelPair(labels, name) {
  if (labels.length !== 2 || labels.filter(row => row.event === "send_message").length !== 1 || labels.filter(row => row.event === "send_user_message").length !== 1) fail(`${name}: expected the two original error-origin labels`);
}
function fixedCompilerEvidence(build) {
  const path = process.env.ESBUILD_BINARY_PATH;
  if (build.esbuild.version !== "0.28.2" || typeof path !== "string" || realpathSync(path) !== path || hash(readFileSync(path)) !== compilerNativeSHA256) fail("synthetic runtime requires fixed esbuild0.28.2/native identity");
  return { version: build.esbuild.version, nativePath: path, nativeSHA256: compilerNativeSHA256 };
}

/** Canonicalize *every* build resolution, including reverse imports from virtual-modules/index. */
export function createHostAdapterPlugin({ packageRoot, approvedFiles, resolvePackage, onReceipt, assetLoaders = new Map() }) {
  const root = realpathSync(packageRoot);
  const canonicalLeaf = new Map(Object.keys(spec.leaves).map((leaf) => [realpathSync(resolve(root, leaf)), leaf]));
  const approved = new Map(approvedFiles.map((row) => [realpathSync(row.path), row.sha256]));
  for (const [file, expected] of Object.entries(spec.embeddedBranchSources)) {
    const path = realpathSync(resolve(root, file));
    if (hash(readFileSync(path)) !== expected || approved.get(path) !== expected) fail(`official embedded branch changed: ${file}`);
  }
  for (const [name, entry] of Object.entries(spec.internalEntries)) {
    const path = realpathSync(resolve(root, entry.module));
    if (hash(readFileSync(path)) !== entry.sha256 || approved.get(path) !== entry.sha256) fail(`version-bound internal entry changed: ${name}`);
  }
  const ownedEntryPaths = new Map();
  if (Object.keys(spec.ownedEntries).length !== 1 || !Object.hasOwn(spec.ownedEntries, "m18:owned-default-launcher")) fail("owned launcher entry set changed");
  for (const [name, entry] of Object.entries(spec.ownedEntries)) {
    if (entry.source !== "./owned-default-launcher.ts") fail("owned launcher source path changed");
    const path = realpathSync(new URL(entry.source, import.meta.url));
    if (hash(readFileSync(path)) !== entry.sha256 || approved.get(path) !== entry.sha256) fail(`owned entry source changed: ${name}`);
    ownedEntryPaths.set(name, path);
  }
  const metadataPath = realpathSync(resolve(root, "package.json"));
  if (hash(readFileSync(metadataPath)) !== spec.sdkMetadata.sha256 || approved.get(metadataPath) !== spec.sdkMetadata.sha256) fail("canonical SDK metadata changed");
  // Version-bound exceptions: original full bodies include the reviewed try/catch.
  const optionalRequires = JSON.parse(readFileSync(new URL("./OPTIONAL-REQUIRES.json", import.meta.url), "utf8"));
  if (optionalRequires.length !== 3) fail("expected exactly three reviewed optional requires");
  for (const row of optionalRequires) {
    if (realpathSync(row.importer) !== row.importer || approved.get(row.importer) !== row.sha256 || hash(readFileSync(row.importer)) !== row.sha256) fail("optional importer identity changed");
    const ast = parse(readFileSync(row.importer, "utf8"), { ecmaVersion: "latest", sourceType: "script", locations: true });
    const calls = nodes(ast).filter(({ node }) => node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require" && node.arguments.length === 1 && node.arguments[0].value === row.specifier);
    if (calls.length !== 1 || calls[0].node.loc.start.line !== row.line || !nodes(ast).some(({ node }) => node.type === "TryStatement" && node.handler !== null && node.block.start < calls[0].node.start && node.block.end > calls[0].node.end)) fail("optional require must remain the unique original caught call");
  }
  const deferredOptionalRequires = [];
  const reverseEdges = [];
  const submittedJS = new Map();
  let originalErrorLabelProof;
  const runtimeResolveRequests = [];
  const loaded = new Set();
  const classDefinitions = new Map([["AgentSession", new Set()], ["AgentSessionRuntime", new Set()]]);
  const marker = Symbol("M18 resolver recursion marker");
  return {
    name: "m18-version-bound-host-adapter",
    setup(build) {
      onReceipt({ kind: "fixed-node-builtin-membership", nodeVersion: process.version, checks: Object.fromEntries(["node:sqlite", "sqlite", "node:crypto", "supports-color", "bufferutil", "utf-8-validate"].map(name => [name, isBuiltin(name)])) });
      const opts = build.initialOptions;
      const compilerEvidence = fixedCompilerEvidence(build);
      if (opts.bundle !== true || opts.platform !== "node" || opts.format !== "esm" || opts.metafile !== true || opts.define?.PI_BUNDLED_NODE !== "true") {
        fail("requires actual bundled Node/ESM/metafile/PI_BUNDLED_NODE=true; no unbundled disguise");
      }
      if (opts.write !== false) fail("synthetic audit requires untouched in-memory outputFiles");
      if (opts.packages === "external") fail("SDK/virtual module graph cannot be externalized");
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.path === syntheticRuntimePath) {
          runtimeResolveRequests.push({ importer: args.importer, kind: args.kind, path: args.path });
          fail("source resolver requested synthetic runtime sentinel");
        }
        if (args.pluginData === marker) return;
        if (isBuiltin(args.path) || (args.kind === "entry-point" && args.path === "")) return;
        let requested = args.path;
        const hostEntries = {
          "m18:hosted-main": "dist/main.js",
          "m18:hosted-sdk": "dist/core/sdk.js",
          "m18:hosted-services": "dist/core/agent-session-services.js",
          "m18:hosted-session": "dist/core/agent-session.js",
          "m18:hosted-runtime": "dist/core/agent-session-runtime.js",
        };
        for (const [name, entry] of Object.entries(spec.internalEntries)) hostEntries[name] = entry.module;
        if (Object.hasOwn(hostEntries, requested)) requested = resolve(root, hostEntries[requested]);
        else if (ownedEntryPaths.has(requested)) requested = ownedEntryPaths.get(requested);
        // Explicit caller-owned dependency map: no implicit Root node_modules / SDK 1.0.4 fallback.
        const sdkRootImport = requested === "@earendil-works/pi-coding-agent" || requested === "@mariozechner/pi-coding-agent";
        if (sdkRootImport) requested = resolve(root, "dist/index.js");
        const packagePath = sdkRootImport ? undefined : resolvePackage(requested, args.importer);
        if (packagePath !== undefined) requested = packagePath;
        const found = await build.resolve(requested, { resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: marker });
        if (found.errors.length > 0) {
          const exception = optionalRequires.find(row => row.importer === args.importer && row.specifier === args.path && row.kind === args.kind);
          if (exception && hash(readFileSync(exception.importer)) === exception.sha256) {
            const receipt = { kind: "native-optional-resolution-deferred", ...exception, originalResolutionErrors: found.errors };
            deferredOptionalRequires.push(receipt); onReceipt(receipt);
            return; // No external flag: original esbuild resolver handles its original caught require.
          }
          return { errors: found.errors };
        }
        if (found.external) {
          if (isBuiltin(requested)) return found;
          fail(`unapproved external module bypass: ${requested}`);
        }
        if (found.namespace !== "file" && found.namespace !== "") fail(`unsupported virtual namespace: ${found.namespace}`);
        const canonical = realpathSync(found.path);
        if (!approved.has(canonical)) fail(`resolved file outside exact approved body manifest: ${canonical}`);
        reverseEdges.push({ importer: args.importer, specifier: args.path, canonical });
        return { path: canonical, namespace: "file", suffix: found.suffix };
      });
      build.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
        const path = realpathSync(args.path);
        const bytes = readFileSync(path);
        const bodySHA = hash(bytes);
        if (bodySHA !== approved.get(path)) fail(`manifest SHA mismatch: ${path}`);
        loaded.add(path);
        const leaf = canonicalLeaf.get(path);
        for (const [name, entry] of Object.entries(spec.leaves)) {
          if (bodySHA === entry.sha256 && leaf !== name) fail(`second physical copy of SDK leaf: ${path}`);
        }
        const extension = extname(path);
        if ([".js", ".mjs", ".cjs"].includes(extension)) {
          const source = bytes.toString("utf8");
          let ast;
          try { ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }); }
          catch { ast = parse(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true, allowReturnOutsideFunction: true }); }
          for (const { node } of nodes(ast)) {
            if (node.type === "ClassDeclaration" && classDefinitions.has(node.id?.name)) classDefinitions.get(node.id.name).add(path);
          }
          if (leaf === "dist/core/agent-session.js") {
            const sourceLabels = originalRuntimeErrorLabels(ast, source);
            requireOriginalLabelPair(sourceLabels.labels, "original SDK");
            originalErrorLabelProof = { path, sourceSHA256: bodySHA, labels: sourceLabels.labels };
          }
          const sourceHasSentinel = runtimeSentinelInAST(ast);
          submittedJS.set(path, { sourceSHA256: bodySHA, submittedSHA256: bodySHA, sourceHasSentinel, submittedHasSentinel: sourceHasSentinel });
          if (leaf !== undefined) {
            const result = transformLeaf(leaf, source);
            submittedJS.set(path, { sourceSHA256: bodySHA, submittedSHA256: result.outputSHA256, sourceHasSentinel,
              submittedHasSentinel: runtimeSentinelInAST(parse(result.output, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true })) });
            onReceipt(result);
            return { contents: result.output, loader: "js", resolveDir: dirname(path) };
          }
          return { contents: source, loader: "js", resolveDir: dirname(path) };
        }
        const standardLoaders = { ".ts": "ts", ".tsx": "tsx", ".jsx": "jsx", ".json": "json" };
        const loader = standardLoaders[extension] ?? assetLoaders.get(path);
        if (loader === undefined) fail(`asset requires explicit loader and packaging contract: ${path}`);
        return { contents: bytes, loader, resolveDir: dirname(path) };
      });
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        if (result.metafile === undefined) fail("missing full metafile");
        for (const [path] of canonicalLeaf) if (!loaded.has(path)) fail(`version-bound leaf graph incomplete: ${path}`);
        for (const [name, path] of ownedEntryPaths) if (!loaded.has(path)) fail(`owned entry graph incomplete: ${name}`);
        const required = ["dist/core/extensions/virtual-modules.js", "dist/core/extensions/jiti-static-loader.js", "dist/index.js"];
        for (const file of required) if (!loaded.has(realpathSync(resolve(root, file)))) fail(`official embedded graph missing: ${file}`);
        for (const [name, definitions] of classDefinitions) {
          if (definitions.size !== 1) fail(`${name}: expected one canonical class definition, found ${definitions.size}`);
        }
        const identities = new Map();
        for (const input of Object.keys(result.metafile.inputs)) {
          const canonical = realpathSync(resolve(opts.absWorkingDir ?? process.cwd(), input));
          const prior = identities.get(canonical);
          if (prior !== undefined && prior !== input) fail(`dual canonical input identity: ${prior} / ${input}`);
          identities.set(canonical, input);
        }
        const syntheticEdges = [];
        const optionalExternalEdges = [];
        for (const [input, info] of Object.entries(result.metafile.inputs)) {
          const importer = realpathSync(resolve(opts.absWorkingDir ?? process.cwd(), input));
          for (const edge of info.imports) if (edge.path === syntheticRuntimePath || (edge.external && !isBuiltin(edge.path))) {
            if (edge.path === syntheticRuntimePath) {
              const keys = Object.keys(edge).sort();
              if (keys.join(",") !== "external,kind,path" || edge.external !== true || edge.kind !== "import-statement") fail("synthetic runtime edge shape changed");
              const proof = submittedJS.get(importer);
              if (!loaded.has(importer) || proof === undefined || proof.sourceSHA256 !== approved.get(importer) || proof.sourceHasSentinel || proof.submittedHasSentinel || runtimeResolveRequests.length !== 0) fail("synthetic runtime lacks source/resolver proof");
              syntheticEdges.push({ category: "compilerSyntheticRuntime", importer, edge: { ...edge }, ...proof });
              continue; // Input metadata only. Never added to output/external permission.
            }
            if (!deferredOptionalRequires.some(row => row.importer === importer && row.specifier === edge.path && row.kind === edge.kind)) fail(`unapproved input external: ${input} -> ${edge.path}`);
            optionalExternalEdges.push({ importer, ...edge });
          }
        }
        for (const info of Object.values(result.metafile.outputs)) for (const edge of info.imports) if (edge.path === syntheticRuntimePath) fail("synthetic runtime escaped to output import");
        if (!Array.isArray(result.outputFiles) || result.outputFiles.length === 0) fail("synthetic audit missing original output bytes");
        const outputProofs = [];
        for (const output of result.outputFiles) {
          if (![".js", ".mjs", ".cjs"].includes(extname(output.path))) fail("synthetic audit requires JavaScript outputs");
          const ast = parse(output.text, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
          const dataLabels = originalRuntimeErrorLabels(ast, output.text);
          if (runtimeSentinelInAST(ast, dataLabels.allowed)) fail("synthetic runtime sentinel remains in output AST");
          requireOriginalLabelPair(dataLabels.labels, output.path);
          if (originalErrorLabelProof === undefined || originalErrorLabelProof.sourceSHA256 !== spec.leaves["dist/core/agent-session.js"].sha256) fail("missing original SDK error-label source proof");
          outputProofs.push({ path: output.path, sha256: hash(output.contents), bytes: output.contents.length,
            unapprovedSentinelInAST: false, benignErrorLabels: dataLabels.labels.map(label => ({ ...label,
              source: { path: originalErrorLabelProof.path, sha256: originalErrorLabelProof.sourceSHA256,
                ...originalErrorLabelProof.labels.find(original => original.event === label.event) } })) });
        }
        onReceipt({ kind: "compiler-synthetic-runtime-audit", compiler: compilerEvidence, edges: syntheticEdges, resolverRuntimeRequests: runtimeResolveRequests, outputs: outputProofs, runtimeResolutionVerified: false });
        for (const info of Object.values(result.metafile.outputs)) for (const edge of info.imports) if (edge.external && !isBuiltin(edge.path) && !optionalExternalEdges.some(row => row.path === edge.path && row.kind === edge.kind)) fail(`unapproved output external: ${edge.path}`);
        onReceipt({ kind: "optional-external-audit", edges: optionalExternalEdges, runtimeResolutionVerified: false });
        // Export this graph as evidence, never as proof of runtime jiti identity.
        onReceipt({ kind: "canonical-static-graph", reverseEdges, inputs: [...identities.keys()], runtimeIdentityVerified: false });
      });
    },
  };
}
