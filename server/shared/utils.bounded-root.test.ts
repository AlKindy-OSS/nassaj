import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  findProviderSkillMarkdownFiles,
  readProviderSkillMarkdownDefinition,
} from './utils.js';

test('an absent optional skill root is an empty source without a failed action', async () => {
  const root = await mkdtemp(path.join('/var/tmp', 'skill-root-absent-'));
  await rm(root, { recursive: true });
  const reasons: string[] = [];
  assert.deepEqual(await findProviderSkillMarkdownFiles(root, {
    onIncomplete: (reason) => reasons.push(reason),
  }), []);
  assert.deepEqual(reasons, []);
});

test('configured symlink and non-directory roots fail in a controlled way', async () => {
  const sandbox = await mkdtemp(path.join('/var/tmp', 'skill-root-invalid-'));
  try {
    const realRoot = path.join(sandbox, 'real');
    const linkRoot = path.join(sandbox, 'link');
    const fileRoot = path.join(sandbox, 'file');
    await mkdir(realRoot);
    await symlink(realRoot, linkRoot);
    await writeFile(fileRoot, 'not a directory');
    for (const root of [linkRoot, fileRoot]) {
      const reasons: string[] = [];
      assert.deepEqual(await findProviderSkillMarkdownFiles(root, {
        onIncomplete: (reason) => reasons.push(reason),
      }), []);
      assert.deepEqual(reasons, ['unreadable']);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('valid skill definitions are read within their configured root', async () => {
  const root = await mkdtemp(path.join('/var/tmp', 'skill-root-valid-'));
  try {
    const skillDir = path.join(root, 'synthetic');
    await mkdir(skillDir);
    const skillPath = path.join(skillDir, 'SKILL.md');
    await writeFile(skillPath, '---\nname: synthetic\ndescription: safe fixture\n---\n');
    assert.deepEqual(await findProviderSkillMarkdownFiles(root), [skillPath]);
    assert.deepEqual(await readProviderSkillMarkdownDefinition(skillPath, { rootDir: root }), {
      name: 'synthetic',
      description: 'safe fixture',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
