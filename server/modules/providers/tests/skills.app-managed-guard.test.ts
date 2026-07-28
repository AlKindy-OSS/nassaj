/**
 * B-175 (2) — the skill write surface must not destroy folders it did not create.
 *
 * `POST /:provider/skills` REPLACES a skill directory (`rm -rf` then rewrite) and
 * `DELETE /:provider/skills/:name` deletes one outright. Both resolve their target
 * from a caller-supplied NAME under the provider's writable skill root, which for
 * claude/codex is the OPERATOR's own `~/.claude/skills` / `~/.agents/skills` — the
 * same folders that hold hand-authored skills written outside this app. Before the
 * install marker there was no way to tell the two apart, so an owner/admin clicking
 * "delete" on any listed skill irreversibly removed the owner's own work.
 *
 * `SkillsProvider` now writes a `.nassaj-skill.json` marker into every directory it
 * installs and refuses to overwrite or delete a directory that lacks it. These tests
 * lock that gate shut, including the batch-atomicity property (a colliding entry
 * must abort the whole request before any entry is written).
 *
 * Runner: npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *           --test server/modules/providers/tests/skills.app-managed-guard.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';

const MARKER_FILE = '.nassaj-skill.json';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

const skillMarkdown = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`;

const pathExists = async (target: string): Promise<boolean> =>
  fs.stat(target).then(() => true, () => false);

test(
  'a hand-authored skill folder is never overwritten or deleted through the API (B-175)',
  { concurrency: false },
  async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-managed-guard-'));
    const restoreHomeDir = patchHomeDir(tempRoot);

    try {
      // A skill the owner wrote by hand: real SKILL.md, real supporting script,
      // and NO install marker.
      const claudeSkillsRoot = path.join(tempRoot, '.claude', 'skills');
      const handmadeDir = path.join(claudeSkillsRoot, 'handmade');
      await fs.mkdir(path.join(handmadeDir, 'scripts'), { recursive: true });
      await fs.writeFile(
        path.join(handmadeDir, 'SKILL.md'),
        skillMarkdown('handmade', 'Hand-authored body.'),
        'utf8',
      );
      await fs.writeFile(path.join(handmadeDir, 'scripts', 'run.sh'), 'echo original\n', 'utf8');

      // DELETE must refuse (404 is reserved for "absent"; this is 409 "not ours").
      await assert.rejects(
        () => providerSkillsService.removeProviderSkill('claude', 'handmade'),
        (error: Error & { code?: string; statusCode?: number }) => {
          assert.equal(error.code, 'PROVIDER_SKILL_NOT_APP_MANAGED');
          assert.equal(error.statusCode, 409);
          return true;
        },
        'deleting a folder this app did not install must be refused',
      );

      // POST (overwrite) must refuse too — the rm -rf is the destructive part.
      await assert.rejects(
        () => providerSkillsService.addProviderSkills('claude', {
          entries: [{
            directoryName: 'handmade',
            content: skillMarkdown('handmade', 'Attacker body.'),
          }],
        }),
        (error: Error & { code?: string; statusCode?: number }) => {
          assert.equal(error.code, 'PROVIDER_SKILL_NOT_APP_MANAGED');
          assert.equal(error.statusCode, 409);
          return true;
        },
        'overwriting a folder this app did not install must be refused',
      );

      // The owner's bytes are untouched by both refusals.
      assert.match(
        await fs.readFile(path.join(handmadeDir, 'SKILL.md'), 'utf8'),
        /Hand-authored body\./,
      );
      assert.equal(
        await fs.readFile(path.join(handmadeDir, 'scripts', 'run.sh'), 'utf8'),
        'echo original\n',
      );
    } finally {
      restoreHomeDir();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  'app-installed skills carry the marker and stay overwritable and removable',
  { concurrency: false },
  async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-managed-roundtrip-'));
    const restoreHomeDir = patchHomeDir(tempRoot);

    try {
      const [installed] = await providerSkillsService.addProviderSkills('claude', {
        entries: [{
          directoryName: 'app-owned',
          content: skillMarkdown('app-owned', 'First body.'),
          files: [{ relativePath: 'scripts/run.js', content: 'first', encoding: 'utf8' }],
        }],
      });

      const installedDir = path.dirname(installed.sourcePath);
      const marker = JSON.parse(await fs.readFile(path.join(installedDir, MARKER_FILE), 'utf8'));
      assert.equal(marker.managedBy, 'nassaj');
      assert.equal(marker.provider, 'claude');
      assert.equal(marker.name, 'app-owned');
      assert.equal(typeof marker.installedAt, 'string');

      // Re-install over the app's own directory still works (and still prunes
      // stale supporting files), and the marker survives the replace.
      await providerSkillsService.addProviderSkills('claude', {
        entries: [{
          directoryName: 'app-owned',
          content: skillMarkdown('app-owned', 'Second body.'),
        }],
      });
      assert.match(await fs.readFile(installed.sourcePath, 'utf8'), /Second body\./);
      assert.equal(await pathExists(path.join(installedDir, 'scripts', 'run.js')), false);
      assert.equal(await pathExists(path.join(installedDir, MARKER_FILE)), true);

      const removed = await providerSkillsService.removeProviderSkill('claude', 'app-owned');
      assert.equal(removed.name, 'app-owned');
      assert.equal(await pathExists(installedDir), false);
    } finally {
      restoreHomeDir();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  'an uploaded file may not forge the install marker, and a colliding batch writes nothing',
  { concurrency: false },
  async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-managed-forge-'));
    const restoreHomeDir = patchHomeDir(tempRoot);

    try {
      const claudeSkillsRoot = path.join(tempRoot, '.claude', 'skills');

      // The marker is written by the provider alone: an upload claiming that
      // relative path is rejected as an invalid supporting file.
      await assert.rejects(
        () => providerSkillsService.addProviderSkills('claude', {
          entries: [{
            directoryName: 'forged',
            content: skillMarkdown('forged', 'Body.'),
            files: [{
              relativePath: MARKER_FILE,
              content: '{"managedBy":"nassaj"}',
              encoding: 'utf8',
            }],
          }],
        }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, 'PROVIDER_SKILL_FILE_PATH_INVALID');
          return true;
        },
      );
      assert.equal(await pathExists(path.join(claudeSkillsRoot, 'forged')), false);

      // Batch atomicity: entry 1 is fine, entry 2 collides with a hand-authored
      // folder. Validation runs over the whole batch BEFORE any write, so entry 1
      // must not land on disk either.
      const handmadeDir = path.join(claudeSkillsRoot, 'protected');
      await fs.mkdir(handmadeDir, { recursive: true });
      await fs.writeFile(
        path.join(handmadeDir, 'SKILL.md'),
        skillMarkdown('protected', 'Owner body.'),
        'utf8',
      );

      await assert.rejects(
        () => providerSkillsService.addProviderSkills('claude', {
          entries: [
            { directoryName: 'batch-first', content: skillMarkdown('batch-first', 'One.') },
            { directoryName: 'protected', content: skillMarkdown('protected', 'Two.') },
          ],
        }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, 'PROVIDER_SKILL_NOT_APP_MANAGED');
          return true;
        },
      );
      assert.equal(
        await pathExists(path.join(claudeSkillsRoot, 'batch-first')),
        false,
        'a rejected batch must not partially install',
      );
      assert.match(
        await fs.readFile(path.join(handmadeDir, 'SKILL.md'), 'utf8'),
        /Owner body\./,
      );
    } finally {
      restoreHomeDir();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);
