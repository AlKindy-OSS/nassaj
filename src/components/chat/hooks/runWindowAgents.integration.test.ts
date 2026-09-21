/**
 * B-208 (بند 7) — اختبار تكامل على fixture اصطناعي ممثل لبنية نافذة التشغيل.
 *
 * ما يثبته:
 *   - النافذة الحالية (20 صفاً خاماً) لا تبلغ آخر صفّ `Agent` ⇒ `agents: []`
 *     ⇒ البطاقة تنهار إلى `ClaudeStatus` بلا أي صفّ وكيل. **هذا هو العطل.**
 *   - النافذة المُوسَّعة تحقّق الشرطين الملزمين:
 *       (أ) كل صفّ `Agent` فيها يحمل نتيجته ⇒ لا وكيل منتهٍ يُوسَم «running».
 *       (ب) تبلغ فعلاً ما قبل آخر مطالبة بشرية ⇒ `boundaryIndex` لا يسقط إلى -1
 *           ⇒ لا تُحتسب وكلاء الجولة السابقة.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { describe, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';

import { SYNTHETIC_RUN_WINDOW } from './__fixtures__/run-window.synthetic';
import { normalizedToChatMessages } from './useChatMessages';
import { useRunProgress } from './useRunProgress';

const REPRESENTATIVE_WINDOW = SYNTHETIC_RUN_WINDOW as NormalizedMessage[];

/** النافذة الحالية في الإنتاج: `limit=20&offset=0` (ذيل السجلّ). */
const NARROW_WINDOW_SIZE = 20;
const NARROW_WINDOW = REPRESENTATIVE_WINDOW.slice(-NARROW_WINDOW_SIZE);

function progressFor(window: NormalizedMessage[]) {
  const chatMessages = normalizedToChatMessages(window);
  const { result } = renderHook(() => useRunProgress(chatMessages, true));
  return { chatMessages, progress: result.current };
}

/** حدّ الجولة كما يحسبه useRunProgress: آخر مطالبة بشرية حقيقية. */
function hasHumanBoundary(chatMessages: ChatMessage[]): boolean {
  return chatMessages.some((m) => m.type === 'user' && !m.isToolUse && !m.originKind);
}

describe('نافذة جلب الجلسة النشطة — عينة اصطناعية ممثلة', () => {
  it('الـfixture فعلاً من نوع الحالة المعطوبة: آخر صفّ Agent خارج نافذة الـ20', () => {
    const agentRows = REPRESENTATIVE_WINDOW
      .map((m, i) => ({ i, m }))
      .filter(({ m }) => m.kind === 'tool_use' && (m.toolName === 'Agent' || m.toolName === 'Task'));

    assert.ok(agentRows.length > 0, 'الـfixture بلا صفوف وكلاء — لا يختبر شيئاً');
    const lastAgentIndex = agentRows.at(-1)!.i;
    // النافذة الضيّقة هي الفهارس [length - 20 .. length - 1]؛ الشرط الحاسم أن
    // يقع آخر صفّ وكيل **دونها** (لا مقارنة على حدّ السكّين بمسافة تساوي 20).
    const narrowWindowStart = REPRESENTATIVE_WINDOW.length - NARROW_WINDOW_SIZE;
    assert.ok(
      lastAgentIndex < narrowWindowStart,
      `آخر صفّ Agent عند ${lastAgentIndex} وبداية النافذة ${narrowWindowStart} — الحالة غير معطوبة أصلاً`,
    );
  });

  it('العطل: النافذة الحالية (20 صفاً) ⇒ لا صفوف وكلاء ولا حدّ جولة', () => {
    const { chatMessages, progress } = progressFor(NARROW_WINDOW);

    assert.equal(progress.agents.length, 0, 'النافذة الضيّقة أظهرت وكلاء — الحالة تغيّرت');
    assert.equal(progress.agentsTotal, 0);
    assert.equal(
      hasHumanBoundary(chatMessages),
      false,
      'النافذة الضيّقة تحوي حدّ الجولة — لم نعد نعيد إنتاج العطل',
    );
  });

  it('الإصلاح: النافذة المُوسَّعة تُظهر الوكلاء بأسمائهم', () => {
    const { progress } = progressFor(REPRESENTATIVE_WINDOW);

    assert.equal(progress.agents.length, 9, 'عدد الوكلاء في العينة تغيّر');
    assert.equal(progress.agentsTotal, 9);

    const types = progress.agents.map((a) => a.type);
    // أنواع ممثلة تعبر مسار المكوّن نفسه.
    assert.deepEqual(
      [...new Set(types)].sort(),
      ['backend-dev', 'frontend-dev', 'qa-critic'],
    );
    for (const agent of progress.agents) {
      assert.ok(agent.id, 'صفّ وكيل بلا معرّف — مفتاح React غير مستقر');
      assert.notEqual(agent.type, 'Agent', 'اسم الوكيل ارتدّ إلى القيمة الاحتياطية');
    }
  });

  it('الشرط (أ): كل صفّ Agent في النافذة يحمل نتيجته ⇒ لا منتهٍ يُوسَم «running»', () => {
    const { chatMessages, progress } = progressFor(REPRESENTATIVE_WINDOW);

    const containers = chatMessages.filter(
      (m) => m.isToolUse && (m.toolName === 'Agent' || m.toolName === 'Task'),
    );
    assert.equal(containers.length, 9);
    for (const container of containers) {
      assert.ok(
        container.toolResult,
        `صفّ الوكيل ${container.toolId} بلا نتيجة داخل النافذة`,
      );
    }
    assert.equal(
      progress.agents.filter((a) => a.status === 'running').length,
      0,
      'وكيل منتهٍ وُسم «running» — النافذة قطعت صفوف النتائج',
    );
    assert.equal(progress.agentsDone, 9);
  });

  it('الشرط (ب): النافذة المُوسَّعة تبلغ ما قبل آخر مطالبة بشرية', () => {
    const { chatMessages } = progressFor(REPRESENTATIVE_WINDOW);

    assert.equal(
      hasHumanBoundary(chatMessages),
      true,
      'لا حدّ جولة داخل النافذة ⇒ boundaryIndex = -1 ⇒ خطر احتساب جولة سابقة',
    );

    // الوكلاء التسعة كلهم بعد الحدّ (لا تلوّث بجولة سابقة).
    const boundaryIndex = chatMessages.reduce(
      (last, m, i) => (m.type === 'user' && !m.isToolUse && !m.originKind ? i : last),
      -1,
    );
    const containersAfterBoundary = chatMessages.filter(
      (m, i) => i > boundaryIndex && m.isToolUse && (m.toolName === 'Agent' || m.toolName === 'Task'),
    );
    assert.equal(containersAfterBoundary.length, 9);
  });

  it('صدق العرض (بند 8): عدّاد الاستدعاءات المعروض مشتقّ من childTools الحقيقية', () => {
    const { progress } = progressFor(REPRESENTATIVE_WINDOW);

    for (const agent of progress.agents) {
      // كل وكيل منتهٍ في العينة يحمل أداةً فرعية ⇒ عدّاد معروف > 0.
      assert.ok(
        agent.callCount > 0,
        `الوكيل ${agent.type} بعدّاد صفر رغم وجود مجموع التاريخ`,
      );
      assert.equal(agent.callCount, agent.childTools?.length ?? 0);
      // وكيل منتهٍ لا يعرض «الأداة الجارية».
      assert.equal(agent.currentTool, undefined);
    }
  });
});
