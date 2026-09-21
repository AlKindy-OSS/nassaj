import { useEffect } from 'react';

/**
 * إغلاق قائمة السياق: نقرة خارجها، أو Escape، أو فتح قائمة أخرى (B-379).
 *
 * كانت كل قائمة تستمع لـ`mousedown` وحده. وعلى اللمس **لا يوجد `mousedown`
 * أصلاً**: الضغط المطوّل يولّد `pointerdown` ثم `contextmenu` مباشرة، فلا يصل
 * الحارس شيء وتبقى القائمة السابقة مفتوحة. النتيجة على الجوال: قائمة لكل صفّ
 * لُمس، كلها مكدّسة فوق بعضها في الحيّز نفسه. (لم تكن تُرى قبل B-371 لأن
 * القوائم كانت تُقذف خارج الشاشة في RTL أصلاً — العلّتان مستقلّتان.)
 *
 * ‏`pointerdown` يغطّي الفأرة واللمس والقلم معاً، وهو يسبق `contextmenu` دائماً،
 * فالقائمة القديمة تُغلق قبل أن تُفتح الجديدة.
 *
 * وحده الحدث المشترك أدناه يغطّي الحالة التي لا يمرّ فيها `pointerdown` خارج
 * القائمة (فتح قائمة من كود آخر، أو مسارات لوحة المفاتيح): كل قائمة تُعلن عن
 * فتحها، ومن سمع إعلاناً ليس إعلانه أغلق نفسه. فلا تُرى قائمتان معاً أبداً.
 */
const OPEN_EVENT = 'nassaj:sidebar-context-menu-open';

/** يُنادى لحظة فتح قائمة — يُغلق كل ما سواها. */
export function announceContextMenuOpen(token: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: token }));
}

export function useDismissableContextMenu(
  isOpen: boolean,
  menuRef: { current: HTMLElement | null },
  close: () => void,
  token: string,
): void {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        close();
      }
    };

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };

    const handleOtherMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== token) {
        close();
      }
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown);
    document.addEventListener('keydown', handleEscapeKey);
    window.addEventListener(OPEN_EVENT, handleOtherMenuOpen);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown);
      document.removeEventListener('keydown', handleEscapeKey);
      window.removeEventListener(OPEN_EVENT, handleOtherMenuOpen);
    };
  }, [isOpen, menuRef, close, token]);
}
