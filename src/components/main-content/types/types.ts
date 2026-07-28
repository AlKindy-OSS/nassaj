import type { Dispatch, SetStateAction } from 'react';

import type { AppTab, Project, ProjectSession } from '../../../types/app';
import type { SessionNavigationOptions } from '../../chat/types/types';
import type { TerminalSummary } from '../../terminals/types/types';

export type SessionLifecycleHandler = (sessionId?: string | null) => void;

export type MainContentProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  latestMessage: unknown;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onInputFocusChange: (focused: boolean) => void;
  onSessionActive: SessionLifecycleHandler;
  onSessionInactive: SessionLifecycleHandler;
  onSessionProcessing: SessionLifecycleHandler;
  onSessionNotProcessing: SessionLifecycleHandler;
  processingSessions: Set<string>;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  /**
   * ADR-076 الموجة 1أ: فتح الإعدادات، وقد يحمل وجهةً للربط العميق.
   * وُسّع نظير `SidebarProps.onShowSettings` الذي سبقه إلى نفس التوقيع —
   * كان هذا المستهلك الوحيد المتخلّف عنه، فأخفق AppContent:407 بالأنواع.
   */
  onShowSettings: (dest?: import('../../settings/types/types').SettingsDeepLink) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  // Standalone terminals (T-939) — rendered full-area when activeTab==='terminal',
  // owned by AppContent's shared controller.
  terminals: TerminalSummary[];
  selectedTerminalId: string | null;
  onRenameTerminal: (id: string, title: string) => void;
  onDeleteTerminal: (id: string) => void;
  onCloseTerminal: () => void;
  onRefreshTerminals: () => void;
};

export type MainContentHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  isMobile: boolean;
  onMenuClick: () => void;
};

export type MainContentStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
};

export type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};
