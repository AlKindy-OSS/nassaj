/** harness-files module barrel (ADR-203, T-2003): shared vs private skills. */
export { default as harnessFilesRoutes } from './harness-files.routes.js';
export {
  HARNESS_SUPPORT,
  describeHarnessFiles,
  setMyHarnessFilesMode,
  setWorkspaceAllowMemberPrivate,
} from './harness-files.service.js';
export type {
  HarnessFilesActor,
  HarnessFilesModeResult,
  HarnessFilesView,
  HarnessSupport,
} from './harness-files.service.js';
