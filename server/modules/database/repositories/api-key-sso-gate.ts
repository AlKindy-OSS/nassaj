/**
 * ADR-194 D6 / S8 Q1 gate for API keys: true while SSO is enforced and login
 * is unavailable (unavailable, paused or a state read failure). A leaf module
 * with no imports, so the SSO state model can register the gate at load even
 * inside an import cycle that reaches the API key repository first. The
 * default (no SSO state model loaded) refuses nothing extra; a throwing gate
 * refuses (fail closed).
 */
type ApiKeySsoUnavailableGate = () => boolean;

const DEFAULT_UNAVAILABLE_GATE: ApiKeySsoUnavailableGate = () => false;
const state: { gate: ApiKeySsoUnavailableGate } = { gate: DEFAULT_UNAVAILABLE_GATE };

/** Registers the SSO-unavailable gate (called once by the SSO state model). */
export function setApiKeySsoUnavailableGate(gate: ApiKeySsoUnavailableGate): void {
  state.gate = typeof gate === 'function' ? gate : DEFAULT_UNAVAILABLE_GATE;
}

/** The registered gate, so a test that swaps it can restore it exactly. */
export function currentApiKeySsoUnavailableGate(): ApiKeySsoUnavailableGate {
  return state.gate;
}

/** Whether a gate other than the default is registered (boot wiring check). */
export function apiKeySsoUnavailableGateRegistered(): boolean {
  return state.gate !== DEFAULT_UNAVAILABLE_GATE;
}

/** The gate's verdict; a throwing gate refuses (fail closed). */
export function apiKeySsoUnavailable(): boolean {
  try {
    return state.gate() === true;
  } catch {
    return true;
  }
}
