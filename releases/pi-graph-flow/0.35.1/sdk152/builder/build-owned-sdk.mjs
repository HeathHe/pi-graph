import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isBuiltin} from 'node:module';
import {pathToFileURL} from 'node:url';
import {deriveRpcLeaf, linkCliOrRpcLeaf, rpcOriginalSHA256, hostPortSpecifiers,
  sdkPortsSource, cliWrapperSource, rpcWrapperSource} from './owned-sdk-linker.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const sdkMetadataSHA256 = '18b422b7d80f2caa2551d253c0a8409e1caa54b954bfb7d18252e507bb8a0318';
export const runtimeExternals = Object.freeze([
  'typebox', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-mcp', '@modelcontextprotocol/sdk/types.js',
  '@modelcontextprotocol/ext-apps/app-bridge', 'zod',
]);
function checked(row) {
  assert.ok(row && /^[a-f0-9]{64}$/.test(row.sha256), 'Missing full input SHA');
  const b = fs.readFileSync(row.path);
  assert.equal(sha(b), row.sha256, `Input changed: ${row.path}`);
  return b;
}
function files(root) {
  const result = [];
  function walk(p) {
    const st = fs.lstatSync(p), relative = path.relative(root, p);
    if (st.isSymbolicLink()) { result.push({relative, kind: 'link', raw: fs.readlinkSync(p), canonical: fs.realpathSync(p)}); return; }
    if (st.isDirectory()) { result.push({relative, kind: 'directory', mode: st.mode}); for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n)); return; }
    assert.ok(st.isFile(), `Unsupported SDK input: ${p}`);
    result.push({relative, kind: 'file', sha256: sha(fs.readFileSync(p)), bytes: st.size, mode: st.mode, inode: st.ino});
  }
  walk(root); return result;
}
function atomicNewFile(target, bytes, mode = 0o644) {
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const temp = target + '.owned-new';
  fs.writeFileSync(temp, bytes, {flag: 'wx', mode});
  fs.renameSync(temp, target);
}
function exportTarget(value, subpath) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) { for (const v of value) { const hit = exportTarget(v, subpath); if (hit) return hit; } return; }
  if (!value || typeof value !== 'object') return;
  if (Object.keys(value).some(k => k.startsWith('.'))) {
    if (Object.hasOwn(value, subpath)) return exportTarget(value[subpath], subpath);
    for (const [key, v] of Object.entries(value)) {
      if (!key.includes('*')) continue;
      const [a, b] = key.split('*');
      if (subpath.startsWith(a) && subpath.endsWith(b)) {
        const hit = exportTarget(v, subpath);
        if (hit) return hit.replaceAll('*', subpath.slice(a.length, b ? -b.length : undefined));
      }
    }
    return;
  }
  for (const [condition, v] of Object.entries(value)) {
    if (['node', 'import', 'default'].includes(condition)) { const hit = exportTarget(v, subpath); if (hit) return hit; }
  }
}

/** Internal release API. It never installs packages, searches HOME, or runs the SDK.
 * Inputs are explicit pinned roots from the release dependency/source inventory.
 * outputRoot must not exist. The completed package is outputRoot/sdk; build receipts
 * live beside it. Canonical dependency aliases are not a portable tar claim.
 */
export async function buildOwnedSdk(input) {
  assert.equal(process.versions.node.split('.')[0], '24');
  const sdkRoot = fs.realpathSync(input.sdkRoot), flowRoot = fs.realpathSync(input.flowRoot);
  const out = path.resolve(input.outputRoot), packageRoot = path.join(out, 'sdk'), control = path.join(out, 'build-control');
  assert.equal(path.join(fs.realpathSync(path.dirname(out)), path.basename(out)), out, 'Output parent must be canonical');
  assert.ok(!inside(sdkRoot, out) && !inside(out, sdkRoot) && !inside(flowRoot, out) && !inside(out, flowRoot));
  assert.ok(!fs.existsSync(out), 'Output already exists; no replay or in-place build');
  assert.ok(!fs.existsSync(path.join(sdkRoot, 'src')), 'Published SDK must use dist asset paths');
  const metadata = fs.readFileSync(path.join(sdkRoot, 'package.json'));
  assert.equal(sha(metadata), sdkMetadataSHA256);
  const pkg = JSON.parse(metadata);
  assert.equal(pkg.name, '@earendil-works/pi-coding-agent'); assert.equal(pkg.version, '1.5.2');
  const before = files(sdkRoot);
  assert.equal(sha(Buffer.from(JSON.stringify(before.map(({inode, ...row}) => row)))), input.sdkInventorySHA256, 'SDK inventory drift');
  const sourcePins = new Map(input.sourcePins.map(row => [fs.realpathSync(row.path), row]));
  for (const row of sourcePins.values()) { assert.ok(inside(flowRoot, row.path)); checked(row); }
  const builderPath = path.join(flowRoot, 'src/host/build-host-adapter.mjs');
  const specPath = path.join(flowRoot, 'src/host/PATCH-SPEC.json');
  const builder = checked(sourcePins.get(builderPath)), specBytes = checked(sourcePins.get(specPath));
  const spec = JSON.parse(specBytes); assert.equal(Object.keys(spec.leaves).length, 7);
  assert.equal(Object.values(spec.expectedEditCounts).reduce((n, v) => n + v, 0), 23);
  const tools = input.tools;
  for (const name of ['esbuildEntry', 'esbuildPackage', 'nativeCompiler', 'nativePackage', 'acorn', 'acornPackage']) checked(tools[name]);
  assert.equal(JSON.parse(checked(tools.esbuildPackage)).version, '0.28.2');
  assert.equal(process.env.ESBUILD_BINARY_PATH, tools.nativeCompiler.path);
  assert.equal(process.env.ESBUILD_WORKER_THREADS, '0');
  const dependencies = new Map();
  for (const row of input.dependencyBindings) {
    assert.ok(/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(row.name));
    assert.notEqual(row.name, pkg.name, 'SDK self-reference cannot bind a second SDK');
    assert.ok(!dependencies.has(row.name), `Duplicate dependency ${row.name}`);
    const canonicalRoot = fs.realpathSync(row.canonicalRoot);
    assert.equal(canonicalRoot, row.canonicalRoot);
    const body = checked({path: path.join(canonicalRoot, 'package.json'), sha256: row.metadataSHA256});
    assert.equal(JSON.parse(body).name, row.name);
    dependencies.set(row.name, {...row, canonicalRoot});
  }
  const resolutions = [];
  for (const name of runtimeExternals) {
    if (name === pkg.name) continue; // The final package self-reference uses its own unchanged exports.
    const parts = name.split('/'), packageName = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const dep = dependencies.get(packageName); assert.ok(dep, `Missing explicit external ${name}`);
    const p = json(path.join(dep.canonicalRoot, 'package.json')), subpath = '.' + name.slice(packageName.length);
    const target = p.exports === undefined ? (subpath === '.' ? p.main ?? 'index.js' : subpath) : exportTarget(p.exports, subpath);
    assert.equal(typeof target, 'string', `No import/node/default export ${name}`);
    const entry = fs.realpathSync(path.resolve(dep.canonicalRoot, target));
    assert.ok(inside(dep.canonicalRoot, entry));
    const expected = input.externalEntryPins.find(row => row.specifier === name);
    assert.ok(expected && expected.path === entry); checked(expected);
    resolutions.push({specifier: name, package: packageName, canonicalRoot: dep.canonicalRoot, entry, sha256: expected.sha256});
  }
  fs.mkdirSync(out, {mode: 0o700}); fs.mkdirSync(packageRoot); fs.mkdirSync(control);
  const copied = [], aliases = [];
  for (const row of before) {
    const src = path.join(sdkRoot, row.relative), dest = path.join(packageRoot, row.relative);
    if (row.kind === 'directory') { fs.mkdirSync(dest, {recursive: true}); continue; }
    if (row.kind === 'file') {
      const b = fs.readFileSync(src); assert.equal(sha(b), row.sha256);
      atomicNewFile(dest, b, row.mode & 0o777); assert.notEqual(fs.statSync(dest).ino, row.inode);
      copied.push({relative: row.relative, sha256: row.sha256, sourceInode: row.inode, outputInode: fs.statSync(dest).ino}); continue;
    }
    let target;
    if (inside(sdkRoot, row.canonical)) target = path.join(packageRoot, path.relative(sdkRoot, row.canonical));
    else {
      const name = row.relative.startsWith('node_modules/') ? row.relative.slice('node_modules/'.length) : '';
      const dep = dependencies.get(name); assert.ok(dep, `Unbound SDK alias: ${row.relative}`);
      assert.equal(sha(fs.readFileSync(path.join(row.canonical, 'package.json'))), dep.metadataSHA256, `Alias package identity changed: ${name}`);
      target = dep.canonicalRoot;
    }
    fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.symlinkSync(path.relative(path.dirname(dest), target), dest);
    aliases.push({relative: row.relative, canonical: target});
  }
  for (const dep of dependencies.values()) {
    const alias = path.join(packageRoot, 'node_modules', dep.name);
    if (fs.existsSync(alias)) { assert.equal(fs.realpathSync(alias), dep.canonicalRoot); continue; }
    fs.mkdirSync(path.dirname(alias), {recursive: true}); fs.symlinkSync(path.relative(path.dirname(alias), dep.canonicalRoot), alias);
    aliases.push({relative: path.relative(packageRoot, alias), canonical: dep.canonicalRoot});
  }
  // Copy the existing public transformer without changing its bytes or parser import.
  atomicNewFile(path.join(control, 'build-host-adapter.mjs'), builder);
  atomicNewFile(path.join(control, 'PATCH-SPEC.json'), specBytes);
  fs.mkdirSync(path.join(control, 'node_modules'));
  fs.symlinkSync(path.dirname(tools.acornPackage.path), path.join(control, 'node_modules/acorn'));
  const {parse} = await import(pathToFileURL(tools.acorn.path).href);
  const {transformLeaf, reverseLeaf} = await import(pathToFileURL(path.join(control, 'build-host-adapter.mjs')).href);
  const transforms = [], links = [], staleMaps = [];
  for (const leaf of [...Object.keys(spec.leaves), 'dist/rpc-entry.js']) {
    const original = fs.readFileSync(path.join(sdkRoot, leaf), 'utf8');
    const result = leaf === 'dist/rpc-entry.js' ? deriveRpcLeaf(original, rpcOriginalSHA256, parse) : transformLeaf(leaf, original);
    if (leaf !== 'dist/rpc-entry.js') { assert.equal(reverseLeaf(result), original); assert.equal(result.edits.length, spec.expectedEditCounts[leaf]); }
    transforms.push({leaf, sourceSHA256: sha(original), generatedSHA256: sha(result.output), edits: leaf === 'dist/rpc-entry.js' ? 1 : result.edits.length, reverseByteExact: true});
    let output = result.output;
    if (leaf === 'dist/cli.js' || leaf === 'dist/rpc-entry.js') { const linked = linkCliOrRpcLeaf(output, sha(output), parse); links.push({leaf, ...linked}); output = linked.output; }
    staleMaps.push({leaf, removed: output.match(/^\/\/# sourceMappingURL=.*$/gm) ?? []});
    output = output.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, '');
    parse(output, {ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true});
    atomicNewFile(path.join(packageRoot, leaf), output, fs.statSync(path.join(sdkRoot, leaf)).mode & 0o777);
  }
  atomicNewFile(path.join(packageRoot, 'dist/host/sdk-ports.js'), sdkPortsSource);
  atomicNewFile(path.join(packageRoot, 'dist/bundle/cli.js'), cliWrapperSource, 0o755);
  atomicNewFile(path.join(packageRoot, 'dist/bundle/rpc-entry.js'), rpcWrapperSource, 0o755);
  const asset = path.join(flowRoot, 'src/mcp/app-bridge.bundle.js');
  atomicNewFile(path.join(packageRoot, 'dist/host/app-bridge.bundle.js'), checked(sourcePins.get(asset)));
  const esbuild = await import(pathToFileURL(tools.esbuildEntry.path).href);
  assert.equal(esbuild.version, '0.28.2');
  const marker = Symbol('owned source'), externalImports = new Set();
  const plugin = {name: 'owned-sdk-host-only', setup(build) {
    build.onResolve({filter: /.*/}, async args => {
      if (args.pluginData === marker) return;
      if (isBuiltin(args.path)) return {path: args.path, external: true};
      if (args.path.startsWith('m18:')) { assert.ok(hostPortSpecifiers.includes(args.path)); return {path: './sdk-ports.js', external: true}; }
      if (!args.path.startsWith('.') && !path.isAbsolute(args.path)) {
        assert.ok(runtimeExternals.includes(args.path), `Unapproved Host external ${args.path}`);
        externalImports.add(args.path); return {path: args.path, external: true};
      }
      const found = await build.resolve(args.path, {resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: marker});
      assert.equal(found.errors.length, 0, JSON.stringify(found.errors)); assert.equal(found.external, false);
      const p = fs.realpathSync(found.path); assert.ok(sourcePins.has(p) && inside(flowRoot, p), `Unbound Host input ${p}`); return {path: p};
    });
    build.onLoad({filter: /.*/}, args => ({contents: checked(sourcePins.get(fs.realpathSync(args.path))), loader: path.extname(args.path) === '.json' ? 'json' : 'ts', resolveDir: path.dirname(args.path)}));
  }};
  let result;
  try {
    result = await esbuild.build({entryPoints: [path.join(flowRoot, 'src/host/owned-default-launcher.ts')], outfile: path.join(packageRoot, 'dist/host/owned-default-launcher.js'), absWorkingDir: flowRoot,
      bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', write: false, metafile: true, splitting: false,
      tsconfigRaw: {compilerOptions: {target: 'ES2022', useDefineForClassFields: true, verbatimModuleSyntax: true}}, plugins: [plugin]});
  } finally { esbuild.stop(); }
  assert.equal(result.outputFiles.length, 1);
  for (const p of Object.keys(result.metafile.inputs)) { const canonical = fs.realpathSync(path.resolve(flowRoot, p)); assert.ok(sourcePins.has(canonical) && inside(flowRoot, canonical)); }
  for (const entry of Object.values(result.metafile.outputs)) for (const imp of entry.imports) assert.ok(isBuiltin(imp.path) || imp.path === './sdk-ports.js' || runtimeExternals.includes(imp.path));
  atomicNewFile(path.join(packageRoot, 'dist/host/owned-default-launcher.js'), result.outputFiles[0].contents);
  assert.equal(sha(fs.readFileSync(path.join(packageRoot, 'package.json'))), sha(metadata));
  for (const row of before.filter(r => r.kind === 'file' && r.relative.endsWith('.d.ts'))) assert.equal(sha(fs.readFileSync(path.join(packageRoot, row.relative))), row.sha256);
  assert.deepEqual(files(sdkRoot), before);
  for (const row of sourcePins.values()) checked(row);
  for (const p of [pkg.main, pkg.types, pkg.bin.pi, pkg.exports['.'].import, pkg.exports['.'].types, pkg.exports['./rpc-entry'].import]) assert.ok(fs.statSync(path.join(packageRoot, p)).isFile());
  for (const row of before.filter(r => r.kind === 'directory').reverse()) fs.chmodSync(path.join(packageRoot, row.relative), row.mode & 0o777);
  const identity = {kind: 'owned-sdk-unbundled-build', version: 1, packageRoot, source: {sdkRoot, flowRoot, sdkInventorySHA256: input.sdkInventorySHA256},
    tools, transforms, links, staleMaps, copied, aliases, externalResolutions: resolutions, externalImports: [...externalImports].sort(),
    SDKExecuted: false, runtimeValidated: false, portableDependencyBindings: false, publicMetadataSHA256: sha(metadata),
    agentSessionModule: path.join(packageRoot, 'dist/core/agent-session.js'), publicEntry: path.join(packageRoot, 'dist/index.js'),
    hostPorts: path.join(packageRoot, 'dist/host/sdk-ports.js'), files: files(packageRoot)};
  atomicNewFile(path.join(out, 'METAFILE.json'), JSON.stringify(result.metafile, null, 2) + '\n');
  atomicNewFile(path.join(out, 'IDENTITY-MANIFEST.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}
