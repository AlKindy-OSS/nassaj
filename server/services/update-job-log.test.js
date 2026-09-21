import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createUpdateJobLog, sanitizeUpdateLogText, UPDATE_JOB_LOG_CAP_BYTES, UPDATE_JOB_LOG_READ_CHUNK,
} from './update-job-log.js';

const scratch = () => fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP || os.tmpdir(), 'update-job-log-'));

test('sanitizer redacts URL credentials, tokens and private keys (T-1768)', () => {
    const out = sanitizeUpdateLogText([
        // Token and key literals are split so the public-operations secret scanner does not read them as real.
        'fetching https://x-access-token:ghs' + '_fixtureabcdefghijklmnop@github.com/o/r.git',
        'Authorization: Bearer abc.def.ghi',
        'token=s3cr3t api_key: "k-123" password=hunter2',
        'leaked ghp' + '_fixtureabcdefghijklmnopqrstu and sk-ant-abcdefghijklmnopqrstu',
        '-----BEGIN OPENSSH PRIVATE' + ' KEY-----\nAAAA\n-----END OPENSSH PRIVATE' + ' KEY-----',
    ].join('\n'));
    for (const secret of ['x-access-token', 'ghs_', 'abc.def.ghi', 's3cr3t', 'k-123', 'hunter2', 'ghp_', 'sk-ant', 'AAAA']) {
        assert.ok(!out.includes(secret), `${secret} must be redacted: ${out}`);
    }
    assert.match(out, /https:\/\/github\.com\/o\/r\.git/);
    assert.match(out, /\[private key redacted\]/);
});

test('sanitizer strips ANSI and control bytes, collapses the install root, keeps Arabic', () => {
    const out = sanitizeUpdateLogText('\x1b[32madded\x1b[0m 3 packages in /opt/nassaj/node_modules\r\nتم\x07', { appRoot: '/opt/nassaj' });
    assert.equal(out, 'added 3 packages in ./node_modules\nتم');
});

test('append writes a 0600 file and read resumes from the returned offset', () => {
    const root = scratch();
    const log = createUpdateJobLog({ root, now: () => Date.UTC(2026, 8, 12, 9, 14, 3) });
    log.line('job-1', '▸ staging · intent');
    log.append('job-1', '$ npm ci\nadded 1 package\n');
    const file = log.fileFor('job-1');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const first = log.read('job-1', 0);
    assert.equal(first.text, '[09:14:03] ▸ staging · intent\n$ npm ci\nadded 1 package\n');
    log.append('job-1', 'done\n');
    const second = log.read('job-1', first.offset);
    assert.equal(second.text, 'done\n');
    assert.equal(log.read('job-1', second.offset).text, '');
});

test('read never splits a line or a UTF-8 character across chunks', () => {
    const root = scratch();
    const log = createUpdateJobLog({ root });
    const line = `${'ب'.repeat(100)}\n`;
    const count = Math.ceil((UPDATE_JOB_LOG_READ_CHUNK * 2) / Buffer.byteLength(line));
    log.append('job-2', line.repeat(count));
    let offset = 0;
    let text = '';
    for (let guard = 0; guard < 10; guard += 1) {
        const chunk = log.read('job-2', offset);
        if (!chunk.text) break;
        assert.ok(chunk.text.endsWith('\n'), 'every chunk ends on a line boundary');
        assert.ok(!chunk.text.includes('�'), 'no replacement characters');
        text += chunk.text;
        offset = chunk.offset;
    }
    assert.equal(text, line.repeat(count));
});

test('the log stops at its size cap with one truncation marker', () => {
    const root = scratch();
    const log = createUpdateJobLog({ root });
    log.append('job-3', 'x'.repeat(UPDATE_JOB_LOG_CAP_BYTES - 10));
    log.append('job-3', 'y'.repeat(100));
    log.append('job-3', 'never written');
    const size = fs.statSync(log.fileFor('job-3')).size;
    assert.ok(size <= UPDATE_JOB_LOG_CAP_BYTES, `size ${size} exceeds the cap`);
    const tail = fs.readFileSync(log.fileFor('job-3'), 'utf8').slice(-120);
    assert.match(tail, /log size limit reached/);
    assert.ok(!tail.includes('never written'));
});

test('unsafe job ids and a missing root are refused without throwing', () => {
    const root = scratch();
    const log = createUpdateJobLog({ root });
    log.append('../escape', 'nope');
    assert.deepEqual(fs.readdirSync(root), []);
    assert.deepEqual(log.read('../escape', 0), { offset: 0, size: 0, text: '' });
    const rootless = createUpdateJobLog({ root: null });
    rootless.append('job-4', 'ignored');
    assert.deepEqual(rootless.read('job-4', 0), { offset: 0, size: 0, text: '' });
});

test('a write failure is swallowed: logging never fails the update', () => {
    const root = scratch();
    const blocker = path.join(root, 'file-not-dir');
    fs.writeFileSync(blocker, '');
    const log = createUpdateJobLog({ root: blocker });
    assert.doesNotThrow(() => log.append('job-5', 'text'));
    assert.doesNotThrow(() => log.line('job-5', 'text'));
});
