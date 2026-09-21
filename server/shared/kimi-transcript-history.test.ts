import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, 'kimi-history-'));
after(() => fs.rm(root, { recursive: true, force: true }));
mock.method(os, 'homedir', () => root);
mock.module('@/modules/session-workspaces/index.js', { namedExports: { logicalProjectPathForWorkspace: (value: string) => value } });
mock.module('@/modules/database/index.js', { namedExports: { sessionsDb: { getSessionById: () => null } } });
mock.module('@/shared/utils.js', { namedExports: { normalizeSessionName: (value: string) => value, sanitizeLeafDirectoryName: (value: string) => { if (!/^[a-z0-9-]+$/.test(value))
            throw Error('bad leaf'); return value; }, createNormalizedMessage: (value: unknown) => value, readObjectRecord: (value: unknown) => value && typeof value === 'object' ? value : null } });
const { appendVendorTranscriptEventIdempotent } = await import('../modules/providers/shared/vendor/vendor-transcript.js');
const { VendorSessionsProvider } = await import('../modules/providers/shared/vendor/vendor-sessions.provider.js');
const { persistKimiTranscriptFinal } = await import('./kimi-transcript-final.js');
test('real Kimi writer/read-back preserves ordered tool blocks and exact final identity across separate member sessions', async () => {
    const reader = new VendorSessionsProvider({ provider: 'kimi' });
    for (const userId of [7, 8]) {
        const sessionId = `member-${userId}`;
        const projectPath = path.join(root, `project-${userId}`);
        const id = await persistKimiTranscriptFinal({ sessionId, userId, messages: [{ role: 'user', content: `question-${userId}` }, { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-one', name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-one', content: 'fixture-output' }] }], assistantBlocks: [{ type: 'text', text: `answer-${userId}` }], succeeded: true }, (event: any, key: string) => appendVendorTranscriptEventIdempotent('kimi', sessionId, projectPath, event, key));
        assert.ok(id);
        const first = await reader.fetchHistory(sessionId, { projectPath });
        const second = await reader.fetchHistory(sessionId, { projectPath });
        assert.deepEqual(first, second);
        assert.ok(first.messages.some((message: any) => message.kind === 'tool_use'));
        const final = first.messages.find((message: any) => message.id === id);
        assert.equal(final?.content, `answer-${userId}`);
        assert.equal(final?.isFinalAnswer, true);
        assert.equal(first.messages.some((message: any) => message.content === `answer-${userId === 7 ? 8 : 7}`), false);
    }
});
