import assert from 'node:assert/strict';
import test from 'node:test';

import { isForeignTestRunPath, isOwnTestRunPath } from './test-run-root-guard.js';

const LIVE_DB = '/home/user/.local/share/nassaj-dev/db.sqlite';

test('a test case dir is foreign to the server database (B-1420)', () => {
  assert.equal(isForeignTestRunPath('/var/tmp/nassaj-server-tests-OoUbHT/case-hLKgQv', LIVE_DB), true);
  assert.equal(isForeignTestRunPath('/tmp/nassaj-src-tests-abc123/case-x/sub', LIVE_DB), true);
});

test('a test case dir is allowed for a database inside the same run root', () => {
  const caseRoot = '/var/tmp/nassaj-server-tests-OoUbHT/case-hLKgQv';
  assert.equal(isForeignTestRunPath(caseRoot, `${caseRoot}/auth.db`), false);
  assert.equal(isForeignTestRunPath(caseRoot, '/var/tmp/nassaj-server-tests-OoUbHT/case-other/x.db'), false);
});

test('a different run root or a non-test path is judged correctly', () => {
  const caseRoot = '/var/tmp/nassaj-server-tests-OoUbHT/case-hLKgQv';
  assert.equal(isForeignTestRunPath(caseRoot, '/var/tmp/nassaj-server-tests-Other1/case-a/auth.db'), true);
  assert.equal(isForeignTestRunPath('/home/user/Project/nassaj-dev', LIVE_DB), false);
  assert.equal(isForeignTestRunPath('/var/tmp/nassaj-server-tests-/case-a', LIVE_DB), false);
  assert.equal(isForeignTestRunPath('/var/tmp/my-nassaj-server-tests-abc/case-a', LIVE_DB), false);
});

test('isOwnTestRunPath is true only for a case path of the database run root', () => {
  const caseRoot = '/var/tmp/nassaj-server-tests-OoUbHT/case-hLKgQv';
  assert.equal(isOwnTestRunPath(`${caseRoot}/tmp/x`, `${caseRoot}/auth.db`), true);
  assert.equal(isOwnTestRunPath(`${caseRoot}/tmp/x`, LIVE_DB), false);
  assert.equal(isOwnTestRunPath('/var/tmp/plain/x', '/var/tmp/plain/auth.db'), false);
});
