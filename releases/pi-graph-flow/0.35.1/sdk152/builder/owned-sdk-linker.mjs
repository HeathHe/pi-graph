import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
export const rpcOriginalSHA256 = 'a515a6930662a74b4840fb220c3527545c169a84b17bdbae21d4a8ee6b8da30b';
export const hostPortSpecifiers = Object.freeze([
  'm18:hosted-main', 'm18:hosted-sdk', 'm18:hosted-services', 'm18:hosted-session', 'm18:hosted-runtime',
  'm18:owned-prompts', 'm18:owned-theme', 'm18:owned-source-info', 'm18:native-mcp-transport', 'm18:owned-extension-policy',
]);
function replaceMainImport(source, from, to, expectedSHA256, parse) {
  assert.equal(hash(source), expectedSHA256);
  const options = {ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true};
  const matches = parse(source, options).body.filter(n => n.type === 'ImportDeclaration' && n.source.value === from);
  assert.equal(matches.length, 1);
  const node = matches[0];
  assert.equal(node.specifiers.length, 1);
  const specifier = node.specifiers[0];
  assert.equal(specifier.type, 'ImportSpecifier');
  assert.equal(specifier.local.name, 'main');
  assert.equal(specifier.imported.name, from === './main.js' ? 'main' : 'runOwnedDefaultMain');
  const old = source.slice(node.start, node.end);
  const text = `import { runOwnedDefaultMain as main } from ${JSON.stringify(to)};`;
  const output = source.slice(0, node.start) + text + source.slice(node.end);
  parse(output, options);
  assert.equal(output.slice(0, node.start) + old + output.slice(node.start + text.length), source);
  return {output, sourceSHA256: hash(source), outputSHA256: hash(output),
    edit: {start: node.start, end: node.end, old, text}, reverseByteExact: true};
}
export function deriveRpcLeaf(source, expectedSHA256, parse) {
  return replaceMainImport(source, './main.js', 'm18:owned-default-launcher', expectedSHA256, parse);
}
export function linkCliOrRpcLeaf(source, expectedSHA256, parse) {
  return replaceMainImport(source, 'm18:owned-default-launcher', './host/owned-default-launcher.js', expectedSHA256, parse);
}
export const sdkPortsSource = `// Proposed target: owned-sdk/dist/host/sdk-ports.js.
// Re-exports only: every class/function is from the ONE sibling SDK module tree.
export { main } from "../main.js";
export { createAgentSession } from "../core/sdk.js";
export { createAgentSessionServices, createAgentSessionFromServices } from "../core/agent-session-services.js";
export { AgentSession } from "../core/agent-session.js";
export { AgentSessionRuntime, createAgentSessionRuntime } from "../core/agent-session-runtime.js";
export { loadOwnedExtensionSet } from "../core/resource-loader.js";
export { loadPromptTemplates } from "../core/prompt-templates.js";
export { loadThemeFromPath } from "../modes/interactive/theme/theme.js";
export { createSourceInfo } from "../core/source-info.js";
export { createDefaultTransport } from "../extensions/mcp/runtime.js";
`;
export const cliWrapperSource = '#!/usr/bin/env node\n// Proposed target: owned-sdk/dist/bundle/cli.js.\nawait import("../cli.js");\n';
export const rpcWrapperSource = '#!/usr/bin/env node\n// Proposed target: owned-sdk/dist/bundle/rpc-entry.js.\nawait import("../rpc-entry.js");\n';
