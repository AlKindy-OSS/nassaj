import { useEffect, useState } from 'react';

import { IS_PLATFORM } from '../../../constants/config';
import { detectSsoStatus, type SsoStatus } from '../oidc';

/**
 * The server's SSO status (ADR-194 D1) once known, else `null`. Stays `null`
 * on the platform build (which has no local sign-in at all) and while the
 * probe runs, so the SSO affordance never flashes on a server where it is off.
 */
export function useSsoStatus(): SsoStatus | null {
  const [status, setStatus] = useState<SsoStatus | null>(null);

  useEffect(() => {
    if (IS_PLATFORM) {
      return undefined;
    }
    let isActive = true;
    void detectSsoStatus().then((value) => {
      if (isActive) {
        setStatus(value);
      }
    }).catch(() => {
      // Detection failure keeps the SSO affordance hidden.
    });
    return () => {
      isActive = false;
    };
  }, []);

  return status;
}

/** True once the server is known to accept an SSO sign-in right now. */
export function useOidcAvailability(): boolean {
  return useSsoStatus()?.loginAvailable === true;
}
