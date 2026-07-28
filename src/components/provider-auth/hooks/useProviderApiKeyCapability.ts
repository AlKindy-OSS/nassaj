import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';

export type ProviderCredentialWriteMethod = 'native_file' | 'cli_stdin' | 'none';

export type ProviderApiKeyCapability = {
  method: ProviderCredentialWriteMethod;
  targets?: readonly string[];
};

type CapabilityResponse = {
  success?: boolean;
  data?: {
    provider?: string;
    method?: ProviderCredentialWriteMethod;
    targets?: readonly string[];
  };
};

/**
 * Live capability descriptor for a provider's API-key entry surface
 * (`GET /api/providers/:provider/api-key/capability`, T-866/F1). This is the
 * single source of truth `ProviderApiKeySection` renders from: `method:
 * 'none'` hides the section entirely, and a populated `targets` list drives
 * the credential-target selector (e.g. opencode: anthropic/openai/openrouter).
 *
 * Fail-closed: a failed request or an unrecognized payload resolves to
 * `{ method: 'none' }` — a transient backend hiccup hides the entry surface
 * rather than inviting a paste into an endpoint that cannot be reached.
 */
export function useProviderApiKeyCapability(provider: LLMProvider) {
  const [capability, setCapability] = useState<ProviderApiKeyCapability | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCapability(null);

    (async () => {
      try {
        const response = await authenticatedFetch(`/api/providers/${provider}/api-key/capability`);
        if (!response.ok) {
          if (!cancelled) {
            setCapability({ method: 'none' });
          }
          return;
        }
        const payload = (await response.json()) as CapabilityResponse;
        const method = payload.data?.method;
        if (cancelled) {
          return;
        }
        if (method === 'native_file' || method === 'cli_stdin') {
          setCapability({ method, targets: payload.data?.targets });
        } else {
          setCapability({ method: 'none' });
        }
      } catch {
        if (!cancelled) {
          setCapability({ method: 'none' });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [provider]);

  return { capability, loading };
}
