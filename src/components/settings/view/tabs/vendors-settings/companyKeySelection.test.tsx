/**
 * companyKeySelection.test.tsx — ONE input per company, and the checkbox list
 * that replaced the per-slot boxes (T-1201).
 *
 * WHAT SHIPPED AND WHY IT WAS WRONG. Anthropic rendered THREE inputs for ONE
 * key: a company field plus a field per slot under "per-place setup", each with
 * its own Save. Three boxes for one secret is three chances for them to
 * disagree, and the operator's objection was blunt — «أبغى المستخدم يضيف
 * المفتاح مرة وحدة». The value is one; only the destinations are many.
 *
 * WHAT THESE TESTS PIN, and why each is a promise rather than a layout detail:
 *
 *  1. ONE input per company. The regression is silent: a second entry box
 *     reappears the moment someone re-adds a per-slot component, and nothing
 *     else in the suite would notice.
 *  2. A SUBSCRIBED SLOT STARTS UNTICKED. Claude Code reads `settings.json`
 *     before its OAuth record, so a key pasted onto a subscribed harness turns
 *     a Max plan into metered API billing. A pre-ticked box would be inviting
 *     the operator to override a guard they never knew existed.
 *  3. TICKING IT COSTS AN EXPLICIT WARNING FIRST, shown before the save, which
 *     is the only moment it can still change the outcome.
 *  4. THE REQUEST CARRIES THE TICKED IDS ONLY, and asks for the subscription
 *     override exactly when a subscribed slot was ticked.
 *
 * These drive the real component against a stubbed fetch, for the same reason
 * `vendorKeyEntryVisibility.test.tsx` does: the contract under test lives in the
 * gap between what the server answers and what the surface sends back.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
  }),
}));

const fetchMock = vi.fn();
vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

// ‏T-1205 نقل السطح المُصيَّر هنا من `VendorsSettingsTab` إلى قسم الاعتماد داخل
// صفحة وكيل Claude، وT-1219 أعاده — لا رجوعاً عن قرار، بل لأن الحقل صار له منزلٌ
// واحد بلا فرع (صفحة الوكيل تعرض حالةً لا حقلاً). ولم يتغيّر شيءٌ ممّا يفحصه هذا
// الملف في الرحلتين — البطاقة مكوّنٌ واحد لم يتفرّع قط — والدليل أن كل توقّعٍ
// أدناه بقي حرفياً كما كان في الصيغتين.
import VendorsSettingsTab from './VendorsSettingsTab';

/**
 * The stubbed `t` above returns `defaultValue` VERBATIM — no interpolation — so
 * an aria-label reads `Save {{vendor}} key` here rather than `Save Anthropic
 * key`. Queried through these helpers on purpose: matching the interpolated
 * text would pass only because i18next happened to run, and this suite mocks it
 * away exactly so a missing translation cannot fail a behavioural test.
 * Anthropic is the first company in the catalog, hence index 0.
 */
const saveButton = () => screen.getAllByLabelText('Save {{vendor}} key')[0] as HTMLButtonElement;
const removeButton = () =>
  screen.getAllByLabelText('Remove the stored key from {{slot}}')[0] as HTMLButtonElement;

/** Anthropic: the claude slot held by a live subscription, opencode by nothing. */
const ANTHROPIC_SLOTS = [
  { vendorId: 'anthropic', provider: 'claude', configured: false, subscription: true },
  {
    vendorId: 'anthropic-opencode',
    provider: 'opencode',
    target: 'anthropic',
    configured: true,
    subscription: false,
  },
];

/** Every write the surface attempted, decoded. */
let writes: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];

function mountWithAnthropic() {
  writes = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      writes.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : {},
      });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { slots: [] } }) });
    }
    const data = url.includes('/company/anthropic/key')
      ? { companyId: 'anthropic', writable: true, slots: ANTHROPIC_SLOTS }
      : { companyId: 'other', writable: true, slots: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
  });
  // ‏Anthropic أول شركة في الكتالوج، ومنه بقي فهرس 0 أعلاه صحيحاً. ومواضعها
  // **كلها** معروضة في بطاقتها، بما فيها «داخل OpenCode»: مفتاحٌ واحد لمواضع
  // متعدّدة — وهو ما يجعل المنزل الواحد صحيحاً لا تعسّفياً.
  const view = render(<VendorsSettingsTab />);
  // ‏T-1223 — المواضع صارت مطويّةً خلف زرّ: قرارٌ يُتّخذ مرّةً لا كتلةٌ تُعرض في كل
  // زيارة. وما يفحصه هذا الملفّ سلوكُ المربّعات لا موضعُها، فيُفتح الطيُّ أوّلاً —
  // وهو نفسه ما يفعله المالك حين يريدها.
  const toggle = document.querySelector('[aria-controls="company-api-key-anthropic-places"]');
  if (toggle) fireEvent.click(toggle);
  return view;
}

const keyField = () => document.getElementById('company-api-key-anthropic') as HTMLInputElement;
const claudeBox = () => document.getElementById('vendor-slot-anthropic') as HTMLInputElement;
const opencodeBox = () =>
  document.getElementById('vendor-slot-anthropic-opencode') as HTMLInputElement;

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe('one field per company, checkboxes for the places (T-1201)', () => {
  it('renders exactly one key input for Anthropic, not one per slot', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(keyField()).not.toBeNull());

    // The old surface had `company-api-key-anthropic` PLUS `vendor-api-key-*`
    // for each slot. Any input whose id starts with `vendor-api-key-` is the
    // duplicated chore coming back.
    expect(
      document.querySelectorAll('input[id^="vendor-api-key-"]'),
      'a per-slot entry box reappeared — the key would have two sources of truth',
    ).toHaveLength(0);
  });

  it('leaves a subscribed place unticked, and ticks the rest', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(claudeBox()).not.toBeNull());

    expect(claudeBox().checked, 'a subscribed harness must not be pre-selected').toBe(false);
    expect(opencodeBox().checked).toBe(true);
  });

  it('warns explicitly, before the save, when a subscribed place is ticked', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(claudeBox()).not.toBeNull());

    expect(screen.queryByText(/billing moves to metered API usage/i)).toBeNull();
    fireEvent.click(claudeBox());
    expect(
      screen.getByText(/billing moves to metered API usage/i),
      'the plan-downgrade warning must be readable before the key is handed over',
    ).toBeTruthy();
  });

  it('sends only the ticked places, and no subscription override', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(keyField()).not.toBeNull());

    fireEvent.change(keyField(), { target: { value: 'sk-test-1' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const write = writes[0];
    expect(write.url).toContain('/company/anthropic/key');
    expect(write.body.vendorIds).toEqual(['anthropic-opencode']);
    expect(write.body.includeSubscription).toBe(false);
    expect(write.body.apiKey).toBe('sk-test-1');
  });

  it('asks for the override only once the subscribed place is ticked', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(claudeBox()).not.toBeNull());

    fireEvent.click(claudeBox());
    fireEvent.change(keyField(), { target: { value: 'sk-test-2' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0].body.vendorIds).toEqual(['anthropic', 'anthropic-opencode']);
    expect(writes[0].body.includeSubscription).toBe(true);
  });

  it('removes from ONE place, naming it on the wire', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(opencodeBox()).not.toBeNull());

    // Only the opencode slot holds a key, so only it offers a Remove button.
    fireEvent.click(removeButton());

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes[0].method).toBe('DELETE');
    expect(writes[0].url).toContain('vendorIds=anthropic-opencode');
  });

  it('refuses to save with nothing ticked instead of posting an empty scope', async () => {
    mountWithAnthropic();
    await waitFor(() => expect(opencodeBox()).not.toBeNull());

    fireEvent.click(opencodeBox());
    fireEvent.change(keyField(), { target: { value: 'sk-test-3' } });

    expect(saveButton().disabled).toBe(true);
    // نطاقٌ مضيَّق إلى بطاقة الشركة المعنية: المواضع صارت تُرسم من الكتالوج فور
    // التركيب لا بعد ردّ الخادم، فشركةٌ أخرى موضعُها الوحيد اشتراكٌ تبدأ هي
    // كذلك بلا تحديد وتعرض النصّ نفسه — وذلك سلوكٌ صحيح لا تصادم.
    const card = document.querySelector('[data-company="anthropic"]') as HTMLElement;
    expect(within(card).getByText(/Tick at least one place/i)).toBeTruthy();
  });
});
