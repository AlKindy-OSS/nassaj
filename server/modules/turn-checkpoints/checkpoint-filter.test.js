import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHECKPOINT_LIMITS,
  classifyCheckpointPath,
  classifyCheckpointStat,
  inspectCheckpointContent,
} from './checkpoint-filter.js';

// Provider-shaped values are assembled at runtime so this source never holds a usable-looking key.
const join = (...parts) => parts.join('');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANTHROPIC = join('sk-', 'ant-', 'api03-', 'Zq9XwPr7Lm2N' + 'b5Vc8Kd3Ht6Fg1Js4Ay0Qe');
const GITHUB = join('gh', 'p_', 'A1b2C3d4E5f6G7h8I9', 'j0K1l2M3n4O5p6Q7r8');
const AWS = join('AK', 'IA', 'Q3EGRDX4ZT7NWPLM');
const JWT = join('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'c2lnbmF0dXJlLXZhbHVlLXNpZ25hdHVyZQ');

test('every always-deny path pattern is withheld regardless of .gitignore', () => {
  const denied = [
    '.env', 'app/.env', '.env.local', '.env.production', 'cert.pem', 'tls/server.key', 'store.p12',
    'store.pfx', 'keystore.jks', 'release.keystore', 'vault.kdbx', 'id_rsa', 'id_rsa.pub', 'home/id_ed25519',
    'id_ecdsa_sk', '.ssh/config', 'a/.ssh/known_hosts', '.gnupg/pubring.kbx', '.aws/credentials',
    '.aws/config', '.docker/config.json', 'x/.docker/config.json', '.npmrc', '.pypirc', '.netrc',
    '.git-credentials', 'gcp-credentials.yaml', 'client_secret.json', 'my-secret.txt', 'secrets.yaml',
    'service-account-prod.json', 'service-account.json', '.credentials.json', 'terraform.tfstate',
    'terraform.tfstate.backup', 'auth-token.txt', 'api_key.txt', 'Password.ini',
  ];
  for (const candidate of denied) assert.equal(classifyCheckpointPath(candidate), 'denied_path', candidate);
});

test('ordinary source paths are allowed', () => {
  for (const candidate of ['src/a.ts', 'README.md', 'package.json', 'docs/env.md', 'keys.ts',
    'monkey.ts', 'tokens.ts', '.docker/Dockerfile', 'environment.ts', 'src/.envrc.example.md', 'token-utils.ts',
    'server/services/secret-patterns.js', 'credentials.service.ts', 'api-key-form.tsx', 'CREDENTIALS.md',
    'docs/secret-handling.md', 'password-reset.tsx']) {
    assert.equal(classifyCheckpointPath(candidate), null, candidate);
  }
});

test('stat gate: hardlinks, oversize files and special nodes are withheld', () => {
  const file = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 10 };
  assert.equal(classifyCheckpointStat(file), null);
  assert.equal(classifyCheckpointStat({ ...file, nlink: 2 }), 'hardlink');
  assert.equal(classifyCheckpointStat({ ...file, size: CHECKPOINT_LIMITS.fileBytes + 1 }), 'too_large');
  assert.equal(classifyCheckpointStat({ ...file, size: CHECKPOINT_LIMITS.fileBytes }), null);
  assert.equal(classifyCheckpointStat({ ...file, isFile: () => false }), 'special');
  const link = { isFile: () => false, isSymbolicLink: () => true, nlink: 1, size: 5 };
  assert.equal(classifyCheckpointStat(link), null);
});

test('limits match the approved design', () => {
  assert.equal(CHECKPOINT_LIMITS.fileBytes, 1024 * 1024);
  assert.equal(CHECKPOINT_LIMITS.checkpointBytes, 20 * 1024 * 1024);
  assert.equal(CHECKPOINT_LIMITS.checkpointPaths, 5000);
});

test('secret corpus in real formats is withheld', () => {
  const corpus = {
    yaml: `database:\n  host: db\n  password: ${join('cGFz', 'c3dvcmQ=')}\n`,
    json: `{"name":"x","token":"${GITHUB}"}\n`,
    ini: `[default]\naws_access_key_id = ${AWS}\naws_secret_access_key = abcd\n`,
    url: `DATABASE=${join('postgres', '://', 'admin:', 'hunter2pass', '@db.internal:5432/app')}\n`,
    anthropic: `const key = "${ANTHROPIC}";\n`,
    github: `export const t = '${GITHUB}';\n`,
    aws: `id: ${AWS}\n`,
    jwt: `Authorization: ${JWT}\n`,
    pem: join('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA ', 'PRIVATE KEY-----\n'),
    openssh: join('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH ', 'PRIVATE KEY-----\n'),
    entropy: `blob = ${join('Qm9vVr7Lp2Xc' + '8Kd3Ht6Fg1Js4Ay0QeW', 'x5ZbN9')}\n`,
  };
  for (const [label, text] of Object.entries(corpus)) {
    const file = { yaml: 'config/database.yaml', json: 'config/app.json', ini: 'settings.ini' }[label] ?? 'src/notes.ts';
    assert.equal(inspectCheckpointContent(Buffer.from(text), file), 'secret_content', label);
  }
});

test('ordinary text, SHAs, UUIDs and SRI hashes are captured', () => {
  const clean = [
    'export function add(a, b) { return a + b; }\n',
    'commit 4ff126ad1c2b3d4e5f60718293a4b5c6d7e8f901\n',
    'id: 0b8f6a1e-3c2d-4e5f-8a9b-1c2d3e4f5a6b\n',
    '"integrity": "sha512-Zq9XwPr7Lm2N' + 'b5Vc8Kd3Ht6Fg1Js4Ay0QeWx5ZbN9Zq9XwPr7Lm2N' + 'b5Vc8Kd3Ht6Fg1Js4Ay0QeWx5ZbN9Q=="\n',
    '',
  ];
  for (const text of clean) assert.equal(inspectCheckpointContent(Buffer.from(text)), null, text);
});

test('binary: known secret containers are denied outright', () => {
  const sqlite = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(32)]);
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]);
  const pkcs12 = Buffer.concat([Buffer.from([0x30, 0x82, 0x0a, 0x10, 0x02, 0x01, 0x03]), Buffer.alloc(32)]);
  for (const [label, body] of Object.entries({ sqlite, zip, pkcs12 })) {
    assert.equal(inspectCheckpointContent(body), 'secret_container', label);
  }
});

test('binary: other binaries pass only when their extracted strings are clean', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), Buffer.from('IHDR plain image data')]);
  assert.equal(inspectCheckpointContent(png), null);
  const dirty = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]), Buffer.from(`key=${ANTHROPIC}`)]);
  assert.equal(inspectCheckpointContent(dirty), 'secret_content');
});

test('display-only patterns in ordinary source are not a capture gate (H1)', () => {
  const source = [
    "const headers = { Authorization: `Bearer ${token}` };\n",
    'const password = req.body.password;\nconst token = await issueToken(user);\n',
    '| Name | Token |\n| --- | --- |\n| api | value-from-env |\n',
    '{"password": "", "token": "${TOKEN}", "secret": "<your-secret>"}\n',
    `fetch(${join('"https://user:', '${password}', '@host/x"')});\n`,
    `const url = ${join('"postgres://app:', 'password', '@localhost:5432/db"')};\n`,
    'Licensed under the Apache License, Version 2.0 (the "License");\n',
  ];
  for (const text of source) assert.equal(inspectCheckpointContent(Buffer.from(text), 'src/x.ts'), null, text);
});

test('real repository: at most 1% of tracked files are withheld by name or content (H1)', () => {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean);
  const withheld = [];
  for (const relative of files) {
    const reason = classifyCheckpointPath(relative) ?? contentReason(path.join(root, relative), relative);
    if (reason) withheld.push(`${reason} ${relative}`);
  }
  const share = (withheld.length / files.length) * 100;
  console.log(`[H1] withheld ${withheld.length}/${files.length} = ${share.toFixed(2)}%`);
  for (const entry of withheld) console.log(`[H1]   ${entry}`);
  assert.ok(share <= 1, `withheld share ${share.toFixed(2)}% exceeds 1%`);
  for (const relative of ['README.md', 'LICENSE', 'package.json', 'server/routes/git.js']) {
    assert.equal(withheld.some((entry) => entry.endsWith(` ${relative}`)), false, relative);
  }
});

test('round 2: config credentials anywhere on a line, in every common config form', () => {
  const cases = [
    ['docker-compose.yml', 'services:\n  db:\n    environment:\n      - POSTGRES_PASSWORD=Sup3rSecret1\n'],
    ['values.yaml', 'users:\n  - name: app\n  - password: hunterhuntertwo\n'],
    ['values.yaml', 'db: { host: pg, password: correcthorsebattery }\n'],
    ['config.json', '{"db":{"host":"pg","password":"plainAlphabeticSecret"}}\n'],
    ['appsettings.json', '{"ConnectionStrings":{"Main":"Server=db;User Id=app;Password=Tr0ub4dor;"}}\n'],
    ['settings.ini', '[db]\npassword = onlyletterssecret\n'],
  ];
  for (const [file, text] of cases) assert.equal(inspectCheckpointContent(Buffer.from(text), file), 'secret_content', text);
});

test('round 2: placeholders and non-secret names in config files stay captured', () => {
  const cases = [
    ['docker-compose.yml', '    environment:\n      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}\n'],
    ['values.yaml', 'password: changeme\ntoken: xxx\nsecret: <your-secret>\napiKey: ""\n'],
    ['config.json', '{"db":{"password":""},"token":"${TOKEN}"}\n'],
    ['model.yaml', 'tokenizer: cl100k_base\nsecretName: tls-cert-2024\napi_key_env: OPENAI_API_KEY2\n'],
    ['config.json', '{"maxTokens": 4096, "tokenizer": "cl100k_base", "passwordPolicy": "strong"}\n'],
  ];
  for (const [file, text] of cases) assert.equal(inspectCheckpointContent(Buffer.from(text), file), null, text);
});

function contentReason(absolute, relative) {
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { return null; }
  if (!stat.isFile() || stat.size > CHECKPOINT_LIMITS.fileBytes) return null;
  return inspectCheckpointContent(fs.readFileSync(absolute), relative);
}
