import { createContext, useContext } from 'react';

import type { CatalogAction, RunActionOpts } from '../../../hooks/useServerActionCatalog';
import type { ExecuteOutcome, PublicAction } from '../../../hooks/useServerActions';
import type { UserRole } from '../../auth/types';

/**
 * ChatActionsContext — T-947 F3
 *
 * يوفّره MessageComponent لرسائل المساعد فقط، مُمرَّراً إلى CodeBlock عبر
 * react context بدل props drilling عبر ReactMarkdown.
 *
 * القيمة الافتراضية: inlineExecEnabled=false → CodeBlock لا يُظهر زر التنفيذ
 * خارج رسائل المساعد (أداة، نتيجة، تفكير…).
 */

export type ChatActionsContextValue = {
  catalog: CatalogAction[];
  runAction: (actionType: string, opts?: RunActionOpts) => Promise<ExecuteOutcome>;
  userRole: UserRole | undefined;
  /** true فقط لرسائل المساعد الرئيسية — ليس لكتل tool use أو reasoning */
  inlineExecEnabled: boolean;
  /**
   * حالة الطابور الحيّة لفعلٍ ما (T-947 F4) — تربط زر inline بلوحة الأوامر:
   * تنفيذ/إدراج من النافذة ينعكس لحظيّاً على زر المحادثة والعكس.
   */
  liveStatusOf: (actionType: string) => PublicAction['status'] | null;
};

const _defaultRunAction = async (): Promise<ExecuteOutcome> => ({
  status: 'error' as const,
  code: 'not_initialized',
});

export const ChatActionsContext = createContext<ChatActionsContextValue>({
  catalog: [],
  runAction: _defaultRunAction,
  userRole: undefined,
  inlineExecEnabled: false,
  liveStatusOf: () => null,
});

export function useChatActions(): ChatActionsContextValue {
  return useContext(ChatActionsContext);
}
