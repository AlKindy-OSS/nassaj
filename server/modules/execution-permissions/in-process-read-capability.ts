/**
 * T-1910: the single capability that lets a lease record the server's own process as its
 * effect child. It is issued exactly once, at load of the in-process read helper; any later
 * issue throws, so a second holder cannot appear silently. The gateway only verifies it.
 */
const IN_PROCESS_READ_CAPABILITY: unique symbol = Symbol('nassaj.permission.in-process-read');

let issued = false;

/** Hands the capability to its one reviewed holder (in-process-read.ts); never twice. */
export const issueInProcessReadCapability = (): typeof IN_PROCESS_READ_CAPABILITY => {
  if (issued) throw new Error('IN_PROCESS_READ_CAPABILITY_ALREADY_ISSUED');
  issued = true;
  return IN_PROCESS_READ_CAPABILITY;
};

/** True only for the issued capability itself; no structural or string look-alike passes. */
export const isInProcessReadCapability = (value: unknown): boolean =>
  value === IN_PROCESS_READ_CAPABILITY;
