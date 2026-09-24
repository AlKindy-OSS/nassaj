import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatMessage } from '../../types/types';

import { getRunningActivityGap } from './runningActivityGap';

const BASE_TIME = 1_700_000_000_000;

const userMessage = (id = 'user'): ChatMessage => ({
  id,
  type: 'user',
  content: 'hello',
  isToolUse: false,
  timestamp: new Date(BASE_TIME),
} as unknown as ChatMessage);

const toolMessage = (id: string, offset: number): ChatMessage => ({
  id,
  type: 'assistant',
  content: '',
  isToolUse: true,
  toolName: 'Read',
  toolId: id,
  timestamp: new Date(BASE_TIME + offset),
} as unknown as ChatMessage);

describe('getRunningActivityGap', () => {
  it('يظهر أثناء بث أداة مخفية ويحتفظ بأحدث نشاط', () => {
    assert.deepEqual(
      getRunningActivityGap([userMessage(), toolMessage('one', 100), toolMessage('two', 400)], true, false),
      { visible: true, lastActivityAt: BASE_TIME + 400 },
    );
  });

  it('يختفي عند توقف البث أو ظهور الأدوات', () => {
    const messages = [userMessage(), toolMessage('one', 100)];
    assert.equal(getRunningActivityGap(messages, false, false).visible, false);
    assert.equal(getRunningActivityGap(messages, true, true).visible, false);
  });

  it('يختفي فور ظهور نص مساعد حقيقي ولا يختفي للتفكير أو الفراغ', () => {
    const tool = toolMessage('one', 100);
    const text = { id: 'answer', type: 'assistant', content: 'done', timestamp: new Date(BASE_TIME + 200) } as ChatMessage;
    const thinking = { ...text, id: 'thinking', content: 'thinking', isThinking: true } as ChatMessage;
    const blank = { ...text, id: 'blank', content: '   ' } as ChatMessage;
    assert.equal(getRunningActivityGap([userMessage(), tool, text], true, false).visible, false);
    assert.equal(getRunningActivityGap([userMessage(), tool, thinking], true, false).visible, true);
    assert.equal(getRunningActivityGap([userMessage(), tool, blank], true, false).visible, true);
  });

  it('يحصر الفحص بعد آخر رسالة بشرية ويقرأ نشاط الوكيل الفرعي', () => {
    const parent = {
      ...toolMessage('parent', 100),
      subagentState: { childTools: [{ id: 'child', timestamp: new Date(BASE_TIME + 900) }] },
    } as unknown as ChatMessage;
    assert.deepEqual(getRunningActivityGap([userMessage(), parent], true, false), {
      visible: true,
      lastActivityAt: BASE_TIME + 900,
    });
    assert.equal(
      getRunningActivityGap([userMessage(), toolMessage('old', 100), userMessage('new')], true, false).visible,
      false,
    );
  });

  it('لا يحول الطابع الفاسد إلى نشاط', () => {
    const invalid = { ...toolMessage('bad', 0), timestamp: 'not-a-date' } as unknown as ChatMessage;
    assert.deepEqual(getRunningActivityGap([userMessage(), invalid], true, false), {
      visible: false,
      lastActivityAt: null,
    });
  });
});
