import { createContext, useContext } from 'react';

/**
 * Cross-tab links inside the settings modal (ADR-200 S9). The vendor card points
 * at an agent's account page (where the link mode lives) and the account page
 * points back at the vendor card (where the key lives). Both sit several
 * components below `Settings`, which owns the tab state, so the two moves ride a
 * context instead of a prop chain. Outside the modal the value is `null` and
 * the links simply do not render.
 */
export type SettingsNavigation = {
  openAgentAccount: (agent: 'claude' | 'codex') => void;
  openVendors: (companyId: string) => void;
};

const SettingsNavigationContext = createContext<SettingsNavigation | null>(null);

export const SettingsNavigationProvider = SettingsNavigationContext.Provider;

export function useSettingsNavigation(): SettingsNavigation | null {
  return useContext(SettingsNavigationContext);
}
