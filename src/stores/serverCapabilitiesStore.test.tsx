import { afterEach, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { publishServerCapabilities, resetServerCapabilitiesForTests, useInternalSessionChatCapability } from './serverCapabilitiesStore';

afterEach(() => resetServerCapabilitiesForTests());

it('accepts only the enabled v1 internal-chat health capability', () => {
  const { result } = renderHook(() => useInternalSessionChatCapability());
  act(() => publishServerCapabilities({ capabilities: { internalSessionChat: { supported: true, enabled: true, schema: 1 } } }));
  expect(result.current).toEqual({ resolved: true, enabled: true });
  act(() => publishServerCapabilities({ capabilities: { internalSessionChat: { supported: true, enabled: true, schema: 2 } } }));
  expect(result.current).toEqual({ resolved: true, enabled: false });
});
