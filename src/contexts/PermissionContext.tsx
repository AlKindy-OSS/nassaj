import { createContext, useContext } from 'react';

import type { PendingPermissionRequest } from '../components/chat/types/types';

export interface PermissionContextValue {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  /** ADR-173: how the signed-in user may answer `request`; absent = the starter's controls. */
  answerRole?: (request: PendingPermissionRequest) => 'starter' | 'non_starter' | 'read_only';
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

export function usePermission(): PermissionContextValue | null {
  return useContext(PermissionContext);
}

export default PermissionContext;
