import { authenticatedFetch } from '../../utils/api';
import type { SteerConsent, SteerPolicy } from '../../../shared/session-steer.contract';

const json = { 'Content-Type': 'application/json' };

async function bodyOrNull(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function getSteerPolicy(): Promise<SteerPolicy | null> {
  const response = await authenticatedFetch('/api/session-steer/policy');
  return response.ok ? bodyOrNull(response) : null;
}

export async function putSteerPolicy(policy: SteerPolicy): Promise<SteerPolicy | null> {
  const response = await authenticatedFetch('/api/session-steer/policy', {
    method: 'PUT',
    headers: json,
    body: JSON.stringify(policy),
  });
  return response.ok ? bodyOrNull(response) : null;
}

export async function getSteerConsent(): Promise<SteerConsent | null> {
  const response = await authenticatedFetch('/api/session-steer/consent');
  return response.ok ? bodyOrNull(response) : null;
}

export async function putSteerConsent(consent: SteerConsent): Promise<SteerConsent | null> {
  const response = await authenticatedFetch('/api/session-steer/consent', {
    method: 'PUT',
    headers: json,
    body: JSON.stringify(consent),
  });
  return response.ok ? bodyOrNull(response) : null;
}
