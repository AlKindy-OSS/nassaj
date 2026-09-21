/**
 * T-1804 — حارسُ الأسماء المحجوزة.
 *
 * كلُّ مسارٍ جذريّ يملكه موجّهُ الواجهة (`src/App.tsx`) لا يجوز أن يأخذه موقعٌ
 * منشور. والحارسُ يقرأ الملفّ نفسه لا نسخةً منه: مسارٌ جذريّ جديد يُضاف غداً
 * يُسقط هذا الاختبار، بدل أن يُكتشف بموقعٍ نُشر ثمّ لم يُخدَم أبداً.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { PUBLIC_SITE_ID, PUBLIC_SITE_RESERVED_IDS, isReservedPublicSiteId } from './public-page-manifest.mjs';

/** أوّل مقطعٍ من كل `path="/…"` في موجّه الواجهة، بلا الجذر وبلا الأنماط. */
function clientRootRoutes() {
  const source = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const segments = new Set();
  for (const [, value] of source.matchAll(/path="(\/[^"]*)"/g)) {
    const first = value.slice(1).split('/')[0];
    if (first && first !== '*' && !first.startsWith(':')) segments.add(first);
  }
  return [...segments];
}

test('every client root route is a reserved publication id', () => {
  const routes = clientRootRoutes();
  assert.ok(routes.length >= 5, `القراءة فشلت أو الموجّه تغيّر شكله: ${routes.join(',')}`);
  for (const route of routes) {
    assert.ok(isReservedPublicSiteId(route), `المسار الجذري "${route}" غير محجوز`);
  }
});

test('every reserved name is either a real slug or too short to ever be one', () => {
  // اسمٌ محجوزٌ لا يطابق نحو المعرّف حجزٌ لا أثر له. والاستثناء الوحيد المقبول
  // أن يكون أقصرَ من الحدّ الأدنى (`ws`، `sw`) فيستحيل طلبُه أصلاً — فيبقى في
  // القائمة توثيقاً لا حراسة.
  for (const reserved of PUBLIC_SITE_RESERVED_IDS) {
    if (reserved.length < 3) continue;
    assert.match(reserved, PUBLIC_SITE_ID, reserved);
  }
  for (const short of [...PUBLIC_SITE_RESERVED_IDS].filter((id) => id.length < 3)) {
    assert.doesNotMatch(short, PUBLIC_SITE_ID, `${short} صار طلبُه ممكناً فاحرسه فعلاً`);
  }
});

test('a non-string or unknown slug is not reserved', () => {
  for (const value of [null, undefined, 42, {}, 'uqud-lifetrip', 'SESSION']) {
    assert.equal(isReservedPublicSiteId(value), false, String(value));
  }
});
