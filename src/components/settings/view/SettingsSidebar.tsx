import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { PillBar, Pill } from '../../../shared/view/ui';
import { useAuth } from '../../auth';
import { SETTINGS_MAIN_TABS } from '../constants/constants';
import type { SettingsMainTab } from '../types/types';

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
};

export default function SettingsSidebar({ activeTab, onChange }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const role = user?.role;

  // RBAC: hide role-restricted tabs (e.g. Users, Command Board) from unauthorized roles.
  const navItems = SETTINGS_MAIN_TABS.filter(
    (item) => !item.roles || (role ? item.roles.includes(role) : false),
  );

  // T-1036: no queue badge here. Queued commands are shown, reviewed and run in
  // the sidebar command board; a badge pointing INTO settings would send the
  // owner to a tab that no longer holds them.
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-56 flex-shrink-0 border-e border-border bg-muted/30 md:flex md:flex-col">
        <nav className="flex flex-col gap-1 p-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => onChange(item.id)}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-start text-sm font-medium transition-colors duration-150',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground active:bg-accent/50',
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {t(item.labelKey)}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Mobile horizontal nav — pill bar */}
      <div className="flex-shrink-0 border-b border-border px-3 py-2 md:hidden">
        <PillBar className="scrollbar-hide w-full overflow-x-auto">
          {navItems.map((item) => {
            const Icon = item.icon;

            return (
              <Pill
                key={item.id}
                isActive={activeTab === item.id}
                onClick={() => onChange(item.id)}
                className="flex-shrink-0"
              >
                <Icon className="h-3.5 w-3.5" />
                {t(item.labelKey)}
              </Pill>
            );
          })}
        </PillBar>
      </div>
    </>
  );
}
