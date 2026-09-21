import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { readContainedCommandFile } from '../commands.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-fd-root-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-fd-outside-'));
const safePath = path.join(root, 'safe.md');
const outsidePath = path.join(outside, 'outside.md');
const OUTSIDE_MARKER = 'SYNTHETIC_OUTSIDE_CONTENT_MUST_NOT_BE_READ';

fs.writeFileSync(safePath, 'synthetic safe command', 'utf8');
fs.writeFileSync(outsidePath, OUTSIDE_MARKER, 'utf8');

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

async function expectDenied(commandPath: string): Promise<void> {
  await assert.rejects(
    readContainedCommandFile(commandPath, [root]),
    (error: unknown) => (error as { code?: string }).code === 'COMMAND_ACCESS_DENIED',
  );
}

test('fd-bound command reader returns a normal command from its pinned root', async () => {
  assert.equal(await readContainedCommandFile(safePath, [root]), 'synthetic safe command');
});

test('fd-bound command reader rejects a direct outside file before reading it', async () => {
  await expectDenied(outsidePath);
});

test('fd-bound command reader rejects an outside inode hard-linked into the root', async () => {
  const hardLink = path.join(root, 'outside-hard-link.md');
  fs.linkSync(outsidePath, hardLink);
  await expectDenied(hardLink);
});

test('fd-bound command reader rejects a final symlink to an outside file', async () => {
  const link = path.join(root, 'outside-link.md');
  fs.symlinkSync(outsidePath, link);
  await expectDenied(link);
});

test('a dangling command symlink stays denied after its target activates', async () => {
  const target = path.join(outside, 'activated.md');
  const link = path.join(root, 'delayed-link.md');
  fs.symlinkSync(target, link);

  await expectDenied(link);
  fs.writeFileSync(target, OUTSIDE_MARKER, 'utf8');
  await expectDenied(link);
});

test('adversarial final-entry swaps can return only safe content or a refusal', async () => {
  const racePath = path.join(root, 'race.md');
  const nextSafePath = path.join(root, 'race-safe.next');
  const safeContent = 'synthetic race-safe command';
  fs.writeFileSync(racePath, safeContent, 'utf8');
  const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  const swapper = async () => {
    for (let index = 0; index < 80; index += 1) {
      await fs.promises.unlink(racePath).catch(() => {});
      await fs.promises.symlink(outsidePath, racePath).catch(() => {});
      await yieldTurn();
      await fs.promises.writeFile(nextSafePath, safeContent, 'utf8');
      await fs.promises.rename(nextSafePath, racePath);
      await yieldTurn();
    }
  };
  const readers = Array.from({ length: 80 }, async () => {
    await yieldTurn();
    try {
      const content = await readContainedCommandFile(racePath, [root]);
      assert.equal(content, safeContent);
      assert.ok(!content.includes(OUTSIDE_MARKER));
    } catch (error) {
      const details = error as { code?: string; message?: string };
      assert.ok(
        ['COMMAND_ACCESS_DENIED', 'ENOENT'].includes(details.code ?? ''),
        `unexpected read failure: ${details.code ?? 'unknown'} ${details.message ?? ''}`,
      );
    }
  });

  await Promise.all([swapper(), ...readers]);
});
