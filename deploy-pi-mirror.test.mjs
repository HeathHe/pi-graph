import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  deployConvertedPiMirror,
  deployMirrorSubdir,
  deployPackagedAgents,
  removeRetiredPackageAgentsFile,
  topLevelEntryNames,
} from './deploy-pi-mirror.mjs';

test('removeRetiredPackageAgentsFile removes stale package instructions idempotently', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-retired-agents-'));
  try {
    const target = join(root, 'AGENTS.md');
    writeFileSync(target, '# Retired instructions\n');
    assert.deepEqual(removeRetiredPackageAgentsFile(root), { target, removed: true });
    assert.equal(existsSync(target), false);
    assert.deepEqual(removeRetiredPackageAgentsFile(root), { target, removed: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deployPackagedAgents includes role definitions and schemas but excludes runtime captures', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-packaged-agents-'));
  try {
    const canonical = join(root, 'canonical');
    const packaged = join(root, 'packaged');
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, 'general.md'), 'role');
    writeFileSync(join(canonical, 'general.schema.json'), '{}');
    writeFileSync(join(canonical, '01234567-89ab-cdef-0123-456789abcdef.json'), '{"runtime":true}');
    const result = deployPackagedAgents(canonical, packaged);
    assert.deepEqual(result, { deployed: 2 });
    assert.deepEqual(topLevelEntryNames(packaged), ['general.md', 'general.schema.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync deploy sends skills to resources and never touches project-local skills', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-layout-deploy-'));
  const files = {
    '.pi-sync/skills/shared/SKILL.md': 'converted',
    '.pi-sync/agents/mirrored.md': 'converted role',
    'resources/skills/stale/SKILL.md': 'old converted skill',
    'resources/skills/native/SKILL.md': 'native distributed skill',
    '.pi/skills/stale/SKILL.md': 'local file with previously managed name',
    '.pi/skills/shared/notes.md': 'local file with incoming name',
    '.pi/agents/native.md': 'local role',
  };
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const manifest = deployConvertedPiMirror(root, join(root, '.pi-sync'), { skills: ['stale'] });
    assert.deepEqual(manifest, { skills: ['shared'], agents: ['mirrored.md'] });
    assert.deepEqual(topLevelEntryNames(join(root, 'resources', 'skills')), ['native', 'shared']);
    assert.equal(readFileSync(join(root, 'resources/skills/shared/SKILL.md'), 'utf8'), 'converted');
    assert.equal(readFileSync(join(root, '.pi/agents/mirrored.md'), 'utf8'), 'converted role');
    assert.equal(existsSync(join(root, '.pi/skills/shared/SKILL.md')), false);
    for (const [path, content] of Object.entries(files)) {
      if (path !== 'resources/skills/stale/SKILL.md') assert.equal(readFileSync(join(root, path), 'utf8'), content);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deployMirrorSubdir updates managed entries, removes stale mirror entries, and preserves Pi-native entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-mirror-deploy-'));
  try {
    const mirror = join(root, 'mirror');
    const target = join(root, 'target');
    mkdirSync(join(mirror, 'shared'), { recursive: true });
    mkdirSync(join(mirror, 'added'), { recursive: true });
    mkdirSync(join(target, 'shared'), { recursive: true });
    mkdirSync(join(target, 'stale'), { recursive: true });
    mkdirSync(join(target, 'native'), { recursive: true });
    writeFileSync(join(mirror, 'shared', 'value.txt'), 'new');
    writeFileSync(join(mirror, 'added', 'value.txt'), 'added');
    writeFileSync(join(target, 'shared', 'value.txt'), 'old');
    writeFileSync(join(target, 'stale', 'value.txt'), 'stale');
    writeFileSync(join(target, 'native', 'value.txt'), 'native');

    const result = deployMirrorSubdir(mirror, target, ['shared', 'stale']);
    assert.deepEqual(result, { deployed: 2, removed: 2 });
    assert.equal(readFileSync(join(target, 'shared', 'value.txt'), 'utf8'), 'new');
    assert.equal(readFileSync(join(target, 'added', 'value.txt'), 'utf8'), 'added');
    assert.equal(existsSync(join(target, 'stale')), false);
    assert.equal(readFileSync(join(target, 'native', 'value.txt'), 'utf8'), 'native');
    assert.deepEqual(topLevelEntryNames(target), ['added', 'native', 'shared']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
