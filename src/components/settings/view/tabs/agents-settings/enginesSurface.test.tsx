/**
 * enginesSurface.test.tsx — the engine axis, now read inside the body it belongs to.
 *
 * History this file carries forward. The 2026-07-26 fold removed the GLM card
 * from the Agents screen — correctly, because that screen lists agent SYSTEMS (a
 * body with a CLI, tools, sessions) and GLM has no body. But that card was also
 * the ONLY way to write `getProviderKey(userId, 'glm')`, so folding it away
 * silently removed the only path to store an engine key (B-217). The repair gave
 * engines a surface of their own, as a top-level tab beside Agents.
 *
 * That tab was right about the axis and wrong about the place: engines listed
 * with no body in sight, bodies listed with no engine in sight, and the question
 * both axes exist to answer — *what can THIS agent run on?* — asked by neither.
 * The axis now lives as a category of each agent, next to its permissions.
 *
 * These tests assert what the operator actually sees and can do:
 *   - the settings shell no longer offers a top-level Engines destination, and
 *     the Agents destination it moved into is untouched;
 *   - each body shows ITS OWN engines — Claude's row is not Codex's row;
 *   - the endpoint each engine will really be called on is shown (truthfulness:
 *     z.ai's own guide advertises "you see a Claude model while GLM runs" — the
 *     exact thing this surface must never do);
 *   - evidence is rendered, so an inference is never dressed as a demonstration;
 *   - a key entry appears only where a key is the remaining barrier, never on a
 *     cell that is closed at the vendor;
 *   - the status reflects the live key store, and never asserts "connected";
 *   - saving/removing a key hits that engine's own endpoint.
 *
 * `t` resolves against the REAL en/settings.json, so a missing label fails here
 * instead of silently rendering an English defaultValue in every locale.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enSettings from '../../../../../i18n/locales/en/settings.json';

function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    enSettings,
  );
  return typeof value === 'string' ? value : undefined;
}

/** Mirrors i18next interpolation closely enough for assertions. */
function interpolate(template: string, opts?: Record<string, unknown>): string {
  if (!opts) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    opts[name] === undefined ? whole : String(opts[name]),
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      interpolate(lookup(key) ?? (opts?.defaultValue as string) ?? key, opts),
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('../../../../auth', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }),
}));

// The key store is reached through authenticatedFetch; script it per test.
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let configuredByProvider: Record<string, boolean> = {};

vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    const provider = /\/api\/providers\/([^/]+)\/api-key/.exec(url)?.[1] ?? '';
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      configuredByProvider[provider] = true;
    } else if (method === 'DELETE') {
      configuredByProvider[provider] = false;
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: { provider, configured: Boolean(configuredByProvider[provider]) },
      }),
    } as unknown as Response;
  }),
}));

import SettingsSidebar from '../../SettingsSidebar';
import {
  BODY_AXIS_IDS,
  actionableEngineCells,
  bodyEngineCells,
  engineKeySlot,
} from '../../../../../../shared/bodyEngineMatrix';

import EnginesContent, { resolveRowStatus } from './sections/content/EnginesContent';

/** نصّ الحالة الجديدة قبل إدراج مفتاحها في ملفات اللغات (`defaultValue`). */
const UNPLACED_LABEL = 'Needs a key — no field for it here yet';

beforeEach(() => {
  fetchCalls.length = 0;
  configuredByProvider = {};
});

afterEach(cleanup);

describe('the settings shell no longer splits the two axes', () => {
  it('offers no top-level Engines destination', () => {
    render(<SettingsSidebar activeTab="agents" onChange={() => {}} />);
    expect(screen.queryAllByRole('button', { name: /^engines$/i })).toHaveLength(0);
  });

  it('keeps the Agents destination the engines moved into', () => {
    render(<SettingsSidebar activeTab="agents" onChange={() => {}} />);
    expect(screen.getAllByRole('button', { name: /agents/i }).length).toBeGreaterThan(0);
  });
});

describe('a body shows its own engines', () => {
  it('lists the Claude body row, GLM included', async () => {
    render(<EnginesContent agent="claude" />);
    await waitFor(() => expect(screen.getByText('GLM')).toBeTruthy());
    expect(screen.getByText('Anthropic')).toBeTruthy();
    expect(screen.getByText('Kimi')).toBeTruthy();
  });

  it('does not show one body row on another body', async () => {
    // T-1152 — codex can no longer serve as the contrast: every cell it declares
    // is a barrier, so the panel now renders nothing at all for it (see below).
    // opencode still has actionable cells, and its GLM reason is its own.
    render(<EnginesContent agent="opencode" />);
    await waitFor(() => expect(screen.getByText(lookup('engines.cell.opencodeGlm')!)).toBeTruthy());
    expect(screen.queryByText(lookup('engines.cell.claudeGlm')!)).toBeNull();
  });

  it('names the endpoint each engine will really be called on', async () => {
    render(<EnginesContent agent="claude" />);
    await waitFor(() => expect(screen.getByText('api.z.ai')).toBeTruthy());
    expect(screen.getByText('api.moonshot.ai')).toBeTruthy();
  });

  it('marks a measured cell apart from an inferred one', async () => {
    // Read on opencode, not claude (B-375): every actionable cell the Claude row
    // now declares is measured, so it can no longer show the contrast. opencode
    // still carries both — GLM measured, Zen inferred.
    render(<EnginesContent agent="opencode" />);
    await waitFor(() => expect(screen.getAllByText(lookup('engines.evidence.measured')!).length).toBeGreaterThan(0));
    expect(screen.getAllByText(lookup('engines.evidence.inferred')!).length).toBeGreaterThan(0);
  });
});

describe('ADR-085 — one resolved status per row, and no second writer', () => {
  /**
   * ‏**من «لا لوح» إلى «لوحٌ يقول لا»** (‏T-1232).
   *
   * كان الوعد: جسمٌ كلُّ خلاياه حاجزٌ لا يُصيَّر له شيء — لا رأس ولا صفوف — و
   * `bodyHasEngineAxis` تقرأ نفس المحمول فيغيب تبويبُه أيضاً. وهو صحيحٌ ضدّ
   * اللوح الأبيض، وخاطئٌ عند القارئ: خمسةُ وكلاء بلا تبويب محرّكات قرأها المالك
   * فوضى («ليش بعضهم فيهم وبعضهم لا»)، لأن الغياب لا يقول «لا بديل لهذا الوكيل»
   * — هو لا يقول شيئاً.
   *
   * فالوعدُ المحفوظ هو الذي كان يستحقّ الحفظ: **لا صفوف، ولا حقلَ إدخالٍ البتّة**
   * (‏ADR-085: كاتبٌ واحد لكل سرّ). والمضاف: جملةٌ تُسمّي الحقيقة.
   */
  it('يعرض جملةً لا صفوفاً لجسمٍ كلُّ خلاياه حاجز (T-1152 ثم T-1232)', () => {
    const { container } = render(<EnginesContent agent="codex" />);

    // لا صفوفَ محرّكات: لا اسمَ محرّكٍ ولا شارةَ حالةٍ ولا مضيف.
    expect(screen.queryByText('GLM')).toBeNull();
    expect(screen.queryByText('api.z.ai')).toBeNull();
    // ولا حقلَ إدخالٍ: هذا اللوح يذكر القدرة ولا يجمع سرّاً، بجملةٍ أو بصفوف.
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    // والجملة موجودة — الغياب صار معلومة.
    expect(container.textContent).toContain(lookup('engines.noAlternative')!);
  });

  it('drops "needs a key" once the key is stored, and never invents a measurement', () => {
    // Asserted on the mapping itself (B-375). Claude × Kimi was the rendered
    // example until it became `available` — measured, four sessions and 40
    // kimi-k3 replies — and no cell with a key slot declares blocked_by_owner
    // today. The rule is not gone with its example:
    //   • a stored key makes "all that is missing is a key" false → `ready`;
    //   • it does NOT make it `available`. Paying for a key proves nothing about
    //     the endpoint; conflating the two is the "GLM is connected" badge shown
    //     for a path that had never returned a token.
    expect(resolveRowStatus('blocked_by_owner', 'stored')).toBe('ready');
    expect(resolveRowStatus('blocked_by_owner', 'missing')).toBe('needs_credential');
    expect(resolveRowStatus('available', 'missing')).toBe('needs_credential');
    expect(resolveRowStatus('available', 'stored')).toBe('available');
    // Before the store answers, the declared cell stands unmodified.
    expect(resolveRowStatus('blocked_by_owner', 'loading')).toBe('blocked_by_owner');
  });

  it('does NOT promote a stored credential to "runs today"', async () => {
    // The same rule where the operator meets it. opencode's GLM carrier has a
    // key and is measured, so it reads `available`; the cells beside it
    // that only ever needed a purchase are NOT dragged along by that key: each
    // row is resolved against its own slot, and Anthropic/Zen/Kimi/DeepSeek —
    // four rows — keep saying so.
    //
    // B-415/م-1 — وما تقوله تلك الأربعة تغيّر: لا موضعَ مفتاحٍ لأيٍّ منها
    // (`engineKeySlot` = null)، فشارتُها الكهرمانية «ينقصه مفتاح» كانت تعِد
    // بحاجزٍ يرفعه القارئ ولا تقول أين يُرفع. صارت تسمّي حالها.
    configuredByProvider = { opencode: true };
    render(<EnginesContent agent="opencode" />);
    await waitFor(() => expect(screen.getAllByText(lookup('engines.status.available')!).length).toBe(1));
    expect(screen.queryAllByText(lookup('engines.status.blocked_by_owner')!)).toHaveLength(0);
    // المفتاح `engines.status.blockedUnplaced` ينتظر الإدراج في ملفات اللغات،
    // فالنصّ هنا هو `defaultValue` الذي يُصيَّر حتى ذلك الحين.
    expect(screen.getAllByText(UNPLACED_LABEL)).toHaveLength(4);
  });

  /**
   * الحارس — **نبرةُ التحذير وعدٌ بفعل، فلا تُصبغ على زوجٍ لا فعلَ فيه** (م-1).
   *
   * `EnginesContent` تعرّف `warning` بأنها «الاعتماد وحده هو الحائل: شيءٌ يستطيع
   * القارئ رفعه». فالقاعدة الآلية تقرأ التعريف حرفياً: خليّةٌ نبرتُها تحذير ⇒ لها
   * موضعُ مفتاحٍ يُكتب فيه. سبع خلايا كانت تخرق ذلك، ولا شيء كان يمنع الثامنة.
   */
  it('لا شارة كهرمانية على زوجٍ بلا موضع مفتاح — الحارس', () => {
    for (const body of BODY_AXIS_IDS) {
      for (const cell of actionableEngineCells(body)) {
        const hasSlot = engineKeySlot(body, cell.engine) !== null;
        for (const credential of ['none', 'loading', 'stored', 'missing'] as const) {
          const status = resolveRowStatus(cell.status, credential, hasSlot);
          const warns = status === 'blocked_by_owner' || status === 'needs_credential';
          expect(
            !warns || hasSlot,
            `${body}×${cell.engine} (${credential}) تُصبغ إنذاراً بلا حقلٍ ولا وجهة`,
          ).toBe(true);
        }
      }
    }
  });

  /**
   * والحارس المقابل — **حاجزٌ برمجيّ لا يُصنَّف شراءً** (م-2).
   *
   * صفّ `kimi` كان يحمل الحكمين لحاجزٍ واحد: `kimi × glm` = «ينتظر حارس التهيئة»،
   * و`kimi × anthropic/deepseek/zen` = «ينقصه مفتاح». والحارس المفقود حارسُ **جسم**
   * (ADR-073 §4)، فهو يمنع الأربعة بالسواء. القاعدة: جسمٌ لا يملك محرّكاً واحداً
   * على الأقل مرفوعَ الحارس لا يجوز أن يقول عن أيٍّ من محرّكاته «ينقصه مفتاح».
   */
  it('جسمٌ محجوزٌ بحارسٍ لا يُعلن أي محرّكٍ فيه حاجزَ شراء — الحارس', () => {
    for (const body of BODY_AXIS_IDS) {
      const cells = bodyEngineCells(body);
      const guarded = cells.some((cell) => cell.status === 'blocked_by_us');
      // ‏`available` وحدها تنفي الحارس: `native` محرّك الجسم نفسه ولا يمرّ من
      // بوّابة التهيئة أصلاً، فوجودُه لا يقول شيئاً عن محرّكٍ خارجي. (claude
      // وopencode يخرجان هنا بحقّ: كلاهما يُشغّل محرّكاً خارجياً اليوم، فحواجزهما
      // الباقية شراءٌ فعلاً.)
      const runsCustomEngine = cells.some((cell) => cell.status === 'available');
      if (!guarded || runsCustomEngine) continue;
      for (const cell of cells) {
        expect(
          cell.status,
          `${body}×${cell.engine} تُصنَّف شراءً بينما حارسُ الجسم نفسه يمنع الإطلاق`,
        ).not.toBe('blocked_by_owner');
      }
    }
  });

  it('names the VENDOR when a credential is what is missing', async () => {
    // The operator buys from a company: looking for "Kimi" on a billing console
    // finds nothing, and the row must say Moonshot.
    configuredByProvider = { glm: true, kimi: false };
    render(<EnginesContent agent="claude" />);
    await waitFor(() =>
      expect(
        screen.getByText(interpolate(lookup('engines.status.needsCredential')!, { vendor: 'Moonshot' })),
      ).toBeTruthy(),
    );
  });

  // ‏T-1205 ثم T-1206 ثم T-1219 — الوجهة تغيّرت ثلاث مرّات والقاعدة لم تتغيّر:
  // **مؤشّرٌ واحد لكل صفٍّ ينقصه اعتماد، ولا مؤشّر على صفٍّ مفتاحُه مخزَّن.**
  // وما تغيّر هو الوجهة نفسها: صارت تبويب «المورّدون والاعتمادات» لكل مفتاح بلا
  // استثناء، فسقطت معها جملةُ «حساب الوكيل المالك» — وهي التي كانت صحيحةً يوم
  // كان للمفتاح حسابٌ يُدخل فيه.
  it('points at the one credential home, and only while the credential is the barrier', async () => {
    configuredByProvider = { glm: true, kimi: false };
    render(<EnginesContent agent="claude" />);
    const pointer = lookup('engines.managedInVendors')!;
    await waitFor(() => expect(screen.getAllByText(pointer).length).toBeGreaterThan(0));

    // العدد يُقاس بعدد الصفوف التي تقول «ينقصه اعتماد» لا برقمٍ مكتوب هنا: رقمٌ
    // ثابت يوثِّق كتالوجَ اليوم فيسقط عند إضافة محرّكٍ جديد بلا عطلٍ حقيقي، وهو
    // ما وقع فعلاً حين أُهّل DeepSeek محرّكاً (B-424).
    const needsCredential = screen.getAllByText(
      new RegExp(lookup('engines.status.needsCredential')!.replace('{{vendor}}', '.+')),
    ).length;
    expect(needsCredential).toBeGreaterThan(0);
    expect(
      screen.getAllByText(pointer).length,
      'مؤشّرٌ لكل صفٍّ ينقصه مفتاح، ولا مؤشّرَ على صفٍّ مخزَّن — تكرارُ «مخزَّن · يُدار هناك» '
        + 'تحت شارةٍ تقولها أصلاً هو ما جعل المؤشّرين ينحرفان',
    ).toBe(needsCredential);

    // ولا تُقال «حساب هذا الوكيل» ولا «حساب الوكيل المالك»: كلتاهما تسمّي مكاناً
    // لا حقلَ فيه بعد اليوم.
    expect(screen.queryAllByText(lookup('engines.managedInAccount')!)).toHaveLength(0);
  });

  it('writes nothing: no control and no mutating request', async () => {
    configuredByProvider = { glm: true, kimi: false };
    render(<EnginesContent agent="claude" />);
    await waitFor(() =>
      expect(
        screen.getByText(interpolate(lookup('engines.status.needsCredential')!, { vendor: 'Moonshot' })),
      ).toBeTruthy(),
    );

    // One writer per secret (ADR-085).
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    const mutating = fetchCalls.filter((c) => (c.init?.method ?? 'GET').toUpperCase() !== 'GET');
    expect(mutating).toHaveLength(0);
  });
});
