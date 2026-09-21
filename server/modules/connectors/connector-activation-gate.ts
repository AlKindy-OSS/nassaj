/** Final pure activation decision. No capability, decrypt, network, or provider effect occurs here. */

import { LIFECYCLE_CONNECTOR_OPERATIONS, type ConnectorPolicyOperation } from './connector-policy-v2.js';
import {
  decideConnectorFoundationEligibility, type ConnectorFoundationEligibilityInput,
} from './connector-local-activation.js';

const lifecycle = new Set<ConnectorPolicyOperation>(LIFECYCLE_CONNECTOR_OPERATIONS);
export type ConnectorActivationGateInput = ConnectorFoundationEligibilityInput & Readonly<{
  runtimeReady?: boolean;
}>;

/** Emergency global kill wins; absent runtime readiness defaults to deny. Safety cleanup remains callable. */
export const decideConnectorActivation = (input: ConnectorActivationGateInput): Readonly<{
  eligible: boolean; reason: string;
}> => {
  if (lifecycle.has(input.operation)) return Object.freeze({ eligible: true, reason: 'safety_operation' });
  if (input.globalKilled) return Object.freeze({ eligible: false, reason: 'global_killed' });
  if (input.runtimeReady !== true) return Object.freeze({ eligible: false, reason: 'runtime_unready' });
  return Object.freeze(decideConnectorFoundationEligibility(input));
};
