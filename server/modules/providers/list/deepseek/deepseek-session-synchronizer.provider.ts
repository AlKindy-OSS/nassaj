import { VendorSessionSynchronizer } from '@/modules/providers/shared/vendor/vendor-session-synchronizer.provider.js';

/**
 * DeepSeek session indexer: scans the nassaj-owned DeepSeek transcript tree and
 * upserts discovered sessions into sessionsDb via the shared vendor synchronizer.
 */
export class DeepSeekSessionSynchronizer extends VendorSessionSynchronizer {
  constructor() {
    super('deepseek');
  }
}
