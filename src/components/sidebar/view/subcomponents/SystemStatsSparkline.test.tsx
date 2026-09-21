import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { SystemStatsSparkline, displayHeight, type SparkSeries } from './SystemStatsSparkline';
import type { LoadLevel } from './systemStatsFormat';

afterEach(cleanup);

const series = (
  values: Array<number | null>,
  levels: LoadLevel[] = ['low', 'low', 'low', 'low'],
): SparkSeries[] =>
  ['cpu', 'mem', 'swap', 'tmpfs'].map((key, i) => ({
    key,
    value: values[i],
    level: levels[i],
    title: `${key}-tip`,
  }));

const bars = (container: HTMLElement): Element[] =>
  Array.from(container.querySelectorAll('rect[style*="scaleX"]'));

/** طول كل خطّ (نسبةً إلى المدى الكامل)، بترتيب الرسم. */
const scales = (container: HTMLElement): number[] =>
  bars(container).map(node =>
    Number(/scaleX\(([\d.]+)\)/.exec(node.getAttribute('style') ?? '')?.[1]),
  );

describe('displayHeight — فرد الطرف المنخفض', () => {
  it('يحفظ الحدّين والترتيب', () => {
    expect(displayHeight(0)).toBe(0);
    expect(displayHeight(1)).toBe(1);
    expect(displayHeight(0.3)).toBeGreaterThan(displayHeight(0.1));
  });

  it('يرفع القراءات الصغيرة فوق العدم بدل محوها', () => {
    // 3% خطّياً = أقلّ من بكسل؛ بالجذر ≈ 17% من الطول.
    expect(displayHeight(0.03)).toBeGreaterThan(0.15);
  });

  it('يقصّ الخارج عن المجال بدل إخراج الخطّ من الإطار', () => {
    expect(displayHeight(1.4)).toBe(1);
    expect(displayHeight(-0.2)).toBe(0);
  });
});

describe('SystemStatsSparkline', () => {
  it('يرسم خطّاً لكل مقياس متاح مع تلميح قراءته', () => {
    const { container } = render(<SystemStatsSparkline series={series([0.1, 0.5, 0.9, 0.2])} />);

    const titles = Array.from(container.querySelectorAll('title')).map(node => node.textContent);
    expect(titles).toEqual(['cpu-tip', 'mem-tip', 'swap-tip', 'tmpfs-tip']);
  });

  it('يصفّ الخطوط بعضها فوق بعض بارتفاع سطر واحد', () => {
    const { container } = render(<SystemStatsSparkline series={series([0.2, 0.4, 0.6, 0.8])} />);
    const ys = bars(container).map(node => Number(node.getAttribute('y')));

    expect(ys).toEqual([...ys].sort((a, b) => a - b)); // متتالية نزولاً
    expect(new Set(ys).size).toBe(4); // ولا خطّ فوق خطّ
    expect(container.querySelector('svg')?.getAttribute('height')).toBe('20');
  });

  it('طول الخطّ هو القراءة: يمتدّ ويتقلّص في مكانه', () => {
    const { container, rerender } = render(<SystemStatsSparkline series={series([0.1, 0.4, 0.4, 0.4])} />);
    const before = scales(container);
    const xBefore = bars(container).map(node => node.getAttribute('x'));

    rerender(<SystemStatsSparkline series={series([0.8, 0.4, 0.4, 0.4])} />);
    const after = scales(container);

    expect(after[0]).toBeGreaterThan(before[0]); // امتدّ
    expect(after[1]).toBe(before[1]); // والساكن ساكن
    // ويبدأ الجميع من الحافّة نفسها: النموّ في الطول لا في الموضع.
    expect(bars(container).map(node => node.getAttribute('x'))).toEqual(xBefore);
    expect(new Set(xBefore)).toEqual(new Set(['0']));
  });

  it('الأعلى استهلاكاً هو الأطول', () => {
    const { container } = render(<SystemStatsSparkline series={series([0.05, 0.5, 0.95, 0.3])} />);
    const [cpu, mem, swap, tmpfs] = scales(container);

    expect(swap).toBeGreaterThan(mem);
    expect(mem).toBeGreaterThan(tmpfs);
    expect(tmpfs).toBeGreaterThan(cpu);
  });

  it('يُبقي أثراً ظاهراً للمقياس الخامل بدل محوه', () => {
    const { container } = render(<SystemStatsSparkline series={series([0, 0, 0, 0])} />);
    expect(scales(container).every(s => s >= 0.08)).toBe(true);
  });

  it('يُلوّن كل خطّ بمستواه هو لا بلونٍ ثابت لاسمه', () => {
    const { container } = render(
      <SystemStatsSparkline series={series([0.2, 0.4, 0.6, 0.8], ['low', 'medium', 'high', 'low'])} />,
    );

    expect(bars(container).map(node => node.getAttribute('class'))).toEqual([
      'fill-emerald-500',
      'fill-amber-500',
      'fill-red-500',
      'fill-emerald-500',
    ]);
  });

  it('يُسقِط المقياس الذي لم يرسله الخادم بدل رسم صفر ملفَّق', () => {
    const { container } = render(<SystemStatsSparkline series={series([0.1, 0.5, null, null])} />);

    const titles = Array.from(container.querySelectorAll('title')).map(node => node.textContent);
    expect(titles).toEqual(['cpu-tip', 'mem-tip']);
  });

  it('لا يرسم شيئاً قبل وصول أول عيّنة', () => {
    const { container } = render(<SystemStatsSparkline series={series([null, null, null, null])} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
