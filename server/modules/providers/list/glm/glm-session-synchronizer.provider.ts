import { VendorSessionSynchronizer } from '@/modules/providers/shared/vendor/vendor-session-synchronizer.provider.js';

/**
 * GLM session indexer: scans the nassaj-owned GLM transcript tree and upserts
 * discovered sessions into sessionsDb via the shared vendor synchronizer.
 */
export class GlmSessionSynchronizer extends VendorSessionSynchronizer {
  constructor() {
    super('glm');
  }
}
