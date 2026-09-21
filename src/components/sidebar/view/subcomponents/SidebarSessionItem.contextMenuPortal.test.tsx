/**
 * B-371 — قائمة الزرّ الأيمن تخرج من الشريط الجانبي، لا تُرسَم بداخله.
 *
 * جذر الشريط (`SidebarContent`) يحمل `backdrop-blur-sm`. وأي `backdrop-filter`
 * يُنشئ containing block لكل `position: fixed` من نسله — فتُقاس `left` من حافة
 * الشريط لا من حافة نافذة العرض. في LTR حافة الشريط اليسرى = 0 فيبدو الأمر
 * سليماً بالمصادفة؛ وفي RTL الشريط ملتصق باليمين، فتُزاح القائمة بمقدار
 * (عرض الشاشة − عرض الشريط) وتخرج خارج الحافة تماماً: المستخدم يضغط الزرّ
 * الأيمن ولا يرى شيئاً.
 *
 * jsdom لا يحسب تخطيطاً ولا `backdrop-filter`، فلا يمكن قياس الإزاحة هنا. ما
 * يُثبَّت بدلاً منها هو الخاصية التي تجعل الإزاحة مستحيلة أصلاً: عقدة القائمة
 * ليست من نسل شجرة الشريط بل ابنة `document.body` مباشرة (بورتال) — وهو نفس
 * النمط المعتمد في SidebarModals وPendingActionsPanel.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/components/sidebar/view/subcomponents/SidebarSessionItem.contextMenuPortal.test.tsx
 */
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar' } }),
}));

const SidebarSessionItem = (await import('./SidebarSessionItem')).default;

const t = ((key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key) as unknown as TFunction;

const project = {
  projectId: 'proj-1',
  displayName: 'nassaj-dev',
  fullPath: '/home/dev/workspace/nassaj',
};

const session = {
  id: 'sess-1',
  summary: 'ضبط الـ RTL',
  createdAt: '2026-07-20T10:00:00.000Z',
  lastActivity: '2026-07-20T12:00:00.000Z',
  messageCount: 3,
  owner: null,
  __provider: 'claude',
} as never;

/** الشريط كما هو حيّاً: عمود RTL ضيّق يحمل الضباب الذي يصنع الـcontaining block. */
const RtlSidebar = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" className="backdrop-blur-sm" style={{ width: 288 }} data-testid="sidebar-root">
    {children}
  </div>
);

function renderRow() {
  return render(
    <SidebarSessionItem
      project={project}
      session={session}
      selectedSession={null}
      isStarred={false}
      onToggleStar={() => {}}
      currentTime={new Date('2026-07-20T13:00:00.000Z')}
      editingSession={null}
      editingSessionName=""
      onEditingSessionNameChange={() => {}}
      onStartEditingSession={() => {}}
      onCancelEditingSession={() => {}}
      onSaveEditingSession={() => {}}
      onProjectSelect={() => {}}
      onSessionSelect={() => {}}
      onDeleteSession={() => {}}
      t={t}
    />,
    { wrapper: RtlSidebar },
  );
}

afterEach(cleanup);

describe('SidebarSessionItem — قائمة السياق تُسقَط خارج الشريط', () => {
  it('يثبت قائمة زر الثلاث نقاط أسفل الزر حتى قرب نهاية الشاشة', () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });

    renderRow();
    // زرّان بالاسم نفسه: واحد لشجرة اللمس وآخر لشجرة الفأرة، يُخفي كلٌّ منهما
    // الآخرَ باستعلام وسائط لا يحسبه jsdom. الحساب واحد فيكفي أولهما.
    const [trigger] = screen.getAllByRole('button', { name: 'tooltips.sessionContextMenu' });
    // design-ok: DOMRect فيزيائي بطبيعته (left/right/top/bottom) — لا مقابل منطقي له.
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 372,
      right: 400,
      top: 520,
      bottom: 548,
    } as DOMRect);
    fireEvent.click(trigger);

    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('244px');
    expect(menu.style.top).toBe('548px');
    expect(menu.style.bottom).toBe('');
    expect(menu.style.maxHeight).toBe('42px');

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  });

  it('تفتح بالزرّ الأيمن وتُركَّب ابنةً لـ document.body لا داخل الشريط', () => {
    const { container } = renderRow();

    // الصفّ يُرسَم مرّتين (بطاقة الموبايل ومرساة سطح المكتب)؛ المرساة تحمل
    // المستمع نفسه، والحدث لا يهبط للأبناء فيلزم استهدافها هي.
    const anchor = container.querySelector('a')!;
    expect(anchor).not.toBeNull();
    fireEvent.contextMenu(anchor);

    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);

    const sidebarRoot = screen.getByTestId('sidebar-root');
    expect(sidebarRoot.contains(menu)).toBe(false);
  });

  /**
   * زرّ ⋮ موحَّد في الطبقة: يظهر بالتحويم على فتحة المشاركين وبالنقر اللمسي
   * وبلوحة المفاتيح (focus-visible على الرابط). الزرّ المستقلّ للمس حُذف؛
   * الطبقة تخدم كلا المسارَين (ADR-2026-09).
   */
  it('يعرض مُطلِق القائمة في الطبقة الموحَّدة، مرئي عبر التحويم واللمس', () => {
    const { container } = renderRow();

    const triggers = Array.from(
      container.querySelectorAll<HTMLElement>('[data-session-menu-trigger]'),
    );
    // مُطلِق واحد فقط — الطبقة تخدم الفأرة واللمس معاً
    expect(triggers).toHaveLength(1);

    // المُطلِق داخل الطبقة التي تظهر بالتحويم على فتحة المشاركين
    const overlay = triggers[0].closest('[data-session-actions-overlay]');
    expect(overlay).not.toBeNull();
    // الطبقة تظهر بـ group-hover/avatar-slot (لا مجرّد group-hover عام على الرابط)
    expect(overlay?.classList.contains('[@media(hover:hover)]:group-hover/avatar-slot:flex')).toBe(true);
    // المُطلِق نفسه لا يحمل قيداً [@media(hover:hover)]:hidden — مرئي للمس أيضاً
    expect(triggers[0].className).not.toContain('[@media(hover:hover)]:hidden');
  });
});
