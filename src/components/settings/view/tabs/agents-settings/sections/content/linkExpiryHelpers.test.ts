/**
 * اختبارات `linkExpiryHelpers` — شروط القبول لمنطق نبرة انتهاء الربط.
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { resolveLinkExpiryDisplay } from './linkExpiryHelpers';

const EXPIRES_AT = '2026-08-08T12:49:15.289Z';
/** ساعةٌ مثبَّتة قبل الموعد بأربع ساعات — العدّاد لا يُقرأ من الساعة الحيّة. */
const NOW = Date.parse('2026-08-08T09:00:00.000Z');

describe('resolveLinkExpiryDisplay', () => {
  it('null ⇒ null: الخادم خارج نافذة الثلاثة أيام أو مسار مفتاح', () => {
    assert.equal(resolveLinkExpiryDisplay(null, NOW), null);
    assert.equal(resolveLinkExpiryDisplay(undefined, NOW), null);
  });

  it('daysLeft: 0 ⇒ danger: «ينتهي اليوم» لا «انتهى»', () => {
    const result = resolveLinkExpiryDisplay({ expiresAt: EXPIRES_AT, daysLeft: 0 }, NOW);
    assert.equal(result?.tone, 'danger');
    assert.equal(result?.daysLeft, 0);
  });

  it('daysLeft: 1 ⇒ danger: يستوجب bold في العرض', () => {
    const result = resolveLinkExpiryDisplay({ expiresAt: EXPIRES_AT, daysLeft: 1 }, NOW);
    assert.equal(result?.tone, 'danger');
  });

  it('daysLeft: 2 ⇒ warning: حدّ الفصل بين النبرتين', () => {
    const result = resolveLinkExpiryDisplay({ expiresAt: EXPIRES_AT, daysLeft: 2 }, NOW);
    assert.equal(result?.tone, 'warning');
  });

  it('daysLeft: 3 ⇒ warning: حدُّ نافذة الـCLI', () => {
    const result = resolveLinkExpiryDisplay({ expiresAt: EXPIRES_AT, daysLeft: 3 }, NOW);
    assert.equal(result?.tone, 'warning');
    assert.equal(result?.expiresAt, EXPIRES_AT);
  });

  it('daysLeft: 4 ⇒ neutral: خبرٌ لا إنذار', () => {
    const result = resolveLinkExpiryDisplay({ expiresAt: EXPIRES_AT, daysLeft: 4 }, NOW);
    assert.equal(result?.tone, 'neutral', 'خارج النافذة نبرةُ السطر المجاور لا لونُ تحذير');
  });

  it('ربطٌ جُدِّد للتوّ يُعرض ولا يختفي', () => {
    // العلّةُ التي أسقطت الحجب: تسجيلُ دخولٍ ناجح كان يُخفي السطر بدل أن يُظهر
    // موعدَه الجديد، فيبدو الفعلُ الناجح بلا أثر.
    const result = resolveLinkExpiryDisplay({ expiresAt: EXPIRES_AT, daysLeft: 30 }, NOW);
    assert.ok(result, 'ثلاثون يوماً معلومةٌ تُعرض لا تُحجب');
    assert.equal(result?.tone, 'neutral');
    assert.equal(result?.daysLeft, 30);
  });

  it('الموعدُ مضى ⇒ expired: «انتهى» لا «ينتهي اليوم»', () => {
    // الحالةُ التي وقعت فعلاً: الموعدُ مضى وتوكنُ الوصول ما زال حيّاً ساعات.
    // قولُ «ينتهي اليوم 3:49م» بعد الرابعة يُفوّت الفعلَ المطلوب.
    const after = Date.parse(EXPIRES_AT) + 60_000;
    const result = resolveLinkExpiryDisplay({ expiresAt: EXPIRES_AT, daysLeft: 0 }, after);
    assert.equal(result?.tone, 'expired');
  });

  it('لحظةُ الموعد نفسها تُعدّ انقضاءً', () => {
    const exact = Date.parse(EXPIRES_AT);
    const result = resolveLinkExpiryDisplay({ expiresAt: EXPIRES_AT, daysLeft: 0 }, exact);
    assert.equal(result?.tone, 'expired', 'الحدُّ مُغلقٌ من جهة الانقضاء');
  });

  it('يُعيد expiresAt كما وصل دون تعديل', () => {
    const iso = '2026-08-10T09:00:00.000Z';
    const result = resolveLinkExpiryDisplay({ expiresAt: iso, daysLeft: 2 }, NOW);
    assert.equal(result?.expiresAt, iso);
  });
});
