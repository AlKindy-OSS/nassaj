import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  AUDIT_REDACTED, LEGACY_AUDIT_REDACTION_RULES, isHighEntropySecret, redactForShare, scanJwts, segmentsToText,
} from './secret-patterns.js';

const S = '[redacted:secret]';
const N = '[redacted:network]';
const ctx = { projectRoot: '/home/op/Project/demo', home: '/home/op' };
const red = (text) => segmentsToText(redactForShare(text, ctx).segments);
const unchanged = (text) => assert.equal(red(text), text, `must not redact: ${text}`);

// Fixed fake credentials: shaped like real ones, valid nowhere.
const SK = 'sk-' + 'ant-api03-AbCdEfGhIjKlMnOpQrStUvWx';
const GHP = `ghp_${'Ab1'.repeat(12)}`;
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const ENTROPY = 'Zq8xT2vLm9WcR4yHn7KpB3sDf6GjA1eUo5Ni';

test('legacy audit rule set is exported intact', () => {
  assert.equal(AUDIT_REDACTED, '«redacted»');
  assert.equal(LEGACY_AUDIT_REDACTION_RULES.length, 4);
  assert.ok(Object.isFrozen(LEGACY_AUDIT_REDACTION_RULES));
});

test('JSON fields with credential names', () => {
  assert.equal(red('{"api_key": "abc123xyz"}'), `{"api_key": "${S}"}`);
  assert.equal(red('{"password":"hunter2","user":"bob"}'), `{"password":"${S}","user":"bob"}`);
  assert.equal(red('{"client_secret": "a\\"b"}'), `{"client_secret": "${S}"}`);
  assert.equal(red('"{\\"password\\":\\"hunter2\\"}"'), `"{\\"password\\":\\"${S}\\"}"`);
  unchanged('{"max_tokens": "4096", "token_type": "bearer", "user": "bob"}');
  unchanged('{"password": "", "token": "$TOKEN", "secret": "<your-secret>"}');
});

test('env / .env / YAML assignments', () => {
  assert.equal(red('OPENAI_API_KEY=abc123'), `OPENAI_API_KEY=${S}`);
  assert.equal(red('export GH_TOKEN="tok en"'), `export GH_TOKEN=${S}`);
  assert.equal(red('DB_PASSWORD=hunter2\nPORT=3000'), `DB_PASSWORD=${S}\nPORT=3000`);
  assert.equal(red('JWT_SECRET: s3cr3tvalue'), `JWT_SECRET: ${S}`);
  assert.equal(red('  password: "p@ss-word"'), `  password: ${S}`);
  assert.equal(red('https://x.test/cb?token=abc123&page=2'), `https://x.test/cb?token=${S}&page=2`);
  unchanged('API_KEY=\nTOKEN=$GH_TOKEN\nSECRET=${VAULT_SECRET}\nAPI_KEY=OPENAI_API_KEY');
  unchanged('Set the API_KEY variable, then PWD=/srv and MAX_TOKENS=4096.');
  unchanged('Password: required for login');
  unchanged('token: abcdef');
});

test('markdown tables', () => {
  assert.equal(red('| name | value |\n|---|---|\n| password | hunter2x |'),
    `| name | value |\n|---|---|\n| password | ${S} |`);
  assert.equal(red(`| GH | ${GHP} |`), `| GH | ${S} |`);
  unchanged('| token | description |\n|---|---|\n| api_key | the key used for auth |');
});

test('well-known token formats', () => {
  assert.equal(red(`use ${SK} now`), `use ${S} now`);
  assert.equal(red('sk-' + 'sp-0123456789abcdefABCD'), S);
  assert.equal(red(`token ${GHP}`), `token ${S}`);
  assert.equal(red(`github_pat_${'A1b_'.repeat(8)}`), S);
  assert.equal(red(`key ${'AKIA'}IOSFODNN7EXAMPLE end`), `key ${S} end`);
  assert.equal(red(`jwt ${JWT}`), `jwt ${S}`);
  unchanged('the task-sk-list and desk-sk-12 and AKIA-short and ghp_short');
});

test('Bearer and URL userinfo', () => {
  assert.equal(red('Authorization: Bearer abc.def-123'), `Authorization: Bearer ${S}`);
  assert.equal(red('postgres://admin:p4ss@db.local/x'), `postgres://admin:${S}@db.local/x`);
  unchanged('Bearer authentication is used. See https://example.com/a@b and mailto:me@x.y');
  unchanged('postgres://admin:$DB_PASS@db.local/x');
});

test('PEM private keys, bounded and with or without an END line', () => {
  const pem = '-----BEGIN RSA ' + 'PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nMIIEow==\n-----END RSA PRIVATE KEY-----';
  assert.equal(red(`a\n${pem}\nb`), `a\n${S}\nb`);
  assert.equal(red('-----BEGIN ' + 'PRIVATE KEY-----\nMIIEvQIBADANBg'), S);
  unchanged('-----BEGIN PUBLIC KEY-----\nMIIBIjAN\n-----END PUBLIC KEY-----');
});

test('Tailscale CGNAT addresses (100.64.0.0/10) only', () => {
  assert.equal(red('ssh 100.105.15.56 and 100.64.0.1'), `ssh ${N} and ${N}`);
  assert.equal(red('edge 100.127.255.255.'), `edge ${N}.`);
  unchanged('100.63.1.1 100.128.0.1 10.0.0.1 1100.64.1.1 100.64.1.256 v100.100.1.2345');
});

test('paths: nassaj-users home, project root, home', () => {
  const r = redactForShare('/home/op/.nassaj-users/1/.claude and /home/op/Project/demo/src/a.js'
    + ' and /home/op/notes and /home/operator/y', ctx);
  assert.equal(segmentsToText(r.segments),
    '~user/.claude and <project>/src/a.js and ~/notes and /home/operator/y');
  assert.deepEqual(r.counts, { secret: 0, path: 3, network: 0 });
  assert.equal(red('/home/op/Project/demo2/x'), '~/Project/demo2/x');
  assert.equal(segmentsToText(redactForShare('/home/op/x').segments), '/home/op/x');
});

test('high-entropy runs; git SHAs, UUIDs, words and paths are kept', () => {
  assert.equal(red(`blob ${ENTROPY} end`), `blob ${S} end`);
  assert.equal(red(randomBytes(48).toString('base64')), S);
  assert.equal(red(randomBytes(32).toString('hex')), S);
  unchanged('commit 198c5469e and e6bb2b41f0c7d3e7a1b2c3d4e5f60718293a4b5c (40 hex)');
  unchanged('id 550e8400-e29b-41d4-a716-446655440000');
  unchanged('src/components/chat/hooks/useConversationClosed.test.tsx');
  unchanged('Supercalifragilisticexpialidocious_and_more_words_here');
  assert.equal(isHighEntropySecret('a'.repeat(64)), false);
});

test('segment shape and counts', () => {
  const r = redactForShare(`k=1 API_KEY=${SK} at 100.64.0.9 in /home/op/x`, ctx);
  assert.deepEqual(r.counts, { secret: 1, path: 1, network: 1 });
  assert.deepEqual(r.segments[0], { t: 'text', text: 'k=1 API_KEY=' });
  assert.equal(r.segments[1].t, 'redacted');
  assert.equal(r.segments[1].cat, 'secret');
  assert.equal(r.segments[1].text, undefined, 'secret segments never carry the value');
  assert.deepEqual(redactForShare('', ctx), { segments: [], counts: { secret: 0, path: 0, network: 0 } });
  assert.deepEqual(redactForShare(null).segments, []);
  const plain = 'مرحبا بالعالم — نص عادي';
  assert.deepEqual(redactForShare(plain, ctx).segments, [{ t: 'text', text: plain }]);
});

test('4 MiB of adversarial input across all rules completes in < 500 ms', () => {
  const MiB = 1024 * 1024;
  const parts = [
    'a'.repeat(MiB / 4),
    'a='.repeat(MiB / 8),
    'token:'.repeat(MiB / 24),
    'token: abcdef '.repeat(MiB / 56),
    'password: x1 '.repeat(MiB / 26),
    '\\"secret\\":\\"'.repeat(MiB / 64),
    '"password":"'.repeat(MiB / 48),
    '| password |'.repeat(MiB / 48),
    'eyJ'.repeat(MiB / 24) + '.',
    '100.64.1.'.repeat(MiB / 36),
    '-----BEGIN ' + 'PRIVATE KEY-----' + 'A-'.repeat(MiB / 16),
    'http://u:'.repeat(MiB / 36),
    'Bearer '.repeat(MiB / 28),
    '/home/op/'.repeat(MiB / 36),
    'Ab1+'.repeat(MiB / 16),
  ];
  let input = parts.join('\n');
  input = input.length >= 4 * MiB ? input.slice(0, 4 * MiB) : input + 'x '.repeat((4 * MiB - input.length) / 2);
  const t0 = performance.now();
  redactForShare(input, ctx);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)} ms`);
});

test('the linear JWT scanner matches the reference regex on generated inputs', () => {
  const reference = /\beyJ[A-Za-z0-9_-]{4,8192}\.[A-Za-z0-9_-]{4,8192}\.[A-Za-z0-9_-]{4,8192}/g;
  const pieces = ['eyJ', 'eyJhbGci', 'a', 'Zz9', '-', '_', '.', ' ', 'x.', '-eyJ', '_eyJ', 'abcd', '\n'];
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (let round = 0; round < 3000; round += 1) {
    let text = '';
    for (let index = next() % 40; index >= 0; index -= 1) text += pieces[next() % pieces.length];
    const expected = [...text.matchAll(reference)].map((m) => [m.index, m.index + m[0].length]);
    assert.deepEqual(scanJwts(text).map((hit) => [hit.start, hit.end]), expected, JSON.stringify(text));
  }
  const long = `eyJ${'a'.repeat(9000)}.${'b'.repeat(10)}.${'c'.repeat(20)}`;
  assert.deepEqual(scanJwts(long).map((hit) => [hit.start, hit.end]),
    [...long.matchAll(reference)].map((m) => [m.index, m.index + m[0].length]), 'header longer than the cap');
});

test('JWT runs, blank-padded table cells and long base64 runs stay linear and stack-safe', () => {
  const MiB = 1024 * 1024;
  const shapes = {
    jwtRun: 'eyJ-'.repeat(MiB / 4),
    jwtDots: 'eyJaaaa.'.repeat(MiB / 8),
    tableBlanks: `| password | x${' '.repeat(4000)}\n`.repeat(MiB / 4016),
    base64Run: 'A'.repeat(8 * MiB),
  };
  for (const [name, input] of Object.entries(shapes)) {
    const t0 = performance.now();
    redactForShare(input, ctx);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 400, `${name} took ${elapsed.toFixed(0)} ms`);
  }
});

test('table cells: trailing blanks and a padded closing backtick still redact the value', () => {
  assert.equal(red(`| password | hunter22secret${' '.repeat(20)}|`), `| password | ${S}${' '.repeat(20)}|`);
  assert.equal(red('| api_key | `sk1-abcdef` |'), `| api_key | \`${S}\` |`);
  assert.equal(red('| api_key | abcdef12   `  |'), `| api_key | ${S}   \`  |`);
});
