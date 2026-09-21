import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { VendorSessionsProvider } from './vendor-sessions.provider.js';

const projectRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const source = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor-transcript.ts')).href;

function child(home: string, eventId: string): Promise<void> {
  const script = `
    import os from 'node:os';
    os.homedir = () => ${JSON.stringify(home)};
    const { appendVendorTranscriptTurnIdempotent } = await import(${JSON.stringify(source)});
    await appendVendorTranscriptTurnIdempotent('kimi', 'session', '/project', 'assistant', 'answer', ${JSON.stringify(eventId)});
  `;
  return new Promise((resolve, reject) => {
    const childProcess = spawn(globalThis.process.execPath, ['--import', path.join(projectRoot, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', script], {
      env: { ...globalThis.process.env, TSX_TSCONFIG_PATH: path.join(projectRoot, 'server/tsconfig.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    childProcess.stderr.on('data', (chunk) => { stderr += String(chunk); });
    childProcess.on('error', reject);
    childProcess.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child ${code}`)));
  });
}

test('multiprocess append repairs a partial tail and commits an eventId once', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vendor-transcript-mp-'));
  const projectHash = createHash('md5').update('/project').digest('hex');
  const file = path.join(home, '.nassaj-vendor-sessions', 'kimi', projectHash, 'session.jsonl');
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"partial":');
    await Promise.all([child(home, 'event-1'), child(home, 'event-1')]);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      type: 'message', eventId: 'event-1', message: { id: 'event-1', role: 'assistant', content: 'answer' },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('history reader deduplicates repeated eventIds and skips a partial JSON line', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vendor-reader-dedupe-'));
  t.mock.method(os, 'homedir', () => home);
  const projectHash = createHash('md5').update('/project').digest('hex');
  const file = path.join(home, '.nassaj-vendor-sessions', 'kimi', projectHash, 'session.jsonl');
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const event = JSON.stringify({
      type: 'message', eventId: 'same', message: { role: 'assistant', content: 'once' },
    });
    await writeFile(file, `${event}\n${event}\n{"partial":`);
    const history = await new VendorSessionsProvider({ provider: 'kimi' }).fetchHistory(
      'session', { projectPath: '/project' },
    );
    assert.equal(history.total, 1);
    assert.equal(history.messages[0]?.content, 'once');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
