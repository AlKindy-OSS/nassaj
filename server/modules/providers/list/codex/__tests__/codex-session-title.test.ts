/**
 * B-1668 item 3 (Codex): a rollout is named after the first REAL user prompt,
 * never the assistant's `last_agent_message`. Record shapes follow a live
 * rollout: developer instructions, then a user-role record that is only the
 * AGENTS.md + environment_context envelope, then the human's prompt.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-title-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

const { initializeDatabase, closeConnection, sessionsDb } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('@/services/provider-sharing.js');
const { operatorCodexHome } = await import('@/modules/providers/list/codex/codex-home.js');
const { CodexSessionSynchronizer } = await import(
  '@/modules/providers/list/codex/codex-session-synchronizer.provider.js'
);

await initializeDatabase();
_resetProviderSharingCache();
setProviderSharingConfig({ claude: 'isolated', codex: 'shared', agy: 'shared', cursor: 'shared' });

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const CWD = '/workspace/codex-title';
const userItem = (...texts: string[]) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) },
});
const ENVELOPE = userItem(
  '# AGENTS.md instructions for /workspace/codex-title\n\n<INSTRUCTIONS>\nRules…\n</INSTRUCTIONS>',
  '<environment_context>\n  <cwd>/workspace/codex-title</cwd>\n</environment_context>',
);
const TASK_COMPLETE = {
  type: 'event_msg',
  payload: { type: 'task_complete', last_agent_message: '**Done.** I changed three files.' },
};

function writeRollout(sessionId: string, records: unknown[]): void {
  const dir = path.join(operatorCodexHome(), 'sessions', '2026', '10', '17');
  fs.mkdirSync(dir, { recursive: true });
  const meta = { type: 'session_meta', payload: { id: sessionId, cwd: CWD, session_id: sessionId, thread_source: 'user' } };
  const lines = [meta, ...records].map((record) => JSON.stringify(record)).join('\n');
  fs.writeFileSync(path.join(dir, `rollout-2026-10-17T10-00-00-${sessionId}.jsonl`), `${lines}\n`);
}

describe('Codex session titles', () => {
  it('skips the AGENTS/environment envelope and never uses the assistant reply', async () => {
    const id = '00000000-0000-7000-8000-000000000001';
    writeRollout(id, [
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev' }] } },
      ENVELOPE,
      userItem('تابع من حيث توقفنا: الدخول الموحّد'),
      TASK_COMPLETE,
    ]);
    await new CodexSessionSynchronizer().synchronize();
    assert.equal(sessionsDb.getSessionById(id)?.custom_name, 'تابع من حيث توقفنا: الدخول الموحّد');
  });

  it('takes a plain event_msg user_message when it comes first', async () => {
    const id = '00000000-0000-7000-8000-000000000002';
    writeRollout(id, [{ type: 'event_msg', payload: { type: 'user_message', message: 'fix the sidebar' } }, TASK_COMPLETE]);
    await new CodexSessionSynchronizer().synchronize();
    assert.equal(sessionsDb.getSessionById(id)?.custom_name, 'fix the sidebar');
  });

  it('keeps a user rename and re-derives a stored placeholder', async () => {
    const id = '00000000-0000-7000-8000-000000000003';
    writeRollout(id, [ENVELOPE, userItem('the prompt'), TASK_COMPLETE]);
    const sync = new CodexSessionSynchronizer();
    await sync.synchronize();
    sessionsDb.updateSessionCustomName(id, 'my rename');
    await sync.synchronize();
    assert.equal(sessionsDb.getSessionById(id)?.custom_name, 'my rename');

    sessionsDb.updateSessionCustomName(id, 'Untitled Codex Session');
    await sync.synchronize();
    assert.equal(sessionsDb.getSessionById(id)?.custom_name, 'the prompt');
  });

  it('stays a placeholder when the head holds no user text yet', async () => {
    const id = '00000000-0000-7000-8000-000000000004';
    writeRollout(id, [ENVELOPE, TASK_COMPLETE]);
    await new CodexSessionSynchronizer().synchronize();
    assert.equal(sessionsDb.getSessionById(id)?.custom_name, 'Untitled Codex Session');
  });
});
