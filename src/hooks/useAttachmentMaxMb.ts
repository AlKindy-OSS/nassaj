import { useEffect, useSyncExternalStore } from 'react';

import {
  ensureStoragePolicyLoaded,
  getAttachmentMaxMb,
  refreshAttachmentLimit,
  subscribeStoragePolicy,
} from '../utils/storagePolicy';

/**
 * Per-file attachment cap in MB from the owner's storage policy. Returns the
 * 50 MB default until the policy loads (or if it cannot be read), and follows
 * later saves from the settings screen without a reload. It re-reads the limit
 * when the page regains focus or becomes visible, so a raised limit reaches
 * pages that were already open.
 */
export function useAttachmentMaxMb(): number {
  useEffect(() => {
    ensureStoragePolicyLoaded();
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') refreshAttachmentLimit();
    };
    window.addEventListener('focus', refreshAttachmentLimit);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refreshAttachmentLimit);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return useSyncExternalStore(subscribeStoragePolicy, getAttachmentMaxMb, getAttachmentMaxMb);
}
