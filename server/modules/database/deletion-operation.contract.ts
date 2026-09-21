import type Database from 'better-sqlite3';

export const DELETION_MAX_SESSIONS = 4096;
export const DELETION_MAX_SOURCES = 16384;
export type DeleteCommand = Readonly<{ operationId: string; actorId: number; targetKind: 'session' | 'project'; targetId: string; scope: 'nassaj_only' | 'nassaj_and_disk' }>;
export type DeleteSession = Readonly<{ sessionId: string; provider: string; sourceIdentity: string; projectId: string; generation: string }>;
export type DeleteTarget = Readonly<{ projectId: string; generation: string; projectPath: string; fingerprint: string; keyVersion: number; sessions: readonly DeleteSession[] }>;
export type SourceMember = Readonly<{ sessionId: string; provider: string; sourceIdentity: string; targetIdentity: string; targetKind: 'session_artifact' | 'provider_session' }>;
export type SourceManifest = Readonly<{ storeIdentity: string; writerFence: string; inventoryDigest: string; boundaryProof: string; members: readonly SourceMember[] }>;
export type DirectoryTarget = Readonly<{ storeIdentity: string; targetIdentity: string; targetKind: 'project_directory' | 'project_logo' }>;
export type VerifiedInventory = Readonly<{ projectId: string; generation: string; complete: true; sources: readonly SourceManifest[]; directoryTargets: readonly DirectoryTarget[] }>;
export type CleanupCounts = Readonly<{ pending: number; leased: number; retry: number; succeeded: number; blocked: number; retained: number }>;
export type DeleteResult = Readonly<{ operationId: string; status: 202; databaseDeletion: 'committed'; artifactCleanup: 'pending' | 'not_applicable' | 'blocked' | 'retained' | 'succeeded'; cleanupCounts: CleanupCounts; retainedClasses: readonly string[] }>;

/** Same non-disclosing public message for every internal reason; middleware may map status/code. */
export class DeletionOperationError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 503) { super('Deletion could not be completed.'); this.code=code; this.statusCode=statusCode; }
}

/** Required trusted composition seams. None is populated from an HTTP request or a caller-supplied evidence object. */
export type DeletionOperationBoundaries = Readonly<{
  retireUniversalLinks: (db: Database.Database, target: DeleteTarget, command: DeleteCommand) => void;
  captureAuthorizedAudience: (db: Database.Database, target: DeleteTarget) => ReadonlyMap<number, readonly string[]>;
  publishToUser: (userId: number, sessionIds: readonly string[], operationId: string) => void;
  log: (event: { code: string; operationId: string }) => void;
}>;
