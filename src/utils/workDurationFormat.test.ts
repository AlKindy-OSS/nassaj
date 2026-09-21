import { describe, expect, it } from 'vitest';

import { formatWorkDuration, WORK_DURATION_DASH } from './workDurationFormat';

describe('formatWorkDuration', () => {
  it.each([
    [undefined, WORK_DURATION_DASH],
    [Number.NaN, WORK_DURATION_DASH],
    [Number.POSITIVE_INFINITY, WORK_DURATION_DASH],
    [-1, WORK_DURATION_DASH],
  ])('يرفض القياس غير الموثوق %s', (value, expected) => {
    expect(formatWorkDuration(value)).toBe(expected);
  });

  it('يحفظ الصفر والمللي ثانية ويقرب إلى ثانية عند بلوغها', () => {
    expect(formatWorkDuration(0)).toBe('0ms');
    expect(formatWorkDuration(999.4)).toBe('999ms');
    expect(formatWorkDuration(999.6)).toBe('1.0s');
  });

  it('ينسق الحدود الطويلة بثبات وبوحدات عربية عند الطلب', () => {
    expect(formatWorkDuration(60_000)).toBe('1m 0.0s');
    expect(formatWorkDuration(3_780_000)).toBe('1h 3m 0.0s');
    expect(formatWorkDuration(114_400, 'ar')).toBe('1د 54.4ث');
  });

  it('يقطع أجزاء الثانية ولا يقرّبها إلى وحدة لم تبلغها المدة', () => {
    expect(formatWorkDuration(59_999)).toBe('59.9s');
    expect(formatWorkDuration(119_999)).toBe('1m 59.9s');
  });
});
