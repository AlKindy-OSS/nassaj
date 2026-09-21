import { VendorSessionSynchronizer } from '@/modules/providers/shared/vendor/vendor-session-synchronizer.provider.js';

/**
 * Kimi session indexer: scans the nassaj-owned Kimi transcript tree and upserts
 * discovered sessions into sessionsDb via the shared vendor synchronizer.
 */
export class KimiSessionSynchronizer extends VendorSessionSynchronizer {
  constructor() {
    super('kimi');
  }
}
