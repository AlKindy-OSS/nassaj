// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { PINNED_VENDOR_DIGESTS } from '@/services/isolation/vendor-binary-integrity.js';

import {
  ACK_TOKEN_TTL_MS,
  AckTokenService,
  dataLossTexts,
  defaultAckKeyPath,
  loadOrCreateAckKey,
  pinBreakTexts,
  type AckContext,
  type RequiredAck,
} from './confirmation.js';
import { hasErrorCode } from './snapshot/errors.js';
import { makeFixtureRoot, modeOf, removeFixture } from './snapshot/__tests__/fixtures.js';

const root = makeFixtureRoot();
after(() => removeFixture(root));
const PINS_BEFORE = JSON.stringify(PINNED_VENDOR_DIGESTS);

const ctx = (over: Partial<AckContext> = {}): AckContext => ({
  userId: 1,
  harness: 'opencode',
  harnessName: 'OpenCode',
  action: 'update',
  pinBreak: { variant: 'carrier', target: '1.18.32', pin: '1.17.18' },
  dataLoss: null,
  ...over,
});

function required(svc: AckTokenService, c: AckContext, supplied?: unknown[]): RequiredAck[] {
  try {
    svc.verifyAcks(c, supplied as never);
  } catch (error) {
    assert.ok(hasErrorCode(error, 'CONFIRMATION_REQUIRED'));
    return ((error as { details: { required: RequiredAck[] } }).details).required;
  }
  return [];
}

test('ack key: created 0600 in a 0700 dir, stable, 32 bytes; loose or short key refused', () => {
  assert.equal(defaultAckKeyPath('/h'), '/h/.local/share/nassaj/harness-ack.key');
  const file = path.join(root, 'k/nassaj/harness-ack.key');
  const key = loadOrCreateAckKey(file);
  assert.equal(key.length, 32);
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(path.dirname(file)), 0o700);
  assert.deepEqual(loadOrCreateAckKey(file), key);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['harness-ack.key']);
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadOrCreateAckKey(file), (e) => hasErrorCode(e, 'ACK_KEY_INSECURE'));
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, 'short');
  assert.throws(() => loadOrCreateAckKey(file), (e) => hasErrorCode(e, 'ACK_KEY_INSECURE'));
  assert.throws(() => new AckTokenService(Buffer.alloc(8)), (e) => hasErrorCode(e, 'ACK_KEY_INSECURE'));
});

test('no ack needed → verify passes with nothing supplied', () => {
  const svc = new AckTokenService(Buffer.alloc(32, 1));
  svc.verifyAcks(ctx({ pinBreak: null }), undefined);
});

test('409 carries server-built texts; a valid token passes once, reuse is refused', () => {
  const svc = new AckTokenService(Buffer.alloc(32, 1));
  const [ack] = required(svc, ctx());
  assert.equal(ack.kind, 'pinBreak');
  assert.match(ack.textEn, /^Updating OpenCode to 1\.18\.32 leaves the verified version 1\.17\.18\. GLM will stop working/);
  assert.match(ack.textAr, /^تحديث OpenCode إلى 1\.18\.32 يُخرجه عن النسخة الموثَّقة 1\.17\.18\./);
  svc.verifyAcks(ctx(), [{ kind: 'pinBreak', token: ack.token }]);
  assert.equal(required(svc, ctx(), [{ kind: 'pinBreak', token: ack.token }]).length, 1, 'single use');
  assert.equal(JSON.stringify(PINNED_VENDOR_DIGESTS), PINS_BEFORE, 'pins never modified');
});

test('tamper, wrong kind, other user/action, facts change and expiry all → fresh 409', () => {
  let t = 1_000;
  const svc = new AckTokenService(Buffer.alloc(32, 2), () => t);
  const [ack] = required(svc, ctx());
  const flip = ack.token.slice(0, -2) + (ack.token.endsWith('AA') ? 'BB' : 'AA');
  for (const [c, supplied] of [
    [ctx(), [{ kind: 'pinBreak', token: flip }]],
    [ctx(), [{ kind: 'dataLoss', token: ack.token }]],
    [ctx(), [{ kind: 'pinBreak', token: 'a.b.c.d' }]],
    [ctx(), [{ kind: 'pinBreak', token: 42 }]],
    [ctx({ userId: 2 }), [{ kind: 'pinBreak', token: ack.token }]],
    [ctx({ action: 'restore-compatible' }), [{ kind: 'pinBreak', token: ack.token }]],
    [ctx({ pinBreak: { variant: 'carrier', target: '1.18.33', pin: '1.17.18' } }), [{ kind: 'pinBreak', token: ack.token }]],
  ] as const) {
    const fresh = required(svc, c, [...supplied]);
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0].token, ack.token);
  }
  t += ACK_TOKEN_TTL_MS;
  assert.equal(required(svc, ctx(), [{ kind: 'pinBreak', token: ack.token }]).length, 1, 'expired');
});

test('a new service instance (server restart) invalidates earlier tokens', () => {
  const key = Buffer.alloc(32, 3);
  const [ack] = required(new AckTokenService(key), ctx());
  assert.equal(required(new AckTokenService(key), ctx(), [{ kind: 'pinBreak', token: ack.token }]).length, 1);
});

test('both acks required: consumed only when all pass', () => {
  const svc = new AckTokenService(Buffer.alloc(32, 4));
  const c = ctx({ action: 'rollback', dataLoss: { storeCount: 2, backupAt: 0, spawnCount: 3, firstSpawnAt: 60_000, changedStores: 1, asideExpiry: 7 * 86_400_000 } });
  const acks = required(svc, c);
  assert.deepEqual(acks.map((a) => a.kind), ['pinBreak', 'dataLoss']);
  const pin = acks[0];
  assert.equal(required(svc, c, [{ kind: 'pinBreak', token: pin.token }]).length, 2, 'dataLoss missing');
  svc.verifyAcks(c, [{ kind: 'pinBreak', token: pin.token }, { kind: 'dataLoss', token: acks[1].token }]);
});

test('texts: pinBreak all, dataLoss known and unknown ledger (ar/en exact)', () => {
  assert.deepEqual(pinBreakTexts('Kimi', { variant: 'all', target: '2.1.1', pin: '0.28.1' }), {
    en: 'Kimi will be blocked in every mode until version 0.28.1 is restored.',
    ar: 'سيُحجب Kimi في كل الأوضاع حتى تُستعاد النسخة 0.28.1.',
  });
  const facts = { storeCount: 2, backupAt: Date.UTC(2026, 8, 27, 9), spawnCount: 3, firstSpawnAt: Date.UTC(2026, 8, 27, 10), changedStores: 1, asideExpiry: Date.UTC(2026, 9, 4, 9) };
  assert.deepEqual(dataLossTexts('Codex', facts), {
    en: 'This returns 2 data store(s) to the backup taken at 2026-09-27T09:00:00Z. Since then Codex was started 3 time(s), first at 2026-09-27T10:00:00Z, and 1 store(s) changed. Conversations and settings written after 2026-09-27T09:00:00Z will be lost. Current files are kept aside until 2026-10-04T09:00:00Z.',
    ar: 'سيُعيد هذا 2 من مخازن البيانات إلى النسخة الاحتياطية المأخوذة في 2026-09-27T09:00:00Z. منذ ذلك الحين شُغِّل Codex 3 مرة، أولها في 2026-09-27T10:00:00Z، وتغيّر 1 مخزن. ستُفقد المحادثات والإعدادات المكتوبة بعد 2026-09-27T09:00:00Z. تُحفظ الملفات الحالية جانباً حتى 2026-10-04T09:00:00Z.',
  });
  const unknown = dataLossTexts('Codex', { ...facts, spawnCount: null, firstSpawnAt: null });
  assert.match(unknown.en, /was started an unknown number of time\(s\), first at an unknown time,/);
  assert.match(unknown.ar, /شُغِّل Codex عدداً غير معروف من المرات، أولها في وقت غير معروف،/);
});
