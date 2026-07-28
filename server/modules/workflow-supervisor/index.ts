/**
 * Public barrel — the workflow-supervisor module's cross-module API (ADR-053,
 * M-BG-2-CODE). The external consumer (the providers workflow-status service)
 * imports from HERE per the boundaries/dependencies contract; files INSIDE the
 * module import their siblings directly.
 *
 * The whole feature is gated behind WORKFLOW_SUPERVISOR (see ./config.ts):
 * buildScopeLivenessResolver returns null when the flag is off, so importing this
 * barrel is side-effect-free by default.
 */
export { buildScopeLivenessResolver } from '@/modules/workflow-supervisor/scope-status.js';
export type { ScopeLivenessResolver } from '@/modules/workflow-supervisor/scope-status.js';
