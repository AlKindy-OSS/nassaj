/**
 * اختبارات طبقة خدمة الكلفة على **سجلّات حقيقية**: كل ملف هنا نسخة من
 * `__fixtures__` المقتطعة حرفياً من سجلّات هذا الجهاز، لا سطور مُلفَّقة. الدرس
 * مدفوع الثمن في هذا المستودع: اختبار أخضر على fixture مصطنع لا يقول شيئاً عن
 * الإنتاج.
 *
 * والمقصود اختباره هنا هو **ما أضافته الخدمة** لا ما يفعله المحرّك: حلّ المسار،
 * الصدق حين لا قياس، الكاش وإبطاله، نافذة الدورة، وتخطّي الملفات الباردة.
 *
 * قاعدة زمنية: كل `now` مُحقَّن ومبنيّ بمُنشئ `Date` المحلّي، وكل mtime يُثبَّت
 * بـ`utimes` إلى لحظة معلومة — فلا يعتمد أي تأكيد على ساعة الجهاز الحقيقية.
 */

import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, participantsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { PRICES_AS_OF } from '@/modules/providers/services/cost/model-pricing.js';
import { sessionCostService } from '@/modules/providers/services/cost/session-cost.service.js';
import {
  subscriptionConfigService,
  type ProviderAuthProbe,
} from '@/modules/providers/services/cost/subscription-config.service.js';
import { _resetProviderSharingCache, setProviderSharingConfig } from '@/services/provider-sharing.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/** كلفة `claude-parent.jsonl` كاملةً بأسعار الجدول (محسوبة من الـfixture). */
const CLAUDE_PARENT_USD = 4 * 5e-6 + 1061 * 25e-6 + 48985 * 10e-6 + 48140 * 0.5e-6;
/** كلفة `codex-rollout.jsonl`: آخر عدّاد تراكمي، والمدخلات غير المخبّأة بالفرق. */
const CODEX_ROLLOUT_USD = 19374 * 5e-6 + 671 * 30e-6 + 46336 * 0.5e-6;

const near = (actual: number, expected: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} ≠ ${expected}`);
};

// ---------------------------------------------------------------------------
// بيئة اختبار: قاعدة مؤقّتة + شجرة سجلّات مؤقّتة
// ---------------------------------------------------------------------------

type Environment = {
  root: string;
  userId: number;
  /** ينسخ fixture إلى مسار سجلّ، ويُثبّت زمن تعديله. */
  addTranscript(name: string, fixture: string, mtime: Date): Promise<string>;
  /** يُنشئ صفّ جلسة (وينسب المستخدم مشاركاً كما يفعل مسار التشغيل). */
  addSession(sessionId: string, provider: string, jsonlPath: string | null, options?: { participant?: boolean }): void;
};

async function withEnvironment(run: (environment: Environment) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-cost-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  subscriptionConfigService._resetCaches();
  sessionCostService._resetCache();
  _resetProviderSharingCache();

  const userId = userDb.createUser('cost-user', 'hash', 'owner').id;

  const environment: Environment = {
    root,
    userId,
    async addTranscript(name, fixture, mtime) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(FIXTURES, fixture), target);
      await utimes(target, mtime, mtime);
      return target;
    },
    addSession(sessionId, provider, jsonlPath, options = {}) {
      sessionsDb.createSession(sessionId, provider, path.join(root, 'workspace'), undefined, undefined, undefined, jsonlPath);
      if (options.participant !== false) {
        participantsDb.recordSpawn(sessionId, userId);
      }
    },
  };

  try {
    await run(environment);
  } finally {
    subscriptionConfigService._resetCaches();
    sessionCostService._resetCache();
    _resetProviderSharingCache();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const probeOf = (method: string | null): ProviderAuthProbe => async () => ({
  installed: true,
  authenticated: method !== null,
  method,
});

/** فحص يقتصر على مزوّدات بعينها — كي لا تحشو اللوحةَ عشرةُ مزوّدات مُدّعاة. */
const probeOnly = (providers: string[], method = 'credentials_file'): ProviderAuthProbe => async (provider) =>
  providers.includes(provider)
    ? { installed: true, authenticated: true, method }
    : { installed: false, authenticated: false, method: null };

const SUBSCRIPTION_PROBE = probeOf('credentials_file');
const CLAUDE_ONLY_PROBE = probeOnly(['claude']);

// ---------------------------------------------------------------------------
// كلفة محادثة واحدة
// ---------------------------------------------------------------------------

test('كلفة محادثة كلود: أرقام المحرّك نفسها داخل مظروف العقد', async () => {
  await withEnvironment(async (environment) => {
    const transcript = await environment.addTranscript('sess.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('sess-1', 'claude', transcript);

    const cost = await sessionCostService.getSessionCost('sess-1', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });

    assert.equal(cost.available, true);
    assert.equal(cost.reason, undefined);
    assert.equal(cost.provider, 'claude');
    assert.equal(cost.sessionId, 'sess-1');
    assert.equal(cost.pricesAsOf, PRICES_AS_OF);
    assert.equal(cost.complete, true);
    assert.deepEqual(cost.unpricedModels, []);
    near(cost.totalUsd, CLAUDE_PARENT_USD, 'كلفة المحادثة');

    assert.equal(cost.perModel.length, 1);
    assert.equal(cost.perModel[0].model, 'claude-opus-5');
    assert.equal(cost.perModel[0].requests, 2);
    assert.deepEqual(cost.perModel[0].tokens, {
      input: 4,
      output: 1061,
      cacheWrite5m: 0,
      cacheWrite1h: 48985,
      cacheRead: 48140,
    });
  });
});

test('كلفة محادثة كودكس تُقرأ من ملف الـrollout بمُستخرِجه هو', async () => {
  await withEnvironment(async (environment) => {
    const rollout = await environment.addTranscript(
      'rollout-2026-07-26.jsonl',
      'codex-rollout.jsonl',
      new Date('2026-07-26T05:00:00.000Z'),
    );
    environment.addSession('codex-1', 'codex', rollout);

    const cost = await sessionCostService.getSessionCost('codex-1', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });

    assert.equal(cost.available, true);
    assert.equal(cost.perModel.length, 1);
    assert.equal(cost.perModel[0].model, 'gpt-5.6-sol');
    // العدّاد تراكمي: القيمة الأخيرة وحدها، لا مجموع الأحداث الأربعة.
    assert.deepEqual(cost.perModel[0].tokens, {
      input: 19374,
      output: 671,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 46336,
    });
    near(cost.totalUsd, CODEX_ROLLOUT_USD, 'كلفة محادثة كودكس');
  });
});

test('مزوّد لا يحفظ استهلاكه: لا رقم ولا صفر — سببٌ مكتوب', async () => {
  await withEnvironment(async (environment) => {
    const transcript = await environment.addTranscript('agy.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('agy-1', 'antigravity', transcript);

    const cost = await sessionCostService.getSessionCost('agy-1', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });

    assert.equal(cost.available, false);
    assert.match(cost.reason ?? '', /token/i);
    assert.equal(cost.totalUsd, 0);
    assert.equal(cost.complete, false);
    assert.deepEqual(cost.perModel, []);
    // السجلّ موجود ومقروء — الامتناع سببه المزوّد لا الملف.
    assert.ok((await stat(transcript)).isFile());
  });
});

test('محادثة غير مفهرسة أو بلا سجلّ على القرص تعود بلا رقم ولا استثناء', async () => {
  await withEnvironment(async (environment) => {
    const unknown = await sessionCostService.getSessionCost('does-not-exist', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });
    assert.equal(unknown.available, false);
    assert.equal(unknown.totalUsd, 0);
    assert.ok((unknown.reason ?? '').length > 0);

    // صفّ يشير إلى ملف مُزال — نفس الصدق. المستخدم null كي لا يُهيَّأ جذر معزول.
    environment.addSession('gone-1', 'claude', path.join(environment.root, 'gone.jsonl'));
    const gone = await sessionCostService.getSessionCost('gone-1', null, { probeAuth: SUBSCRIPTION_PROBE });
    assert.equal(gone.available, false);
    assert.match(gone.reason ?? '', /disk/i);
    assert.equal(gone.provider, 'claude');
  });
});

test('metered يتبع طريقة المصادقة القائمة، وعند الشكّ يبقى «قيمة مكافئة»', async () => {
  await withEnvironment(async (environment) => {
    const transcript = await environment.addTranscript('sess.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('sess-1', 'claude', transcript);

    const subscription = await sessionCostService.getSessionCost('sess-1', environment.userId, {
      probeAuth: probeOf('credentials_file'),
    });
    assert.equal(subscription.metered, false, 'اشتراك ⇒ قيمة مكافئة لا فاتورة');

    const apiKey = await sessionCostService.getSessionCost('sess-1', environment.userId, {
      probeAuth: probeOf('api_key'),
    });
    assert.equal(apiKey.metered, true, 'مفتاح API ⇒ مال مقيس');

    const broken = await sessionCostService.getSessionCost('sess-1', environment.userId, {
      probeAuth: async () => {
        throw new Error('probe exploded');
      },
    });
    assert.equal(broken.metered, false, 'فشل الفحص لا يُنتج ادّعاء فاتورة');
    // والكلفة نفسها لا تتأثّر بطريقة المصادقة.
    near(broken.totalUsd, CLAUDE_PARENT_USD, 'الكلفة مستقلّة عن metered');
  });
});

// ---------------------------------------------------------------------------
// الكاش
// ---------------------------------------------------------------------------

test('ملف بنفس البصمة لا يُقرأ ثانية، وأي تغيّر في زمنه يُبطل المخبَّأ', async () => {
  await withEnvironment(async (environment) => {
    const frozen = new Date('2026-07-28T12:00:00.000Z');
    const transcript = await environment.addTranscript('sess.jsonl', 'claude-parent.jsonl', frozen);
    environment.addSession('sess-1', 'claude', transcript);

    const first = await sessionCostService.getSessionCost('sess-1', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    near(first.totalUsd, CLAUDE_PARENT_USD, 'القراءة الأولى');

    // محتوى مختلف بنفس **عدد البايتات** ونفس زمن التعديل: 172 ⇒ 999. لو قُرئ
    // الملف ثانية لظهر رقم آخر — فبقاء الرقم هو الدليل على أن الكاش خدم.
    const mutated = (await readFile(transcript, 'utf8')).replaceAll('"output_tokens": 172', '"output_tokens": 999');
    await writeFile(transcript, mutated);
    await utimes(transcript, frozen, frozen);

    const cached = await sessionCostService.getSessionCost('sess-1', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    near(cached.totalUsd, CLAUDE_PARENT_USD, 'نفس البصمة ⇒ نفس الرقم من الكاش');

    // تحريك زمن التعديل وحده (والمحتوى كما هو) يُسقط المفتاح فيُعاد القياس.
    const later = new Date('2026-07-28T12:01:00.000Z');
    await utimes(transcript, later, later);

    const refreshed = await sessionCostService.getSessionCost('sess-1', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    assert.ok(refreshed.totalUsd > cached.totalUsd, 'بصمة جديدة ⇒ قراءة جديدة');
    assert.equal(refreshed.perModel[0].tokens.output, 999 + 889);
  });
});

test('كتابة وكيل فرعي داخل ملف قائم تُبطل المخبَّأ رغم ثبات ملف الأمّ', async () => {
  await withEnvironment(async (environment) => {
    const frozen = new Date('2026-07-28T12:00:00.000Z');
    const transcript = await environment.addTranscript('sess.jsonl', 'claude-parent.jsonl', frozen);
    environment.addSession('sess-1', 'claude', transcript);

    // مجلّد الوكلاء يُنشأ سلفاً بملف فارغ: بعد ذلك لا يتغيّر زمن المجلّد ولا
    // زمن ملف الأمّ، فلا يكشف الكتابةَ إلا مشيُ الشجرة. وزمن ملف الوكيل مُثبَّت
    // يدوياً لأن دقّة طوابع الملفات خشنة (4ms هنا)، فكتابتان متلاحقتان قد
    // تحملان نفس الطابع ويصير الاختبار رهن سرعة الجهاز.
    const agentFile = path.join(environment.root, 'sess', 'subagents', 'agent-a42e68ee5814334bd.jsonl');
    await mkdir(path.dirname(agentFile), { recursive: true });
    await writeFile(agentFile, '');
    const agentCreated = new Date('2026-07-28T12:00:01.000Z');
    await utimes(agentFile, agentCreated, agentCreated);

    const before = await sessionCostService.getSessionCost('sess-1', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    assert.deepEqual(before.perModel.map((entry) => entry.model), ['claude-opus-5']);

    await copyFile(path.join(FIXTURES, 'claude-subagent.jsonl'), agentFile);
    const agentWritten = new Date('2026-07-28T12:05:00.000Z');
    await utimes(agentFile, agentWritten, agentWritten);

    const after = await sessionCostService.getSessionCost('sess-1', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    assert.deepEqual(after.perModel.map((entry) => entry.model).sort(), ['claude-opus-4-8', 'claude-opus-5']);
    assert.ok(after.totalUsd > before.totalUsd, 'استهلاك الوكيل يدخل المجموع');
    assert.equal(after.subagentRequests, 1);
  });
});

// ---------------------------------------------------------------------------
// الاشتراكات والدورة
// ---------------------------------------------------------------------------

/** 28 يوليو 2026 بالتوقيت المحلّي — مع يوم بداية 20 تصير الدورة [07-20, 08-20). */
const NOW_IN_CYCLE = () => new Date(2026, 6, 28, 18, 0, 0);

test('الدورة تحسب ما كُتب داخلها فقط — لا محادثةً كاملة نسبةً لتاريخ فتحها', async () => {
  await withEnvironment(async (environment) => {
    subscriptionConfigService.update('claude', { anchorDay: 20, plan: 'Max 20x' });

    // داخل الدورة: أسطره في 2026-07-28.
    const recent = await environment.addTranscript('recent.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('recent-1', 'claude', recent);

    // قبل الدورة محتوىً (‏2026-07-10) وإن كان الملف مكتوباً حديثاً — الترشيح
    // بطابع كل سطر لا بزمن الملف.
    const older = await environment.addTranscript('older.jsonl', 'claude-subagent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('older-1', 'claude', older);

    const [subscription] = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });

    // مفتاح البطاقة هو **المورّد** لا الجسم: الاشتراك يُشترى من أنثروبيك،
    // و«claude» اسم الأداة التي شغّلته. (تصحيح المالك: GLM كان يظهر بطاقةً
    // فارغة بينما إنفاقه مدفون تحت بطاقة الحامل.)
    assert.equal(subscription.provider, 'anthropic');
    assert.equal(subscription.displayName, 'Claude');
    assert.equal(subscription.plan, 'Max 20x');
    assert.equal(subscription.anchorDay, 20);
    assert.equal(subscription.available, true);
    assert.equal(subscription.metered, false);
    assert.equal(subscription.sessions, 1, 'محادثة واحدة ساهمت داخل الدورة');
    near(subscription.totalUsd, CLAUDE_PARENT_USD, 'مجموع الدورة');
    assert.equal(subscription.complete, true);

    const start = new Date(subscription.cycleStart);
    const end = new Date(subscription.cycleEnd);
    assert.deepEqual([start.getFullYear(), start.getMonth() + 1, start.getDate()], [2026, 7, 20]);
    assert.deepEqual([end.getFullYear(), end.getMonth() + 1, end.getDate()], [2026, 8, 20]);
  });
});

test('ملف لم يُكتب فيه شيء منذ بداية الدورة لا يُفتح أصلاً', async () => {
  await withEnvironment(async (environment) => {
    subscriptionConfigService.update('claude', { anchorDay: 20 });

    // محتواه داخل الدورة تماماً، لكن زمن تعديله قبلها: لا سطر يمكن أن يكون
    // كُتب داخل النافذة، فيُتخطّى بـstat وحده. لو قُرئ لأضاف كلفته للمجموع.
    const cold = await environment.addTranscript('cold.jsonl', 'claude-parent.jsonl', new Date('2026-07-05T12:00:00.000Z'));
    environment.addSession('cold-1', 'claude', cold);

    const [subscription] = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });

    assert.equal(subscription.sessions, 0);
    assert.equal(subscription.totalUsd, 0);
  });
});

test('سجلّ اختفى من القرص يُخفض «مكتمل» بدل أن يمرّ صامتاً', async () => {
  await withEnvironment(async (environment) => {
    subscriptionConfigService.update('claude', { anchorDay: 20 });

    const recent = await environment.addTranscript('recent.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('recent-1', 'claude', recent);
    environment.addSession('vanished-1', 'claude', path.join(environment.root, 'vanished.jsonl'));

    const [subscription] = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });

    assert.equal(subscription.sessions, 1);
    near(subscription.totalUsd, CLAUDE_PARENT_USD, 'ما أمكن قياسه يبقى ظاهراً');
    assert.equal(subscription.complete, false, 'ناقصٌ يُقال ناقصاً');
  });
});

test('العزل يحصر المجموع في محادثات صاحب الاشتراك؛ والمشترك يجمعها كلّها', async () => {
  await withEnvironment(async (environment) => {
    subscriptionConfigService.update('claude', { anchorDay: 20 });

    const mine = await environment.addTranscript('mine.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('mine-1', 'claude', mine);

    // محادثة لا يشارك فيها هذا المستخدم — اعتماد غيره تحت العزل.
    const theirs = await environment.addTranscript('theirs.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('theirs-1', 'claude', theirs, { participant: false });

    const [isolated] = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });
    assert.equal(isolated.sessions, 1, 'المعزول يرى اشتراكه هو');
    near(isolated.totalUsd, CLAUDE_PARENT_USD, 'مجموع المعزول');

    // اشتراك واحد للجميع ⇒ المجموع واحد لا يُقسَّم على المستخدمين.
    setProviderSharingConfig({ claude: 'shared' });
    sessionCostService._resetCache();

    const [shared] = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });
    assert.equal(shared.sessions, 2);
    near(shared.totalUsd, CLAUDE_PARENT_USD * 2, 'مجموع المشترك');
  });
});

test('مزوّد مُكتشَف بلا قياس يظهر في اللوحة بسببه، لا بصفر', async () => {
  await withEnvironment(async (environment) => {
    const subscriptions = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: async (provider) =>
        provider === 'gemini'
          ? { installed: true, authenticated: true, method: 'credentials_file' }
          : { installed: false, authenticated: false, method: null },
      now: NOW_IN_CYCLE,
    });

    assert.equal(subscriptions.length, 1);
    const [gemini] = subscriptions;
    assert.equal(gemini.provider, 'google');
    assert.equal(gemini.available, false);
    assert.ok((gemini.reason ?? '').length > 0);
    assert.equal(gemini.sessions, 0);
    assert.equal(gemini.complete, false);
    // ومع ذلك تبقى دورته معروضة كي تُضبط من الإعدادات.
    assert.ok(gemini.cycleStart < gemini.cycleEnd);
  });
});

test('المخفيّ لا يُحسب ولا يظهر في الاشتراكات', async () => {
  await withEnvironment(async (environment) => {
    subscriptionConfigService.update('claude', { hidden: true });
    const transcript = await environment.addTranscript('sess.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('sess-1', 'claude', transcript);

    const subscriptions = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });

    assert.deepEqual(subscriptions, []);
  });
});
