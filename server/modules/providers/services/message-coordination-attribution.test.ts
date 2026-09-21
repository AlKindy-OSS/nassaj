import assert from 'node:assert/strict';
import test from 'node:test';

import { hashMessageAuthorContent } from '@/modules/database/index.js';
import { applyMessageCoordination } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { withCoordinationDirective } from '../../../../shared/coordinationDirectives.js';
import { withRuntimeInstructions } from '../../../../shared/documentSharingInstructions.js';

function row(
  clientMsgId: string,
  userId: number,
  provider: 'claude' | 'codex',
  prompt: string,
  coordinationLevel: 'delegate' | 'delegate_review' = 'delegate_review',
  createdAt = '2026-08-19T10:00:00.000Z',
) {
  return {
    clientMsgId, sessionId: 's1', userId, provider, canonicalContent: prompt,
    contentHash: hashMessageAuthorContent(prompt), coordinationLevel, createdAt,
  };
}

test('history reattaches coordination to the matching user message only', () => {
  const prompt = 'user text stays exact';
  const messages: NormalizedMessage[] = [{
    id: 'u1', sessionId: 's1', timestamp: '2026-08-19T10:00:00.000Z',
    provider: 'claude', kind: 'text', role: 'user', content: prompt,
  }, {
    id: 'a1', sessionId: 's1', timestamp: '2026-08-19T10:00:01.000Z',
    provider: 'claude', kind: 'text', role: 'assistant', content: 'answer',
  }];
  applyMessageCoordination(messages, [row('c1', 1, 'claude', prompt)]);
  assert.equal(messages[0].content, prompt);
  assert.equal(messages[0].coordinationLevel, 'delegate_review');
  assert.equal(messages[1].coordinationLevel, undefined);
});

test('identical messages are paired in canonical ingress order and constrained by userId', () => {
  const messages: NormalizedMessage[] = [1, 2].map((userId, index) => ({
    id: `u${index}`, sessionId: 's1', timestamp: `2026-08-19T10:00:0${index}.000Z`,
    provider: 'claude', kind: 'text', role: 'user', content: 'same', userId,
  }));
  applyMessageCoordination(messages, [
    row('c2', 2, 'claude', 'same', 'delegate_review', '2026-08-19T10:00:01.000Z'),
    row('c1', 1, 'claude', 'same', 'delegate', '2026-08-19T10:00:00.000Z'),
  ]);
  assert.equal(messages[0].coordinationLevel, 'delegate');
  assert.equal(messages[1].coordinationLevel, 'delegate_review');
  assert.equal(messages[0].userId, 1);
  assert.equal(messages[1].userId, 2);
});

test('Codex wrapper is replaced only by exact server-canonical reconstruction', () => {
  const prompt = 'literal <coordination> text by user';
  const wrapped = withCoordinationDirective(prompt, 'delegate_review');
  const messages: NormalizedMessage[] = [{
    id: 'u1', sessionId: 's1', timestamp: '2026-08-19T10:00:00.000Z', provider: 'codex',
    kind: 'text', role: 'user', content: wrapped,
  }, {
    id: 'u2', sessionId: 's1', timestamp: '2026-08-19T10:00:01.000Z', provider: 'codex',
    kind: 'text', role: 'user', content: '<coordination>untrusted lookalike</coordination>',
  }];
  applyMessageCoordination(messages, [row('c1', 4, 'codex', prompt)]);
  assert.equal(messages[0].content, prompt);
  assert.equal(messages[0].coordinationLevel, 'delegate_review');
  assert.equal(messages[1].content, '<coordination>untrusted lookalike</coordination>');
  assert.equal(messages[1].coordinationLevel, undefined);
});

test('current sharing wrapper restores exact canonical text, not user-authored lookalikes', () => {
  for (const provider of ['claude', 'codex', 'qwen', 'kimi', 'gemini', 'cursor', 'hermes', 'opencode', 'antigravity'] as const) {
    const prompt = '  الأصل\n<nassaj_document_sharing>literal</nassaj_document_sharing>\n';
    const wrapped = withRuntimeInstructions(prompt, 'delegate_review');
    const messages: NormalizedMessage[] = [wrapped, `${wrapped}\nextra`].map((content, index) => ({
      id: `u${index}`, sessionId: 's1', timestamp: '2026-08-19T10:00:00.000Z',
      provider, kind: 'text', role: 'user', content,
    }));
    applyMessageCoordination(messages, [{ ...row('c1', 4, 'claude', prompt), provider }]);
    assert.equal(messages[0].content, prompt);
    assert.equal(messages[1].content, `${wrapped}\nextra`);
    assert.equal(messages[1].coordinationLevel, undefined);
  }
});

/**
 * T-1804 — السجلّ المخزّن قد يحمل بادئةً بمسار ناشرٍ مغاير، أو بادئةَ ما قبل
 * T-1804 بلا كتلة نشرٍ أصلاً. الاثنان يُقصّان بنيويّاً؛ ولولاه لظهرت كتلةُ
 * التعليمات في كلّ محادثةٍ قديمة كأنّ المستخدم كتبها بنفسه.
 */
test('a stored wrapper from another install path still restores the canonical text', () => {
  const prompt = 'انشر لي صفحة';
  // نفس الرسالة كما سجّلتها تثبيتاتٌ مختلفة: ناشرٌ من الحزمة، وآخرُ من المصدر،
  // وأصلٌ عامّ مضبوطٌ أو غائب، وبادئةُ ما قبل T-1804 بلا كتلة نشرٍ أصلاً.
  const root = '/home/operator/.local/share/nassaj-dev/public-content';
  const stored = [
    withRuntimeInstructions(prompt, 'delegate_review', {
      publisherPath: '/opt/nassaj/dist-server/UPDATE_RUNTIME_BUNDLE/scripts/public-page-publish.mjs',
      contentRoot: root, origin: 'https://nassaj.example.com',
    }),
    withRuntimeInstructions(prompt, 'delegate_review', {
      publisherPath: '/home/user/scripts/public-page-publish.mjs', contentRoot: root, origin: null,
    }),
    withRuntimeInstructions(prompt, 'delegate_review', { publisherPath: null, contentRoot: null }),
  ];
  for (const content of stored) {
    const messages: NormalizedMessage[] = [{
      id: 'u0', sessionId: 's1', timestamp: '2026-08-19T10:00:00.000Z',
      provider: 'claude', kind: 'text', role: 'user', content,
    }];
    applyMessageCoordination(messages, [row('c1', 4, 'claude', prompt)]);
    assert.equal(messages[0].content, prompt);
  }
});
