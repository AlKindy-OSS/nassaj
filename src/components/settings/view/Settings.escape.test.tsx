/**
 * اختبارات سلوك Escape والتركيز في صدفة مودال الإعدادات.
 *
 * الاختبارات تفحص:
 * 1. Escape لا تُغلق الإعدادات عند وجود مودال متداخل مفتوح.
 * 2. Escape تُغلق ProviderLoginModal (لا الإعدادات) عند فتحه.
 * 3. التركيز يعود إلى العنصر الذي فتح الإعدادات عند الإغلاق.
 *
 * النهج: مكوّنات أدنى من Settings الكاملة تحاكي السلوك المطلوب
 * بنفس الخطاف (useEffect) الذي يستخدمه Settings.tsx — بدلاً من
 * محاكاة كل تبعيّات الصدفة (auth / i18n / websocket).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasActiveNestedDialog, resolveEscapeTarget } from './settingsDialogHelpers';

afterEach(cleanup);

// ─── مكوّن تجريبي يُعيد إنتاج منطق Settings لكن بلا تبعيّاته الثقيلة ───────

function TestSettingsShell({
  onClose,
  showLoginModal = false,
  onCloseLoginModal,
  children,
}: {
  onClose: () => void;
  showLoginModal?: boolean;
  onCloseLoginModal?: () => void;
  children?: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const showLoginModalRef = useRef(showLoginModal);
  const openerRef = useRef<HTMLElement | null>(null);
  const handleClose = useCallback(() => onClose(), [onClose]);

  // مزامنة المرجع مع الـprop
  useEffect(() => { showLoginModalRef.current = showLoginModal; }, [showLoginModal]);

  // حفظ التركيز واستعادته
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      openerRef.current?.focus();
      openerRef.current = null;
    };
  }, []);

  // معالج Escape — نفس منطق Settings.tsx
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = resolveEscapeTarget({
        hasNestedDialog: hasActiveNestedDialog(dialogRef.current),
        showLoginModal: showLoginModalRef.current,
      });
      if (target === 'none') return;
      e.preventDefault();
      if (target === 'login-modal') { onCloseLoginModal?.(); return; }
      handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, onCloseLoginModal]);

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Settings">
      {children}
    </div>
  );
}

// ─── الاختبارات ──────────────────────────────────────────────────────────────

describe('Settings — Escape والتركيز', () => {
  it('1a: Escape تُغلق الإعدادات حين لا يوجد مودال متداخل', () => {
    const onClose = vi.fn();
    render(<TestSettingsShell onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('1b: Escape لا تُغلق الإعدادات حين يوجد مودال متداخل (role=dialog)', () => {
    const onClose = vi.fn();
    render(
      <TestSettingsShell onClose={onClose}>
        {/* مودال متداخل — مثل ResetPasswordModal */}
        <div role="dialog" aria-label="Nested modal">
          <button>Nested action</button>
        </div>
      </TestSettingsShell>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('2: Escape تُغلق ProviderLoginModal لا الإعدادات حين يكون مفتوحاً', () => {
    const onClose = vi.fn();
    const onCloseLoginModal = vi.fn();
    render(
      <TestSettingsShell
        onClose={onClose}
        showLoginModal
        onCloseLoginModal={onCloseLoginModal}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onCloseLoginModal).toHaveBeenCalledOnce();
  });

  it('3: التركيز يعود إلى العنصر الذي كان له تركيز عند فتح الإعدادات', () => {
    // زرّ خارج الإعدادات كان له التركيز عند الفتح
    const { unmount } = render(
      <div>
        <button id="opener">Open settings</button>
        <TestSettingsShell onClose={vi.fn()}>
          <button id="inner">Inner button</button>
        </TestSettingsShell>
      </div>,
    );
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();
    // فتح Settings — يحفظ التركيز الحالي (opener)
    const { unmount: unmountShell } = render(
      <TestSettingsShell onClose={vi.fn()}>
        <button id="inner2">Inner</button>
      </TestSettingsShell>,
    );
    // التحقّق من أن التركيز الحالي قبل الإغلاق ليس على opener
    document.getElementById('inner2')?.focus();
    // إغلاق Settings (unmount يُطلق cleanup لـuseEffect)
    unmountShell();
    // بعد الإغلاق يجب أن يعود التركيز إلى opener
    expect(document.activeElement).toBe(opener);
    unmount();
  });

  it('1d: Settings تبقى مفتوحة عند فتح ResetPasswordModal ثم الضغط على Escape', () => {
    // يُحاكي ResetPasswordModal: مستمع document يستدعي preventDefault ثم onClose.
    // بسبب تسلسل React (child effect قبل parent): ResetPasswordModal يُسجَّل أولاً،
    // فيُطلَق أولاً، يستدعي preventDefault — يرى Settings defaultPrevented=true ويعود فوراً.
    const onCloseSettings = vi.fn();
    const onCloseNestedModal = vi.fn();

    function NestedModalSimulator({ onClose }: { onClose: () => void }) {
      useEffect(() => {
        const handler = (e: KeyboardEvent) => {
          if (e.key !== 'Escape' || e.defaultPrevented) return;
          e.preventDefault();
          onClose();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
      }, [onClose]);
      return <div role="dialog" aria-label="Nested modal"><button>action</button></div>;
    }

    render(
      <TestSettingsShell onClose={onCloseSettings}>
        <NestedModalSimulator onClose={onCloseNestedModal} />
      </TestSettingsShell>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCloseSettings).not.toHaveBeenCalled();
    expect(onCloseNestedModal).toHaveBeenCalledOnce();
  });

  it('1c: Escape التي قيَّدها مستمع آخر (defaultPrevented) لا تُنفَّذ', () => {
    const onClose = vi.fn();
    render(<TestSettingsShell onClose={onClose} />);
    // مستمع في مرحلة الالتقاط يستدعي preventDefault قبل وصول الحدث إلى مستمعنا
    const captureHandler = (e: KeyboardEvent) => { e.preventDefault(); };
    document.addEventListener('keydown', captureHandler, true);
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', captureHandler, true);
    }
  });
});
