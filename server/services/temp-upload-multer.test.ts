/**
 * T-2116 (qa condition 1): upload staging never lands in RAM by default.
 * /tmp and /dev/shm are tmpfs on the fleet hosts, so staged bytes would be held
 * in memory until unlinked. The resolver picks the first disk-backed candidate
 * and refuses a RAM-backed override outright.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isRamBackedPath, resolveUploadStagingRoot } from './temp-upload-multer.js';

const MOUNTS = [
  '/dev/sda1 / ext4 rw,relatime 0 0',
  'tmpfs /tmp tmpfs rw,nosuid,nodev 0 0',
  'tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0',
  'tmpfs /run tmpfs rw,nosuid 0 0',
  '/dev/sdb1 /srv/data\\040disk ext4 rw 0 0',
].join('\n');
const VAR_TMP_ON_TMPFS = `${MOUNTS}\ntmpfs /var/tmp tmpfs rw 0 0`;

test('a path is RAM-backed by its longest matching mount', () => {
  assert.equal(isRamBackedPath('/tmp/x', MOUNTS), true);
  assert.equal(isRamBackedPath('/dev/shm', MOUNTS), true);
  assert.equal(isRamBackedPath('/var/tmp', MOUNTS), false);
  assert.equal(isRamBackedPath('/tmpfoo', MOUNTS), false);
  assert.equal(isRamBackedPath('/srv/data disk/u', MOUNTS), false);
  assert.equal(isRamBackedPath('/var/tmp/a', VAR_TMP_ON_TMPFS), true);
});

test('without a mount table, the well-known RAM roots are still refused', () => {
  assert.equal(isRamBackedPath('/tmp/x', null), true);
  assert.equal(isRamBackedPath('/dev/shm/x', null), true);
  assert.equal(isRamBackedPath('/var/tmp', null), false);
});

test('default staging root is /var/tmp when it is disk-backed', () => {
  assert.equal(resolveUploadStagingRoot({ env: {}, mounts: MOUNTS, fallbackDir: '/data' }), '/var/tmp');
});

test('a disk-backed override wins', () => {
  const env = { NASSAJ_UPLOAD_STAGING_DIR: '/srv/data disk/stage' };
  assert.equal(resolveUploadStagingRoot({ env, mounts: MOUNTS, fallbackDir: '/data' }), '/srv/data disk/stage');
});

test('a RAM-backed override is refused, never silently used', () => {
  const env = { NASSAJ_UPLOAD_STAGING_DIR: '/tmp/stage' };
  assert.throws(() => resolveUploadStagingRoot({ env, mounts: MOUNTS, fallbackDir: '/data' }),
    /NASSAJ_UPLOAD_STAGING_DIR is RAM-backed/);
});

test('when /var/tmp is tmpfs the data dir is used', () => {
  assert.equal(resolveUploadStagingRoot({ env: {}, mounts: VAR_TMP_ON_TMPFS, fallbackDir: '/data' }),
    '/data/upload-staging');
});

test('no disk-backed candidate fails closed', () => {
  assert.throws(() => resolveUploadStagingRoot({ env: {}, mounts: VAR_TMP_ON_TMPFS, fallbackDir: '/tmp/d' }),
    /no disk-backed upload staging directory/);
});
