/**
 * One shared step-up dialog for every guarded SSO write. `requestStepUp`
 * opens the dialog and resolves with the write's final result, or `null`
 * when the owner cancelled.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';

import type { SsoActionResult, StepUpEvidence } from './ssoTypes';

type Pending = {
  run: (stepUp: StepUpEvidence) => Promise<SsoActionResult>;
  intro?: ReactNode;
};

export function useSsoStepUp() {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolver = useRef<((result: SsoActionResult | null) => void) | null>(null);

  const finish = useCallback((result: SsoActionResult | null) => {
    resolver.current?.(result);
    resolver.current = null;
    setPending(null);
  }, []);

  const requestStepUp = useCallback((run: Pending['run'], intro?: ReactNode) => {
    resolver.current?.(null);
    return new Promise<SsoActionResult | null>((resolve) => {
      resolver.current = resolve;
      setPending({ run, intro });
    });
  }, []);

  return {
    requestStepUp,
    dialogProps: {
      open: pending !== null,
      intro: pending?.intro,
      onClose: () => finish(null),
      onSubmit: (stepUp: StepUpEvidence) => pending ? pending.run(stepUp) : Promise.resolve({ ok: false, code: 'step_up_required', status: 403 } as const),
      onDone: (result: SsoActionResult) => finish(result),
    },
  };
}
