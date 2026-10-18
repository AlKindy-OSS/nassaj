import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import arSidebar from '../../../i18n/locales/ar/sidebar.json';
import enSidebar from '../../../i18n/locales/en/sidebar.json';

import { formatAbsoluteSessionTime, formatCompactAge } from './sessionAge';

const now = Date.parse('2026-10-10T12:00:00.000Z');

const translatorFor = async (lng: 'ar' | 'en') => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    resources: { ar: { sidebar: arSidebar }, en: { sidebar: enSidebar } },
    defaultNS: 'sidebar',
  });
  return instance.t;
};

describe('formatCompactAge', () => {
  it.each([
    [null, ''],
    ['not a date', ''],
    ['2026-10-10T11:59:30.000Z', 'now'],
    ['2026-10-10T11:15:00.000Z', '45m'],
    ['2026-10-10T09:00:00.000Z', '3h'],
    ['2026-10-08T12:00:00.000Z', '2d'],
    // SQLite's zone-less UTC form is read as UTC.
    ['2026-10-10 09:00:00', '3h'],
  ])('en: %s -> %s', async (input, expected) => {
    const t = await translatorFor('en');
    expect(formatCompactAge(input, now, t)).toBe(expected);
  });

  it('renders the Arabic locale in Arabic', async () => {
    const t = await translatorFor('ar');
    expect(formatCompactAge('2026-10-10T11:15:00.000Z', now, t)).toBe('45 د');
    expect(formatCompactAge('2026-10-08T12:00:00.000Z', now, t)).toBe('2 ي');
    expect(formatCompactAge('2026-10-10T11:59:59.000Z', now, t)).toBe('الآن');
  });
});

describe('formatAbsoluteSessionTime', () => {
  it('formats a full local date and time, and nothing for a missing value', () => {
    expect(formatAbsoluteSessionTime('2026-10-10T09:00:00.000Z', 'en')).toMatch(/2026/);
    expect(formatAbsoluteSessionTime(null, 'en')).toBe('');
  });
});
