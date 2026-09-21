import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_DATABASE_PATH, resolveDatabaseFilePath } from './database-path.js';

test('the default database path is the shared user-level location (م4)', () => {
    assert.equal(DEFAULT_DATABASE_PATH, path.join(os.homedir(), '.cloudcli', 'auth.db'));
    assert.equal(resolveDatabaseFilePath({}), DEFAULT_DATABASE_PATH);
});

test('an explicit DATABASE_PATH is resolved to an absolute path (م4)', () => {
    assert.equal(resolveDatabaseFilePath({ DATABASE_PATH: '/srv/data/db.sqlite' }), '/srv/data/db.sqlite');
    assert.equal(resolveDatabaseFilePath({ DATABASE_PATH: 'data/db.sqlite' }), path.resolve('data/db.sqlite'));
});
