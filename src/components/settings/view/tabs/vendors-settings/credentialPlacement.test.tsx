/**
 * credentialPlacement.test.tsx — **منزلٌ واحد لكل حقل مفتاح** (‏T-1219).
 *
 * ثلاثة وعود، وأوّلها هو القاعدة كلّها:
 *
 *  1. **لا مفاتيح في صفحة أيّ وكيل — لا حقلاً ولا حالة** (‏T-1223). يُصيَّر تبويبُ
 *     «الحساب» لكلِّ وكيلٍ ظاهر، ويُطلَب فيه أثرٌ للمفتاح: حقلٌ، أو اسمُ شركةٍ من
 *     الكتالوج. وجودُ أيٍّ منهما إخفاق.
 *
 *     وT-1219 كان يحرس نصفَ هذا: نفى الحقل وأبقى صفَّ الحالة، فبقيت «Anthropic ·
 *     لا مفتاح مخزَّن» مطبوعةً في شاشتين — نفسُ المعلومة في مكانين، وهو الازدواج
 *     الذي رصده المالك. فالحارس الآن ينفي **المحور كلَّه** عن هذه الصفحة: المفتاح
 *     محورُ الشركة، والصفحة محورُ الوكيل.
 *  2. **ولكلِّ شركةٍ في الكتالوج حقلٌ في تبويب المورّدين.** الاتجاه المعاكس، وهو
 *     ما يمنع أن يتحوّل «منزلٌ واحد» إلى «لا منزل»: مفتاحٌ لا سطحَ له هو العطل
 *     الصامت الذي كاد DeepSeek يقع فيه (لا شاشة، ولا رسالة خطأ، ومفتاحٌ لا
 *     يُلصق).
 *  3. **`vendorIds` صريحٌ في كل حفظ.** الخادم يقرأ غيابها بمعنى «كل مواضع
 *     الشركة»، فبطاقةٌ معروضٌ فيها موضعٌ واحد كانت تطلب الكتابة في مواضع لا تظهر
 *     على الشاشة. انتقل هذا الوعد مع البطاقة إلى منزلها الجديد، ولم يتغيّر.
 *
 * وصفحةُ الوكيل تبقى **ناطقةً**: الوعد الأول ينفي الحقل لا المعلومة، ولذلك يُفحص
 * معه أن الصفّ المرجعي يقول اسم الشركة وأين تُدار — وإلّا لكان «لا حقل» قد
 * تحقَّق بحذف القسم كلّه، وهو ما يجعل صفحة OpenCode تصمت عن أربعة مفاتيح تحكم
 * عملها.
 *
 * تُصيَّر المكوّنات الحقيقية على `fetch` مزيَّف، لأن العقد المفحوص يعيش في الفجوة
 * بين ما يجيب به الخادم وما تردّه الواجهة إليه.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom. ‏`NODE_ENV=test` إلزامي.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ‏`t` مزيَّفة **تستبدل `{{x}}`** بخلاف بقيّة ملفات هذا المجلّد.
 *
 * وهي ليست رفاهية هنا: الوعد المفحوص أن الوسم يسمّي **المكان الصحيح**، فلو
 * أُرجعت اللصيقة حرفيّةً (`Save {{company}} key`) لمرّ الاختبار وهو لا يعلم أيّ
 * شركةٍ سُمّيت — وهو بالضبط الخطأ الذي يفحصه.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        opts && name in opts ? String(opts[name]) : whole);
    },
    i18n: { language: 'en' },
  }),
}));

const fetchMock = vi.fn();
vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import { vendorsByCompany } from '../../../../../../shared/vendors';

import VendorsSettingsTab from './VendorsSettingsTab';

/** حالةُ كل شركة كما يجيب بها الخادم — مواضعُها من الكتالوج نفسه. */
const SLOTS: Record<string, Array<Record<string, unknown>>> = {
  anthropic: [
    { vendorId: 'anthropic', provider: 'claude', configured: false, subscription: true },
    {
      vendorId: 'anthropic-opencode',
      provider: 'opencode',
      target: 'anthropic',
      configured: false,
      subscription: false,
    },
  ],
  openai: [
    { vendorId: 'openai', provider: 'codex', configured: false, subscription: true },
    {
      vendorId: 'openai-opencode',
      provider: 'opencode',
      target: 'openai',
      configured: false,
      subscription: false,
    },
  ],
  zai: [
    { vendorId: 'zai', provider: 'glm', configured: false, subscription: false },
    {
      vendorId: 'zai-opencode',
      provider: 'opencode',
      target: 'glm',
      configured: false,
      subscription: false,
    },
  ],
  openrouter: [
    {
      vendorId: 'openrouter',
      provider: 'opencode',
      target: 'openrouter',
      configured: false,
      subscription: false,
    },
  ],
  moonshot: [{ vendorId: 'moonshot', provider: 'kimi', configured: false, subscription: false }],
  deepseek: [{ vendorId: 'deepseek', provider: 'deepseek', configured: false, subscription: false }],
};

let writes: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];

function stubServer() {
  writes = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      writes.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : {},
      });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { slots: [] } }),
      });
    }
    const companyId = /\/company\/([^/]+)\/key/.exec(url)?.[1] ?? '';
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: { companyId, writable: true, slots: SLOTS[companyId] ?? [] },
      }),
    });
  });
}

/**
 * سطح اعتماد واحد لكل شركة: حقل مفتاح تقليدي، أو إجراء اتصال مُدار (Qwen).
 * Alibaba موجودة في registry لكن اعتماد Qwen يمرّ بحوار الاتصال الحالي، لذلك
 * قياس inputs وحدها كان يعدّ ست شركات من أصل سبع رغم وجود السطح السابع فعلاً.
 */
const companyFields = (root: ParentNode = document) =>
  Array.from(
    root.querySelectorAll<HTMLInputElement | HTMLElement>(
      'input[id^="company-api-key-"], [data-company-credential-action]',
    ),
  ).map((node) =>
    node.dataset.companyCredentialAction ?? node.id.replace('company-api-key-', ''),
  );

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe('لا مفاتيح في صفحة الوكيل — المحور كلُّه لا الحقل وحده (T-1223)', () => {
  /**
   * **يُقاس بالاستيراد لا بالتصيير.**
   *
   * أوّل صياغةٍ صيّرت `AgentCategoryContentSection` لكل وكيل وبحثت عن حقلٍ أو اسمِ
   * شركة. وهي تجرّ نصفَ التطبيق (‏`Trans`، `initReactI18next`، لوحةَ رسمٍ لا تُنفَّذ
   * في jsdom)، فيصير الحارسُ هشّاً بمزيّفاتٍ تُصلَح كلَّما تحرّك مكوّنٌ بعيد — وحارسٌ
   * يُصلَح كثيراً يُعطَّل مرّةً.
   *
   * وسطحُ المفاتيح لا يظهر في صفحة الوكيل إلّا بأن **يستورده ملفٌّ فيها**: بطاقةَ
   * الشركة، أو خطّافَها الذي يقرأ حالتها. فالاستيراد هو الباب، وإغلاقُه يقينيٌّ
   * ورخيص ولا يتعلّق بشجرة تصيير.
   */
  const AGENT_TREE = path.join(process.cwd(), 'src/components/settings/view/tabs/agents-settings');

  /** كل ملفّات صفحة الوكيل، عدا الاختبارات. */
  function agentSurfaceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...agentSurfaceFiles(full));
      else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) out.push(full);
    }
    return out;
  }

  const files = agentSurfaceFiles(AGENT_TREE);

  it('تُقرأ ملفّات صفحة الوكيل أصلاً — وإلّا لحرس هذا الوعدُ فراغاً', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(['CompanyCredentialCard', 'useCompanyKey'])(
    'لا ملفَّ في صفحة الوكيل يستورد «%s»',
    (symbol) => {
      const offenders = files.filter((file) => {
        const src = readFileSync(file, 'utf8');
        return new RegExp(`import[^;]*${symbol}[^;]*from`).test(src);
      });
      expect(
        offenders.map((file) => path.relative(process.cwd(), file)),
        `«${symbol}» عاد إلى صفحة الوكيل — المفتاح محورُ الشركة، والصفحة محورُ الوكيل`,
      ).toEqual([]);
    },
  );

  it('لا مكوّنَ اسمُه يَعِد بسطح مفاتيحَ داخل صفحة الوكيل', () => {
    // ‏`AgentVendorCredentials` كان الملفّ الذي حمل المحورَ الثاني، وحُذف في
    // T-1223. عودتُه باسمه هي عودةُ الازدواج بعينه.
    expect(files.filter((file) => file.includes('AgentVendorCredentials'))).toEqual([]);
  });
});

describe('المنزل الواحد يسع الكتالوج كلَّه (T-1219)', () => {
  it('لكل شركة في الكتالوج حقلٌ في تبويب المورّدين', async () => {
    stubServer();
    const { container } = render(<VendorsSettingsTab />);

    const expected = vendorsByCompany().map((company) => company.id).sort();
    await waitFor(() => expect(companyFields(container).length).toBe(expected.length));

    // ‏«منزلٌ واحد» لا يجوز أن يعني «لا منزل»: شركةٌ سقطت من هنا صارت مفتاحاً لا
    // يُلصق في أيّ مكان، بلا رسالة خطأ — العطل الصامت الذي كُتب الحارس لأجله.
    expect(companyFields(container).sort()).toEqual(expected);
  });
});

describe('‏`vendorIds` صريحٌ في كل حفظ — العطل النشط (T-1206، منقولاً)', () => {
  /**
   * الحالة التي كانت تكسر: **بطاقةٌ بلا قائمة اختيار**. كان الشرط
   * `needsChoice && slots.length > 0 ? chosenIds : undefined`، فبطاقةُ OpenRouter
   * (موضعٌ واحد، بلا اشتراك ⇒ لا مربّعات) كانت ترسل `undefined` — والخادم يقرؤها
   * «كل مواضع الشركة».
   */
  it('يسمّي الموضع على السلك حتى حين لا تكون هناك مربّعات أصلاً', async () => {
    stubServer();
    render(<VendorsSettingsTab />);
    const field = () => document.getElementById('company-api-key-openrouter') as HTMLInputElement;
    await waitFor(() => expect(field()).not.toBeNull());

    // بلا مربّعات: موضعٌ واحد غير مصادَقٍ باشتراك.
    expect(document.getElementById('vendor-slot-openrouter')).toBeNull();

    fireEvent.change(field(), { target: { value: 'sk-or-1' } });
    fireEvent.click(screen.getByLabelText('Save OpenRouter key'));

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const write = writes.find((entry) => entry.url.includes('/company/openrouter/key'))!;
    expect(write, 'لم يُرسَل حفظٌ إلى OpenRouter أصلاً').toBeTruthy();
    expect(
      write.body.vendorIds,
      'الغياب يعني عند الخادم «كل المواضع» — فالحقل يُرسل صريحاً دائماً',
    ).toEqual(['openrouter']);
  });

  it('لا يرسل الموضع غير المحدَّد حتى حين تُعرض مواضع الشركة كلها', async () => {
    stubServer();
    render(<VendorsSettingsTab />);
    const field = () => document.getElementById('company-api-key-anthropic') as HTMLInputElement;
    await waitFor(() => expect(field()).not.toBeNull());

    fireEvent.change(field(), { target: { value: 'sk-ant-1' } });
    fireEvent.click(screen.getByLabelText('Save Anthropic key'));

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    // موضع `claude` داخلٌ باشتراكه فيبدأ بلا تحديد؛ الوجهة الوحيدة المطلوبة هي
    // ملفّ OpenCode.
    const write = writes.find((entry) => entry.url.includes('/company/anthropic/key'))!;
    expect(write.body.vendorIds).toEqual(['anthropic-opencode']);
    expect(write.body.includeSubscription).toBe(false);
  });
});
