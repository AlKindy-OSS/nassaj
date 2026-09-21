/**
 * T-1294 — نغمة الفشل هابطة، ومفتاح الإعداد واحد للقناتين.
 *
 * قرار المالك: قناة إشعار واحدة بمفتاح واحد — لا إعداد ثانٍ للفشل. والفارق
 * المسموع كلّه في الاتجاه: الصاعدة تقول «جاهز»، والهابطة تقول «انتهت بفشل».
 * لو تساوى التتابعان لصار الصوت كذبةً على من لا يرى الشاشة.
 *
 * jsdom بلا `AudioContext`، فيُركَّب بديل يسجّل ما طُلب تشغيله فعلاً — الاختبار
 * يقود الوحدة الإنتاجية نفسها لا نسخةً منها.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { beforeEach, describe, it, vi } from 'vitest';

type Played = { frequency: number; startsAt: number };

let played: Played[] = [];

class FakeAudioContext {
  currentTime = 0;
  state: 'running' | 'suspended' = 'running';
  destination = {};

  async resume(): Promise<void> {
    this.state = 'running';
  }

  createOscillator() {
    const record = (frequency: number, startsAt: number) => {
      played.push({ frequency, startsAt });
    };
    return {
      type: 'sine',
      frequency: { setValueAtTime: record },
      connect: () => {},
      start: () => {},
      stop: () => {},
    };
  }

  createGain() {
    return {
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
    };
  }
}

/** الوحدة تلتقط مُنشئ `AudioContext` وقت الاستيراد، فيُركَّب قبله. */
async function freshModule() {
  vi.resetModules();
  (window as any).AudioContext = FakeAudioContext;
  return import('./notificationSound');
}

beforeEach(() => {
  played = [];
  localStorage.clear();
});

describe('نغمتا نهاية التشغيل', () => {
  it('الاكتمال صاعد', async () => {
    const { playChatCompletionSound } = await freshModule();

    await playChatCompletionSound();

    assert.deepEqual(played.map((p) => p.frequency), [740, 988]);
  });

  it('الفشل هابط — لا يُخلَط بالنجاح سماعاً', async () => {
    const { playChatErrorSound } = await freshModule();

    await playChatErrorSound();

    const frequencies = played.map((p) => p.frequency);
    assert.equal(frequencies.length, 2);
    assert.ok(
      frequencies[0] > frequencies[1],
      `تتابع الفشل ليس هابطاً: ${JSON.stringify(frequencies)}`,
    );
  });

  it('التتابعان متمايزان', async () => {
    const { playChatCompletionSound, playChatErrorSound } = await freshModule();

    await playChatCompletionSound();
    const completion = played.map((p) => p.frequency);
    played = [];
    await playChatErrorSound();
    const failure = played.map((p) => p.frequency);

    assert.notDeepEqual(failure, completion);
  });

  it('مفتاح واحد يُسكِت القناتين — لا إعداد ثانٍ للفشل', async () => {
    const { playChatErrorSound, setNotificationSoundEnabled } = await freshModule();

    setNotificationSoundEnabled(false);
    await playChatErrorSound();

    assert.deepEqual(played, [], 'صوت الفشل تجاهل الإعداد الوحيد');
  });

  it('‏force يتجاوز الإعداد (معاينة الإعدادات)', async () => {
    const { playChatErrorSound, setNotificationSoundEnabled } = await freshModule();

    setNotificationSoundEnabled(false);
    await playChatErrorSound({ force: true });

    assert.equal(played.length, 2);
  });
});
