import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject, ReactNode } from 'react';

import type { SettingsDeepLink } from '../components/settings/types/types';

export type PaletteOps = {
  openFile: (path: string) => void;
  /**
   * ‏`deepLink` اختياري: بطاقة الصادر (B-1076) تفتح تبويب «النظام» مباشرةً على
   * حجب صلاحيةٍ بعينه (فلترته بجلسة المحادثة الحالية أو بلا فلترة) بدل أن
   * تكتفي بفتح التبويب فارغاً ويُترَك المستخدم يبحث بنفسه.
   */
  openSettings: (tab?: string, deepLink?: SettingsDeepLink) => void;
  refreshProjects: () => Promise<void> | void;
};

type Registry = MutableRefObject<Partial<PaletteOps>>;

const PaletteOpsContext = createContext<Registry | null>(null);

const defaultOps: PaletteOps = {
  openFile: () => undefined,
  openSettings: () => undefined,
  refreshProjects: () => undefined,
};

export function PaletteOpsProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Partial<PaletteOps>>({});
  return <PaletteOpsContext.Provider value={ref}>{children}</PaletteOpsContext.Provider>;
}

export function usePaletteOps(): PaletteOps {
  const ref = useContext(PaletteOpsContext);
  return useMemo<PaletteOps>(
    () => ({
      openFile: (path) => (ref?.current.openFile ?? defaultOps.openFile)(path),
      openSettings: (tab, deepLink) => (ref?.current.openSettings ?? defaultOps.openSettings)(tab, deepLink),
      refreshProjects: () => (ref?.current.refreshProjects ?? defaultOps.refreshProjects)(),
    }),
    [ref],
  );
}

export function usePaletteOpsRegister(partial: Partial<PaletteOps>) {
  const ref = useContext(PaletteOpsContext);
  const { openFile, openSettings, refreshProjects } = partial;

  useEffect(() => {
    if (!ref) return undefined;
    const prev = { ...ref.current };
    if (openFile) ref.current.openFile = openFile;
    if (openSettings) ref.current.openSettings = openSettings;
    if (refreshProjects) ref.current.refreshProjects = refreshProjects;
    return () => {
      if (openFile && ref.current.openFile === openFile) ref.current.openFile = prev.openFile;
      if (openSettings && ref.current.openSettings === openSettings) ref.current.openSettings = prev.openSettings;
      if (refreshProjects && ref.current.refreshProjects === refreshProjects) ref.current.refreshProjects = prev.refreshProjects;
    };
  }, [ref, openFile, openSettings, refreshProjects]);
}
