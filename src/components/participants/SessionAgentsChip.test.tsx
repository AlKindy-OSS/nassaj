/**
 * SessionAgentsChip.test.tsx — B-397
 *
 * الخاصية: الرأس لا يعرض إلا اسم النموذج الحالي، بينما تحتفظ اللوحة بكل
 * تفاصيل المشغّل والمزوّد وتاريخ النماذج والوكلاء الفرعيين.
 *
 * Run: NODE_ENV=test npx vitest run \
 *        src/components/participants/SessionAgentsChip.test.tsx
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import type { TFunction } from 'i18next';

import { ThemeProvider } from '../../contexts/ThemeContext';

import SessionAgentsChip from './SessionAgentsChip';
import type { SessionAgent } from './types';

afterEach(cleanup);

// Interpolates EVERY {{var}} from the options, not just {{count}}: a stub that
// silently leaves `{{harness}}` in place turns a missing value into a passing
// assertion on the literal braces.
const t = ((key: string, opts?: Record<string, unknown>) => {
  // Mirrors i18next's plural-suffixed defaults (`defaultValue_one` /
  // `defaultValue_other`) as well as the plain one; a stub that only knew
  // `defaultValue` echoed the raw key back and made the assertion meaningless.
  const plural = opts?.count === 1 ? 'defaultValue_one' : 'defaultValue_other';
  const fallback =
    (opts?.[plural] as string) ?? (opts?.defaultValue as string) ?? key;
  return fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(opts?.[name] ?? ''),
  );
}) as unknown as TFunction;

const model = (name: string, count: number, provider?: string): SessionAgent => ({
  agent_name: name,
  agent_kind: 'model',
  invocation_count: count,
  agent_model: name,
  agent_provider: provider ?? null,
});

const subagent = (name: string, count: number): SessionAgent => ({
  agent_name: name,
  agent_kind: 'subagent',
  invocation_count: count,
  agent_model: 'claude-opus-5',
});

// ThemeProvider: the harness mark resolves brand SVGs that read the active
// theme (SessionProviderLogo → CodexLogo/…), so a bare render throws.
const mount = (agents: SessionAgent[], harness?: string | null) =>
  render(
    <ThemeProvider>
      <SessionAgentsChip agents={agents} harness={harness} t={t} dir="rtl" />
    </ThemeProvider>,
  );

const trigger = () => screen.getByRole('button');
const panel = () => screen.getByRole('dialog');

describe('SessionAgentsChip — الوجه المطوي', () => {
  it('يعرض اسم النموذج الحالي وحده داخل جزيرة LTR، بلا تفاصيل تشخيصية', () => {
    const { container } = mount([
      model('kimi-k3', 2, 'moonshot'),
      model('claude-opus-5', 3, 'anthropic'),
      subagent('frontend-dev', 9),
    ], 'codex');

    const face = trigger().textContent ?? '';
    expect(face.trim()).toBe('claude-opus-5');
    expect(face).not.toContain('Anthropic');
    expect(face).not.toContain('Codex');
    expect(face).not.toContain('kimi-k3');
    expect(face).not.toContain('frontend-dev');
    expect(face).not.toMatch(/\+\d|\d·\d|calls?|agents?/);
    const name = container.querySelector('button bdi');
    expect(name?.getAttribute('dir')).toBe('ltr');
    expect(name?.className).toContain('truncate');
    expect(trigger().getAttribute('aria-label')).not.toContain('claude-opus-5');
  });

  it('يستخدم fallback مترجماً مختصراً إذا وُجد وكلاء بلا نموذج حالي', () => {
    mount([subagent('qa-critic', 2)]);
    expect(trigger().textContent?.trim()).toBe('Actors');
  });

  it('trigger شفاف بلا حد أو ظل، مع focus واضح وحالة فتح ghost', () => {
    mount([model('claude-opus-5', 2, 'anthropic')]);
    const button = trigger();
    const tokens = button.className.split(/\s+/);
    expect(tokens).toContain('bg-transparent');
    expect(tokens).toContain('hover:bg-accent/80');
    expect(tokens).toContain('focus-visible:ring-2');
    expect(tokens).not.toContain('border');
    expect(tokens).not.toContain('shadow-sm');

    fireEvent.click(button);
    expect(button.className.split(/\s+/)).toContain('bg-accent/80');
  });

  it('صفر أطراف = لا زرّ (الرأس لا يحمل عنصراً فارغاً)', () => {
    const { container } = render(<SessionAgentsChip agents={[]} t={t} dir="rtl" />);
    expect(container.firstChild).toBeNull();
  });
});

describe('SessionAgentsChip — اللوحة', () => {
  const agents = [
    model('kimi-k3', 2),
    model('kimi-k2.6', 1),
    model('claude-opus-5', 4, 'anthropic'),
    subagent('frontend-dev', 9),
    subagent('researcher', 1),
  ];

  // B-410: لوحةٌ تغطّي الشاشة ولا تحبس التركيز تُخرج مستخدم الكيبورد إلى ضوابط
  // لا يراها، وإغلاقها كان يُسقط التركيز على body فيبدأ Tab من رأس الصفحة.
  it('تُعلن نفسها modal، وتأخذ التركيز عند الفتح وتعيده إلى الزرّ عند الإغلاق', () => {
    mount([model('claude-opus-5', 2, 'anthropic'), subagent('qa-critic', 1)]);
    const button = trigger();

    fireEvent.click(button);
    expect(panel().getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(panel());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('لا تُفتح إلا بالنقر، وتُغلق بـEscape', () => {
    mount(agents);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger());
    expect(panel()).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('تحوي كل نموذج مرّ على المحادثة بترتيب أول ظهور (B-352)', () => {
    mount(agents, 'codex');
    fireEvent.click(trigger());

    const rows = within(panel()).getAllByRole('listitem');
    const modelRows = rows.slice(0, 3).map((r) => r.textContent ?? '');

    expect(modelRows[0]).toContain('kimi-k3');
    expect(modelRows[0]).toContain('Earlier');
    expect(modelRows[1]).toContain('kimi-k2.6');
    expect(modelRows[2]).toContain('claude-opus-5');
    expect(modelRows[2]).toContain('Current');
    expect(panel().textContent).toContain('Codex');
    expect(modelRows[2]).toContain('Anthropic');
  });

  it('عدّاد النموذج يُقرأ «أدوار» لا «استدعاءات» — النموذج لا يُستدعى وكيلاً', () => {
    mount(agents);
    fireEvent.click(trigger());

    const rows = within(panel()).getAllByRole('listitem');
    expect(rows[2].textContent).toContain('4 turns');
    // بينما الوكيل الفرعي يبقى «استدعاءات»: تلك استدعاءات فعلية لأداة Agent.
    expect(rows[3].textContent).toContain('9 invocations');
  });

  it('تحوي كل وكيل فرعي', () => {
    mount(agents);
    fireEvent.click(trigger());

    const text = panel().textContent ?? '';
    expect(text).toContain('frontend-dev');
    expect(text).toContain('researcher');
    expect(text).toContain('2 agents');
    expect(text).toContain('10 calls');
  });

  it('موديل الوكيل يظهر حين يخالف النموذج المُجيب، ويُطوى حين يطابقه', () => {
    const مطابق: SessionAgent = {
      agent_name: 'scribe',
      agent_kind: 'subagent',
      invocation_count: 1,
      agent_model: 'claude-opus-5',
    };
    const مخالف: SessionAgent = {
      agent_name: 'tester',
      agent_kind: 'subagent',
      invocation_count: 1,
      agent_model: 'claude-haiku-4-5',
    };
    mount([model('claude-opus-5', 3, 'anthropic'), مطابق, مخالف]);
    fireEvent.click(trigger());

    const rows = within(panel()).getAllByRole('listitem');
    const scribeRow = rows.find((r) => r.textContent?.includes('scribe'));
    const testerRow = rows.find((r) => r.textContent?.includes('tester'));

    // المطابق: عمودٌ ثالث مكرّر لا يضيف شيئاً — يُحذف.
    expect(scribeRow?.textContent).not.toContain('claude-opus-5');
    // المخالف: هو وحده الخبر — يبقى.
    expect(testerRow?.textContent).toContain('claude-haiku-4-5');
  });
});
