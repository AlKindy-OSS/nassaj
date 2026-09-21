/**
 * vendors.test.ts — ADR-085 drift guards for the vendor axis.
 *
 * The registry is a DESCRIPTION of who reads which secret. A description that
 * silently stops matching the code is worse than none: it is what put a key box
 * on `opencode × glm` writing a record the carrier never reads (B-343). These
 * tests pin the invariants that would catch the same class of drift.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPANY_NAME,
  agentsForCompany,
  companiesForAgent,
  vendorsByCompany,
  vendorIsNativeToAgent,
  VENDORS,
  WRITABLE_VENDORS,
  vendorForPair,
  vendorForSlot,
} from '../../../../../../shared/vendors';
import { bodyEngineCells, engineKeySlot, type EngineAxisId } from '../../../../../../shared/bodyEngineMatrix';

import { visibleSettingsAgents } from './visibleAgents';

describe('vendor registry shape', () => {
  it('gives every vendor a unique id and at least one consumer', () => {
    const ids = VENDORS.map((vendor) => vendor.id);
    expect(new Set(ids).size, 'vendor ids must be unique').toBe(ids.length);
    for (const vendor of VENDORS) {
      // A vendor nobody reads is a key box with nowhere to go — the B-343 shape.
      expect(vendor.consumers.length, `${vendor.id} has no consumer`).toBeGreaterThan(0);
    }
  });

  it('gives every writable vendor a slot and a key url', () => {
    for (const vendor of WRITABLE_VENDORS) {
      expect(vendor.slot, `${vendor.id} is writable but has no slot`).not.toBeNull();
      expect(vendor.keyUrl, `${vendor.id} offers no way to obtain a credential`).toBeTruthy();
    }
  });

  it('keeps one slot per vendor — two vendors writing one record cannot both be right', () => {
    const slots = WRITABLE_VENDORS.map((vendor) => `${vendor.slot?.provider}:${vendor.slot?.target ?? ''}`);
    expect(new Set(slots).size).toBe(slots.length);
  });
});

describe('coverage: the vendors page is the ONLY key surface, so it must cover every slot', () => {
  /**
   * The providers the removed Account key form could write (T-866/F1). The list
   * lived in `providerApiKeyMeta.ts`, which nothing rendered from any more and
   * was deleted; the coverage invariant it guarded is the only reason it existed,
   * so the enumeration moves HERE, next to the assertion that spends it.
   *
   * claude/opencode/codex: facet writers (native_file/cli_stdin), T-866.
   * kimi/deepseek/glm: the hosted-vendor API-key path (ADR-036).
   * qwen: personal Coding Plan key in the same encrypted per-user store.
   */
  const API_KEY_CANDIDATE_PROVIDERS = [
    'claude', 'opencode', 'codex', 'kimi', 'deepseek', 'glm', 'qwen',
  ] as const;

  it('has a row for every provider that can hold an API key', () => {
    // The agent Account tab used to carry its own key form. Removing it (ADR-085)
    // is only safe while this page covers every slot that form could write —
    // otherwise a credential surface disappears silently and a working provider
    // becomes unconfigurable with no error anywhere.
    const covered = new Set(WRITABLE_VENDORS.map((vendor) => vendor.slot!.provider));
    for (const provider of API_KEY_CANDIDATE_PROVIDERS) {
      expect(covered.has(provider), `no vendor row can write ${provider}'s key`).toBe(true);
    }
  });

  it('has a row for every opencode credential target', () => {
    // opencode is the one multi-target provider: four separate records behind one
    // provider id. A missing target is a silently unreachable credential.
    const targets = WRITABLE_VENDORS
      .filter((vendor) => vendor.slot!.provider === 'opencode')
      .map((vendor) => vendor.slot!.target);
    expect(new Set(targets)).toEqual(new Set(['anthropic', 'openai', 'openrouter', 'glm']));
  });
});

describe('agreement with the body × engine matrix', () => {
  it('names a vendor for every pair that has a credential slot', () => {
    // engineKeySlot answers "where does this pair's key go"; the registry
    // answers "whose key is it". A pair with the first and not the second would
    // render a managed-by line pointing at nothing.
    for (const body of ['claude', 'opencode'] as const) {
      for (const cell of bodyEngineCells(body)) {
        const slot = engineKeySlot(body, cell.engine as EngineAxisId);
        if (!slot) {
          continue;
        }
        expect(
          vendorForPair(body, cell.engine),
          `pair ${body}×${cell.engine} has a slot but no vendor`,
        ).not.toBeNull();
      }
    }
  });

  it('resolves a pair and its slot to the SAME vendor', () => {
    // The two lookups come from different directions (by pair, by slot). They
    // must land on one row, or the engines panel and the credentials page would
    // each name a different owner for one key.
    const slot = engineKeySlot('opencode', 'glm');
    expect(slot).toEqual({ provider: 'opencode', target: 'glm' });
    expect(vendorForSlot(slot!.provider, slot!.target)?.id).toBe('zai-opencode');
    expect(vendorForPair('opencode', 'glm')?.id).toBe('zai-opencode');

    const claudeGlm = engineKeySlot('claude', 'glm');
    expect(vendorForSlot(claudeGlm!.provider, claudeGlm!.target)?.id).toBe('zai');
    expect(vendorForPair('claude', 'glm')?.id).toBe('zai');
  });

  it('separates the two Z.AI rows by STORE, not by company', () => {
    // Same vendor company, two credential files: our encrypted store for the
    // Claude engine, opencode's own auth.json for the carrier. Collapsing them
    // would report "stored" for a key the carrier cannot read.
    const engine = vendorForPair('claude', 'glm');
    const carrier = vendorForPair('opencode', 'glm');
    expect(engine?.store).toBe('aes');
    expect(carrier?.store).toBe('cli_file');
    expect(engine?.id).not.toBe(carrier?.id);
  });
});

describe('credential kind', () => {
  it('never claims an engine can authenticate by subscription', () => {
    // The engine seam injects ANTHROPIC_AUTH_TOKEN, a single string. There is no
    // OAuth dance available there — and our OAuth token belongs to Anthropic, so
    // sending it to another vendor would be a credential leak, not a login.
    //
    // B-372 — the assertion used to demand `api_key` exactly, which asks the
    // WRONG question of the WRONG field. `credential` describes the vendor as a
    // whole, and a vendor can serve both axes by different means: Moonshot's
    // BODY has a real subscription path (Kimi Code OAuth, its own base URL and
    // quota pool — ADR-062 §4.6) while its ENGINE takes only a key. `both` is
    // therefore true, and the old form made truthfulness a test failure.
    //
    // What the engine seam actually requires is that a key path EXIST. A vendor
    // that is subscription-ONLY has nothing to inject — that is the real defect
    // this test guards, and it is still caught.
    for (const vendor of VENDORS) {
      const hasEngineConsumer = vendor.consumers.some((consumer) => consumer.axis === 'engine');
      if (hasEngineConsumer) {
        expect(vendor.credential, `${vendor.id} drives an engine`).not.toBe('subscription_oauth');
      }
    }
  });

  it('gives every engine consumer a storable key slot to inject', () => {
    // The complement of the rule above: "has a key path" is only meaningful if
    // the key also has somewhere to be stored. A vendor driving an engine with
    // `slot: null` would render a paste box that writes nowhere (the B-343
    // failure) — or worse, an engine the seam can never authenticate.
    for (const vendor of VENDORS) {
      if (vendor.consumers.some((consumer) => consumer.axis === 'engine')) {
        expect(vendor.slot, `${vendor.id} drives an engine`).not.toBeNull();
      }
    }
  });
});

/**
 * B-363 — the "used by" line promises to enumerate EVERY reader of a secret, so
 * a missing reader is not an omission, it is a false statement. `tool` is the
 * axis that was absent: `delegate_to_vendor` is registered on every Claude spawn
 * and calls kimi/deepseek/glm directly with the stored key, and three separate
 * reviews of this model failed to notice.
 *
 * This is a REVERSE test on purpose. Asserting the rows we just wrote would only
 * restate them; what has to fail is the next reader that ships without a row.
 */
describe('used-by completeness — every key reader has a consumer row (B-363)', () => {
  /** The vendor slots `delegate_to_vendor` reads (vendor-delegate-mcp.js). */
  const DELEGATE_READS = ['kimi', 'deepseek', 'glm'] as const;

  it('every provider the delegate tool spends is declared with a tool consumer', () => {
    for (const provider of DELEGATE_READS) {
      const vendor = VENDORS.find((candidate) => candidate.slot?.provider === provider
        && candidate.slot?.target === undefined);
      expect(vendor, `no vendor owns slot ${provider}`).toBeTruthy();
      expect(
        vendor?.consumers.some((consumer) => consumer.axis === 'tool'),
        `${vendor?.id} is spent by delegate_to_vendor but declares no tool consumer — `
          + 'the "used by" line under-reports who reads this key',
      ).toBe(true);
    }
  });

  it('a tool consumer never invents an engine', () => {
    // `tool` is not a run configuration: it spends the key outside the
    // {body, engine, model} triple, so pinning an engine on it would put a
    // fourth thing into an axis that has exactly three.
    for (const vendor of VENDORS) {
      for (const consumer of vendor.consumers) {
        if (consumer.axis === 'tool') {
          expect(consumer.engine, `${vendor.id} tool consumer names an engine`).toBeUndefined();
        }
      }
    }
  });
});

/**
 * T-1151 — the operator saw "Anthropic" and "Anthropic (OpenCode)" side by side,
 * each with its own paste box, and read one key as two vendors. Grouping by
 * company names the brand once. These tests pin the grouping AND the line it
 * must not cross: the slots stay separate records, because one paste that wrote
 * both would flip a Claude Max subscription to metered billing and would push a
 * member's key into the operator's shared opencode file.
 */
describe('vendor grouping by company (T-1151)', () => {
  it('collapses credential slots into their seven issuing companies', () => {
    const companies = vendorsByCompany();
    expect(companies).toHaveLength(7);
    expect(companies.reduce((n, c) => n + c.vendors.length, 0)).toBe(VENDORS.length);
  });

  it('every company that owns more than one slot labels each of them', () => {
    for (const company of vendorsByCompany()) {
      if (company.vendors.length > 1) {
        for (const vendor of company.vendors) {
          expect(
            vendor.context,
            `${vendor.id} shares a company with siblings but has no sub-label, `
              + 'so its row would be indistinguishable from theirs',
          ).toBeTruthy();
        }
      }
    }
  });

  it('a company keeps one slot per distinct store — grouping is display, not a merge', () => {
    // Anthropic keeps `claude` (settings.json) AND `opencode:anthropic`
    // (auth.json). If a refactor ever collapses them into one record, the write
    // that follows would land in one store and silently claim both.
    const anthropic = vendorsByCompany().find((c) => c.id === 'anthropic');
    expect(anthropic?.vendors.map((v) => v.slot?.provider).sort()).toEqual(['claude', 'opencode']);
  });

  it('every company id has a display name — no row falls back to a slot name', () => {
    for (const company of vendorsByCompany()) {
      expect(COMPANY_NAME[company.id], `no display name for company "${company.id}"`).toBeTruthy();
    }
  });
});

/**
 * لا مفتاحَ لا يُدخَل — الحارس، معاداً صوغُه على قاعدة T-1219.
 *
 * تغيّرت القاعدة ثلاث مرّات: صفحاتُ الوكلاء وحدها (T-1205)، ثم قسمةٌ بين
 * الصفحات والتبويب الجانبي (T-1206)، ثم **منزلٌ واحد** — تبويب «المورّدون
 * والاعتمادات» — لا فرعَ فيه (T-1219). والقسمة هي ما كان يجعل السؤال صعباً:
 * سطحان لسجلٍّ واحد هو شكل B-343، وتفادي اجتماعهما كان يتطلّب اتّفاق ثلاث دوالّ.
 *
 * فبقي على هذا الملفّ — وهو منطقيٌّ لا يُصيّر شيئاً — الشرطُ الذي يستطيع إثباته
 * وحده:
 *
 *   > كلُّ شركة في الكتالوج لها موضعٌ قابل للكتابة، والتبويب يعرض الكتالوج كلَّه.
 *
 * وأنّ الحقل يُصيَّر فعلاً لكل شركة يحرسه `credentialPlacement.test.tsx` بتصيير
 * التبويب نفسه — لأن ذلك وعدٌ عن الشاشة لا عن البيانات.
 */
describe('لا مفتاح لا يُدخَل — المنزل الواحد (T-1219)', () => {
  it('كل شركة في الكتالوج تحمل موضعاً قابلاً للكتابة', () => {
    // شركةٌ بلا موضعٍ تُصيَّر لها بطاقةٌ بحقلٍ لا وجهةَ له: لصقٌ يُقبَل ولا يصل
    // شيئاً — وهو عطلٌ أصمتُ من الغياب، لأن الشاشة تقول «حُفِظ».
    for (const company of vendorsByCompany()) {
      expect(
        company.vendors.some((vendor) => vendor.slot !== null),
        `«${company.name}» بلا موضعٍ قابل للكتابة، فبطاقتها حقلٌ لا وجهةَ له`,
      ).toBe(true);
    }
  });

  it('كل موضع قابل للكتابة تحمله شركةٌ في الكتالوج', () => {
    // الاتجاه المعاكس: موضعٌ لا شركة له لا يبلغه أيُّ سطح، لأن التبويب يرسم
    // الشركات لا المواضع. وهو الشكل الذي كاد DeepSeek يقع فيه قبل T-1206.
    const companies = vendorsByCompany();
    for (const vendor of WRITABLE_VENDORS) {
      expect(
        companies.some((candidate) => candidate.id === vendor.companyId),
        `الموضع «${vendor.id}» بلا شركة في الكتالوج — لا سطحَ يبلغه`,
      ).toBeTruthy();
    }
  });

  it('DeepSeek بلاطتها في الشريط (قريباً T-1760) وحقلها قابل للإدخال من تبويب المورّدين', () => {
    // T-1760 (2026-09-12): deepseek صارت بلاطةً «قريباً» في شريط الوكلاء؛
    // المزوّد معطَّل عالمياً (بلا spawn)، لكنّ البلاطة ظاهرة وتعرض لوح «قريباً».
    // الثابت هنا: حقل المفتاح لا يزال في تبويب المورّدين (T-1219) وهو المنزل
    // الوحيد لكل المفاتيح — استقلالُ وصول المفتاح عن البلاطة لا يزال صحيحاً.
    expect(agentsForCompany('deepseek', visibleSettingsAgents())).toEqual(['deepseek']);
    expect(
      vendorsByCompany().some((company) => company.id === 'deepseek'),
      'DeepSeek خرجت من الكتالوج فخرج حقلُها من الشاشة',
    ).toBe(true);
  });
});

/**
 * التصفية بالمحور — **الخلل الذي صحّحه T-1206**، مثبَّتاً بمثاله الحيّ.
 *
 * `vendorTouchesAgent` كانت تسأل `consumers.some(c => c.body === agent)` بلا أي
 * شرطٍ على `axis`، فهبطت Moonshot وZ.AI وDeepSeek في حساب Claude بجانب Anthropic
 * بنفس الوزن البصري — أربعُ بطاقاتٍ تقول «هذه حساباتك» وواحدةٌ منها صحيحة. وهذا
 * اختبارٌ **عكسيّ** عمداً: لا يعيد صياغة الكتالوج، بل يفشل عند إعادة أي مستهلك
 * غير `body` إلى قرار الموضع.
 */
describe('التصفية بالمحور: الحساب للشركة الأصيلة وحدها (T-1206)', () => {
  const agents = visibleSettingsAgents();

  it('حساب Claude يعرض Anthropic وحدها', () => {
    expect(companiesForAgent('claude').map((company) => company.id)).toEqual(['anthropic']);
  });

  it('حساب OpenCode يعرض أربع شركات — وهو حاملٌ متعدّد المورّدين بحقّ', () => {
    // ليس استثناءً من القاعدة بل تطبيقٌ لها: مواضعه الأربعة كلها
    // `axis:'body', body:'opencode'`، أي أربعُ علاقات مصادقةٍ حقيقية لا أربعُ
    // مستهلكين لمفتاحٍ يملكه غيره.
    expect(companiesForAgent('opencode').map((company) => company.id).sort())
      .toEqual(['anthropic', 'openai', 'openrouter', 'zai']);
  });

  it('لا يمدّ مستهلكُ محرّكٍ ولا مستهلكُ أداةٍ بطاقةً إلى جسمٍ يصرف مفتاحاً لا يملكه', () => {
    // الاختبار العكسي: يمرّ على كل مستهلك ليس `body`، ويتخطّى الحالة التي يكون
    // فيها الموضع نفسه في ملفّ ذلك الجسم (`zai-opencode` داخل `opencode`) —
    // فتلك أصالةٌ بحكم مكان السجلّ لا بحكم المحور. ما يبقى هو الفئة التي شحنت
    // العطل: Moonshot وZ.AI وDeepSeek تحت Claude.
    for (const vendor of VENDORS) {
      for (const consumer of vendor.consumers) {
        if (consumer.axis === 'body') continue;
        if (vendor.slot?.provider === consumer.body) continue;
        expect(
          vendorIsNativeToAgent(vendor, consumer.body),
          `«${vendor.id}» يظهر في حساب «${consumer.body}» بمحور «${consumer.axis}» — `
            + 'الاستهلاك ليس هويّة، ومكانه تبويب المحرّكات',
        ).toBe(false);
      }
    }
  });

  it('يبقي مفتاح Moonshot في حساب Kimi وحده — ويقرؤه Claude من تبويب المحرّكات', () => {
    // قبل T-1206 كان الجواب `['claude','kimi']`: مستهلكا المحرّك والأداة تحت
    // Claude كانا يمدّان البطاقة إلى حسابه.
    expect(agentsForCompany('moonshot', agents)).toEqual(['kimi']);
  });

  it('DeepSeek تظهر تحت نفسها لا تحت Claude — المحور أداة لا جسم تحت Claude', () => {
    // deepseek now has a coming-soon tile in the strip (T-1760), so it appears
    // under its own company. It still does NOT appear under Claude's account tab
    // (that is what this axis test guards): the consumer axis for deepseek on
    // Claude is `tool`, not `body`, so its vendor card belongs to its OWN tile.
    expect(agentsForCompany('deepseek', agents)).toEqual(['deepseek']);
  });

  it('يبقي مفتاح Anthropic ظاهراً تحت Claude وتحت OpenCode — موضعان أصيلان', () => {
    expect(agentsForCompany('anthropic', agents).sort()).toEqual(['claude', 'opencode']);
  });

  it('يصل Z.AI من OpenCode بموضع الحامل، لا من Claude بمحرّكه', () => {
    // ‏`zai-opencode` محوره `engine` لا `body` — قِيس على الكتالوج لا افتُرض —
    // لكن موضعه `{provider:'opencode', target:'glm'}` يعيش في ملفّ OpenCode
    // نفسه، فهو أصيلٌ له ببند الموضع. وبند المحور وحده كان سيُسقط Z.AI من حساب
    // OpenCode ويترك السجلّ `opencode:glm` بلا صفحة البتّة.
    expect(vendorForPair('opencode', 'glm')?.consumers.map((c) => c.axis)).toEqual(['engine']);
    expect(agentsForCompany('zai', agents)).toEqual(['opencode']);
    // وموضع `zai` (محرّك GLM تحت Claude، متجرٌ مشفَّر مختلف) يبقى **داخل بطاقة
    // Z.AI نفسها** هناك، موسوماً بمكانه — مكتوبٌ إليه لا مخفيّ.
    expect(vendorForSlot('glm')?.companyId).toBe('zai');
  });
});
