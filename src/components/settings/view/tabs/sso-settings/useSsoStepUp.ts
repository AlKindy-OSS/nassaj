/**
 * One shared step-up dialog for every guarded SSO write. `requestStepUp`
 * opens the dialog and resolves with the write's final result, or `null`
 * when the owner cancelled.
 */
import { useCallback, useRef, useState } from 'react';

import type { SsoActionResult, StepUpEvidence } from './ssoTypes';

type Pending = {
  run: (stepUp: StepUpEvidence) => Promise<SsoActionResult>;
};

export function useSsoStepUp() {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolver = useRef<((result: SsoActionResult | null) => void) | null>(null);

  const finish = useCallback((result: SsoActionResult | null) => {
    resolver.current?.(result);
    resolver.current = null;
    setPending(null);
  }, []);

  const requestStepUp = useCallback((run: Pending['run']) => {
    resolver.current?.(null);
    return new Promise<SsoActionResult | null>((resolve) => {
      resolver.current = resolve;
      setPending({ run });
    });
  }, []);

  return {
    requestStepUp,
    dialogProps: {
      open: pending !== null,
      onClose: () => finish(null),
      onSubmit: (stepUp: StepUpEvidence) => pending ? pending.run(stepUp) : Promise.resolve({ ok: false, code: 'step_up_required', status: 403 } as const),
      onDone: (result: SsoActionResult) => finish(result),
    },
  };
}
