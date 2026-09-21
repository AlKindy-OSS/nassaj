import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SessionRowStatusIndicator from './SessionRowStatusIndicator';
import { deriveSessionRowIndicatorState } from './sessionRowIndicatorState';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const STATES = ['question', 'frozen', 'running', 'orphan', 'error', 'done'] as const;

/** Plate tone per state — four semantic hues, never a raw palette value. */
const PLATE_TONE: Record<(typeof STATES)[number], string> = {
  question: 'bg-primary',
  frozen: 'bg-warning',
  running: 'bg-success',
  orphan: 'bg-warning',
  error: 'bg-danger',
  done: 'bg-success',
};

describe('SessionRowStatusIndicator', () => {
  it('يحافظ على أولوية question ثم terminal ثم frozen/running', () => {
    expect(deriveSessionRowIndicatorState('frozen', 'question', true)).toBe('question');
    expect(deriveSessionRowIndicatorState('frozen', 'error', true)).toBe('error');
    expect(deriveSessionRowIndicatorState('running', 'done', false)).toBe('done');
    expect(deriveSessionRowIndicatorState('running', null, false)).toBe('running');
    expect(deriveSessionRowIndicatorState(null, 'error', false)).toBe('error');
    expect(deriveSessionRowIndicatorState(null, 'done', false)).toBe('done');
  });

  it('يستعمل الورشة الجارية fallback واحداً ولا يرسم شيئاً للحالة الهادئة', () => {
    expect(deriveSessionRowIndicatorState(null, null, true)).toBe('running');
    expect(deriveSessionRowIndicatorState(null, null, false, true)).toBe('orphan');
    expect(deriveSessionRowIndicatorState(null, null, false)).toBeNull();
  });

  it.each([
    ['question', 'lucide-circle-help'],
    ['frozen', 'lucide-pause'],
    ['running', 'lucide-loader-circle'],
    ['orphan', 'lucide-unplug'],
    ['error', null],
    ['done', 'lucide-check'],
  ] as const)('يرسم %s في خانة 14px بوصف غير حي', (state, iconClass) => {
    const { container } = render(<SessionRowStatusIndicator state={state} />);
    const indicator = screen.getByRole('img', {
      name: `sessionProcessState.${state}Hint`,
    });

    // B-824: 10px (h-2.5) هو ما جعل الحالةَ زخرفةً لا إشارة. الخانة الآن 14px
    // — خطوة الأيقونة التي يستعملها دبّوس الصفّ نفسه.
    expect(indicator.classList.contains('h-3.5')).toBe(true);
    expect(indicator.classList.contains('w-3.5')).toBe(true);
    expect(indicator.classList.contains('h-2.5')).toBe(false);
    expect(indicator.classList.contains('absolute')).toBe(true);
    expect(indicator.classList.contains('-bottom-1')).toBe(true);
    expect(indicator.classList.contains('-end-1')).toBe(true);
    expect(indicator.getAttribute('role')).toBe('img');
    expect(indicator.getAttribute('title')).toBe(`sessionProcessState.${state}Hint`);
    expect(indicator.textContent).toBe(state === 'error' ? '!' : '');
    if (iconClass) expect(container.querySelector(`.${iconClass}`)).not.toBeNull();
  });

  it.each(STATES)('يمنح %s صحنـاً ممتلئاً بحلقة تفصله عمّا تحته', (state) => {
    render(<SessionRowStatusIndicator state={state} />);
    const plate = screen.getByRole('img', {
      name: `sessionProcessState.${state}Hint`,
    }).firstElementChild!;

    // كانت running وquestion وحدهما بلا صحن: مجرّد خطٍّ فوق شعار المزوّد.
    expect(plate.classList.contains(PLATE_TONE[state])).toBe(true);
    expect(plate.classList.contains('ring-2')).toBe(true);
    expect(plate.classList.contains('ring-card')).toBe(true);
  });

  it('لا يترك أي حجمٍ خامّ في المؤشّر (‏h-[7px]/h-[9px]/text-[8px])', () => {
    for (const state of STATES) {
      const { container, unmount } = render(<SessionRowStatusIndicator state={state} />);
      expect(container.innerHTML).not.toMatch(/h-\[\d+px\]|w-\[\d+px\]|text-\[8px\]/);
      unmount();
    }
  });

  it('يستعمل دوراناً آمناً للحركة في running بلا pulse، وقياس الأيقونة 10px', () => {
    const { rerender } = render(<SessionRowStatusIndicator state="running" />);
    const running = screen.getByLabelText('sessionProcessState.runningHint');
    const loader = running.querySelector('.lucide-loader-circle');
    expect(loader?.classList.contains('motion-safe:animate-spin')).toBe(true);
    expect(loader?.classList.contains('h-2.5')).toBe(true);
    expect(loader?.classList.contains('w-2.5')).toBe(true);
    expect(loader?.classList.contains('motion-reduce:animate-none')).toBe(true);
    expect(loader?.classList.contains('motion-safe:animate-pulse')).toBe(false);

    rerender(<SessionRowStatusIndicator state="done" />);
    expect(screen.getByLabelText('sessionProcessState.doneHint').querySelector('.animate-pulse')).toBeNull();
  });

  it('يفصل running عن done بالصورة لا بالحركة وحدها', () => {
    const { rerender } = render(<SessionRowStatusIndicator state="running" />);
    const running = screen.getByLabelText('sessionProcessState.runningHint');
    expect(running.querySelector('.lucide-loader-circle')).not.toBeNull();
    expect(running.querySelector('.lucide-check')).toBeNull();

    rerender(<SessionRowStatusIndicator state="done" />);
    const done = screen.getByLabelText('sessionProcessState.doneHint');
    // تحت prefers-reduced-motion يتوقّف الدوران، فالقوسُ والصحُّ هما كلّ الفرق
    // بين الحالتين — لا يجوز أن تُختزلا إلى قرصٍ أخضر واحد.
    expect(done.querySelector('.lucide-check')).not.toBeNull();
    expect(done.querySelector('.lucide-loader-circle')).toBeNull();
  });

  it('يجعل معيّن الخطأ يملأ خانته بدل أن ينفجر منها', () => {
    render(<SessionRowStatusIndicator state="error" />);
    const error = screen.getByLabelText('sessionProcessState.errorHint');
    const plate = error.firstElementChild!;

    // مربّع 10px مُدارٌ 45° = قطرٌ 10·√2 ≈ 14.1px، أي مقاس الخانة تماماً.
    // كان مربّع 14.1px داخل خانة 10px حولها حلقةٌ دائرية أصغر منه.
    expect(plate.classList.contains('rotate-45')).toBe(true);
    expect(plate.classList.contains('h-2.5')).toBe(true);
    expect(plate.classList.contains('w-2.5')).toBe(true);
    expect(plate.classList.contains('bg-danger')).toBe(true);
    expect(error.textContent).toBe('!');
  });
});
