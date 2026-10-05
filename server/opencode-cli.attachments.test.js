/**
 * B-1374 — OpenCode `--file` attachments are confined to the project's upload inbox.
 *
 * A member used to be able to send files[].path = "/etc/passwd" (or a `..` climb, or
 * a symlink planted in the inbox) and opencode would read and upload that host file.
 * These tests prove only real files inside `<project>/.nassaj-uploads/inbox` survive.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { prepareOpenCodeAttachments } from './opencode-cli.js';
import { resolveInboxAttachment } from './utils/attachment-inbox.js';

let scratch;
let project;
let inbox;
let outside;

before(async () => {
  scratch = await realpath(await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'b1374-')));
  project = path.join(scratch, 'project');
  inbox = path.join(project, '.nassaj-uploads', 'inbox');
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, 'report.pdf'), 'pdf');
  await mkdir(path.join(inbox, 'folder'));
  await writeFile(path.join(project, 'README.md'), 'readme');
  outside = path.join(scratch, 'secret.txt');
  await writeFile(outside, 'secret');
  await symlink(outside, path.join(inbox, 'escape.txt'));
  await symlink(path.join(inbox, 'report.pdf'), path.join(inbox, 'alias.pdf'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('resolveInboxAttachment', () => {
  it('accepts the cwd-relative path the upload endpoint returns', () => {
    assert.equal(resolveInboxAttachment(project, '.nassaj-uploads/inbox/report.pdf'), path.join(inbox, 'report.pdf'));
  });

  it('accepts an absolute path that really is inside the inbox', () => {
    assert.equal(resolveInboxAttachment(project, path.join(inbox, 'report.pdf')), path.join(inbox, 'report.pdf'));
  });

  it('accepts an in-inbox symlink to an in-inbox file, returning the real path', () => {
    assert.equal(resolveInboxAttachment(project, '.nassaj-uploads/inbox/alias.pdf'), path.join(inbox, 'report.pdf'));
  });

  it('REFUSES an absolute host path', () => {
    assert.equal(resolveInboxAttachment(project, outside), null);
    assert.equal(resolveInboxAttachment(project, '/etc/passwd'), null);
  });

  it('REFUSES a `..` climb out of the inbox, even to a project file', () => {
    assert.equal(resolveInboxAttachment(project, '.nassaj-uploads/inbox/../../README.md'), null);
    assert.equal(resolveInboxAttachment(project, 'README.md'), null);
  });

  it('REFUSES a symlink inside the inbox that escapes it', () => {
    assert.equal(resolveInboxAttachment(project, '.nassaj-uploads/inbox/escape.txt'), null);
  });

  it('REFUSES directories, missing files, the inbox itself and malformed refs', () => {
    assert.equal(resolveInboxAttachment(project, '.nassaj-uploads/inbox/folder'), null);
    assert.equal(resolveInboxAttachment(project, '.nassaj-uploads/inbox/nope.pdf'), null);
    assert.equal(resolveInboxAttachment(project, '.nassaj-uploads/inbox'), null);
    assert.equal(resolveInboxAttachment(project, ''), null);
    assert.equal(resolveInboxAttachment(project, 42), null);
    assert.equal(resolveInboxAttachment(project, '.nassaj-uploads/inbox/report.pdf\0x'), null);
  });

  it('REFUSES everything when .nassaj-uploads is a symlink leading out of the project', async () => {
    const evil = path.join(scratch, 'evil-project');
    const target = path.join(scratch, 'evil-target', 'inbox');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'x.txt'), 'x');
    await mkdir(evil);
    await symlink(path.dirname(target), path.join(evil, '.nassaj-uploads'));
    assert.equal(resolveInboxAttachment(evil, '.nassaj-uploads/inbox/x.txt'), null);
  });
});

describe('prepareOpenCodeAttachments (B-1374)', () => {
  it('passes only inbox files to --file and counts the rest as rejected', async () => {
    const { filePaths, tempDir, rejectedFiles } = await prepareOpenCodeAttachments([], [
      { path: '.nassaj-uploads/inbox/report.pdf', name: 'report.pdf' },
      { path: '/etc/passwd', name: 'passwd' },
      { path: '.nassaj-uploads/inbox/escape.txt', name: 'escape.txt' },
      { path: '../secret.txt' },
      { name: 'no-path' },
    ], project);
    assert.deepEqual(filePaths, [path.join(inbox, 'report.pdf')]);
    assert.equal(rejectedFiles, 4);
    assert.equal(tempDir, null);
  });
});
