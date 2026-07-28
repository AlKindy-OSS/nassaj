/**
 * B-RTL-TOOLS — شجرة عارضات الأدوات بلا سِمة اتجاه واحدة.
 *
 * القياس: `grep -rn 'dir=' src/components/chat/tools/` = صفر نتيجة عبر تسعة
 * مكوّنات محتوى. كل نصّ حرّ فيها (نصّ نتيجة، عنوان مهمة، بند todo، سؤال وخيار،
 * طلب وكيل فرعي) يرث اتجاه المستند مهما كانت لغته — فبند عربي داخل واجهة LTR
 * يُرسَم بترتيب مقلوب، والعكس.
 *
 * ما لا يُعالَج هنا عمداً: كتل `pre` للـjson/code — مثبَّتة LTR أصلاً في
 * `index.css` (`.nassaj-md pre` و`:root[dir=rtl] pre`)، وهي لاتينية بحكم البناء.
 *
 * كل مكوّن يُختبر باتجاهين (عربي ⇒ rtl، إنجليزي خالص ⇒ ltr): اتجاهٌ واحد
 * يمرّ على `dir="rtl"` مثبَّتة، وهي بالضبط العلّة التي يفترض الإصلاح إزالتها.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/tools/components/toolTree.bidi.test.tsx
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { TextContent } from './ContentRenderers/TextContent';
import { TaskListContent } from './ContentRenderers/TaskListContent';
import { QuestionAnswerContent } from './ContentRenderers/QuestionAnswerContent';
import TodoList from './ContentRenderers/TodoList';
import { SubagentContainer } from './SubagentContainer';

afterEach(cleanup);

/** أقرب سلف يحمل `dir` — الاتجاه الفعلي للنصّ لا مجرد وجود السِمة على عنصر ما. */
const dirOf = (el: Element | null): string | null => {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const dir = cur.getAttribute('dir');
    if (dir) return dir;
  }
  return null;
};

/** أعمق عنصر نصّه هو النصّ المطلوب — الأسلاف يشاركونه `textContent` نفسه. */
const findByText = (root: HTMLElement, text: string) => {
  const matches = Array.from(root.querySelectorAll('*')).filter((el) => el.textContent === text);
  return matches.length > 0 ? matches[matches.length - 1] : null;
};

describe('TextContent — النصّ الحرّ يحسم اتجاهه', () => {
  const arabic = 'فشل الاتصال بالعقدة المجاورة بعد ثلاث محاولات متتالية';

  it('format=plain يحمل dir محسوباً من محتواه', () => {
    const { container } = render(<TextContent content={arabic} />);
    expect(dirOf(container.firstElementChild)).toBe('rtl');
  });

  it('نصّ إنجليزي في نفس المكوّن يحسم ltr', () => {
    const { container } = render(<TextContent content="Connection refused after three retries" />);
    expect(dirOf(container.firstElementChild)).toBe('ltr');
  });

  it('json وcode تبقيان بلا dir — مثبَّتتان LTR في ورقة الأنماط', () => {
    const { container: json } = render(<TextContent content='{"a":1}' format="json" />);
    const { container: code } = render(<TextContent content="npm run build" format="code" />);
    expect(json.querySelector('pre')!.getAttribute('dir')).toBeNull();
    expect(code.querySelector('pre')!.getAttribute('dir')).toBeNull();
  });
});

describe('TaskListContent — عنوان المهمة يحسم اتجاهه بمعزل عن رقمها', () => {
  it('عنوان عربي داخل صفّ يبدأ برقم لاتيني يبقى rtl', () => {
    const subject = 'إصلاح اتجاهية فقاعة المحادثة';
    const { container } = render(
      <TaskListContent content={`#15. [in_progress] ${subject}`} />
    );
    expect(dirOf(findByText(container, subject))).toBe('rtl');
  });

  it('عنوان إنجليزي خالص في نفس الصفّ يحسم ltr', () => {
    const subject = 'Fix the drain guard before the next deploy';
    const { container } = render(
      <TaskListContent content={`#15. [in_progress] ${subject}`} />
    );
    expect(dirOf(findByText(container, subject))).toBe('ltr');
  });
});

describe('TodoList — بند المهمة يحسم اتجاهه', () => {
  it('بند عربي يحمل dir=rtl', () => {
    const content = 'مراجعة نتائج الاختبارات قبل الإغلاق';
    const { container } = render(
      <TodoList todos={[{ id: '1', content, status: 'in_progress' }]} />
    );
    expect(dirOf(findByText(container, content))).toBe('rtl');
  });

  it('بند إنجليزي خالص يحمل dir=ltr', () => {
    const content = 'Review the test output before closing the item';
    const { container } = render(
      <TodoList todos={[{ id: '1', content, status: 'in_progress' }]} />
    );
    expect(dirOf(findByText(container, content))).toBe('ltr');
  });
});

describe('QuestionAnswerContent — السؤال والخيارات نصّ حرّ', () => {
  const question = 'هل نرفع العلم على العقد كلها الآن؟';
  const label = 'نعم، على كل العقد';

  it('نصّ السؤال ونصّ الخيار المختار يحملان اتجاههما', () => {
    const { container } = render(
      <QuestionAnswerContent
        questions={[
          {
            header: 'Rollout',
            question,
            multiSelect: false,
            options: [{ label, description: 'مع مراقبة السجلّ لمدة ساعة' }],
          } as never,
        ]}
        answers={{ [question]: label }}
      />
    );
    expect(dirOf(findByText(container, question))).toBe('rtl');
    expect(dirOf(findByText(container, label))).toBe('rtl');
  });

  it('سؤال وخيار إنجليزيان خالصان يحسمان ltr', () => {
    const englishQuestion = 'Should we raise the flag on every node right now?';
    const englishLabel = 'Yes — roll out to every node';
    const { container } = render(
      <QuestionAnswerContent
        questions={[
          {
            header: 'Rollout',
            question: englishQuestion,
            multiSelect: false,
            options: [{ label: englishLabel, description: 'While watching the log for an hour' }],
          } as never,
        ]}
        answers={{ [englishQuestion]: englishLabel }}
      />
    );
    expect(dirOf(findByText(container, englishQuestion))).toBe('ltr');
    expect(dirOf(findByText(container, englishLabel))).toBe('ltr');
  });
});

describe('SubagentContainer — نصّ الطلب المُمرَّر للوكيل الفرعي', () => {
  it('طلب عربي يحمل dir=rtl', () => {
    const prompt = 'راجع ملفات الاتجاهية وأعد تقريراً بما وجدته من أعطال';
    const { container } = render(
      <SubagentContainer
        toolInput={{ subagent_type: 'frontend-dev', description: 'bidi audit', prompt }}
        subagentState={{ childTools: [], currentToolIndex: -1, isComplete: false }}
      />
    );
    expect(dirOf(findByText(container, prompt))).toBe('rtl');
  });

  it('طلب إنجليزي خالص يحمل dir=ltr', () => {
    const prompt = 'Audit the direction handling files and report every defect you find';
    const { container } = render(
      <SubagentContainer
        toolInput={{ subagent_type: 'frontend-dev', description: 'bidi audit', prompt }}
        subagentState={{ childTools: [], currentToolIndex: -1, isComplete: false }}
      />
    );
    expect(dirOf(findByText(container, prompt))).toBe('ltr');
  });
});
