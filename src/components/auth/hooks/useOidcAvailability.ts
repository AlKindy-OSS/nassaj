import { useEffect, useState } from 'react';

import { IS_PLATFORM } from '../../../constants/config';
import { detectOidcAvailability } from '../oidc';

/**
 * True once the server is known to have OIDC enabled. Starts `false` so the SSO
 * affordance never flashes on a server where it is off, and stays `false` on
 * the platform build (which has no local sign-in at all).
 */
export function useOidcAvailability(): boolean {
  const [isEnabled, setIsEnabled] = useState(false);

  useEffect(() => {
    if (IS_PLATFORM) {
      return undefined;
    }
    let isActive = true;
    void detectOidcAvailability().then((value) => {
      if (isActive) {
        setIsEnabled(value);
      }
    }).catch(() => {
      // Detection failure keeps the SSO affordance hidden.
    });
    return () => {
      isActive = false;
    };
  }, []);

  return isEnabled;
}
