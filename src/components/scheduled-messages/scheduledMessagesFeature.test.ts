import { describe, expect, it } from 'vitest';

import { isScheduledMessagesCenterEnabled } from './scheduledMessagesFeature';

describe('scheduled messages center rollout', () => {
  it('defaults to enabled for every authenticated role (server scopes per user)', () => {
    expect(isScheduledMessagesCenterEnabled('owner', undefined)).toBe(true);
    expect(isScheduledMessagesCenterEnabled('admin', undefined)).toBe(true);
    expect(isScheduledMessagesCenterEnabled('member', undefined)).toBe(true);
    expect(isScheduledMessagesCenterEnabled('user', undefined)).toBe(true);
  });

  it('defaults to disabled for unauthenticated (null / empty role)', () => {
    expect(isScheduledMessagesCenterEnabled(null, undefined)).toBe(false);
    expect(isScheduledMessagesCenterEnabled(undefined, undefined)).toBe(false);
    expect(isScheduledMessagesCenterEnabled('', undefined)).toBe(false);
  });

  it('supports explicit all and off build-time modes', () => {
    expect(isScheduledMessagesCenterEnabled('member', 'all')).toBe(true);
    expect(isScheduledMessagesCenterEnabled('member', '1')).toBe(true);
    expect(isScheduledMessagesCenterEnabled('owner', 'off')).toBe(false);
    expect(isScheduledMessagesCenterEnabled('admin', '0')).toBe(false);
  });
});
