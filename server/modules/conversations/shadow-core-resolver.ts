import {
  issueTrustedLegacySessionAttestation,
  issueTrustedShadowAuthorization,
  type TrustedLegacySessionAttestation,
  type TrustedShadowAuthorization,
} from './shadow-runtime.js';

export interface ShadowCoreSession {
  sessionId: string;
  provider: string;
  projectPath: string | null;
}

export interface ShadowCoreProject {
  projectId: string;
}

export interface ShadowCoreResolverDependencies {
  coercePrincipalId(value: unknown): number | null;
  getSession(sessionId: string): ShadowCoreSession | null;
  getProjectByPath(projectPath: string): ShadowCoreProject | null;
  isSessionParticipant(sessionId: string, principalId: number): boolean;
  isProjectWritable(projectId: string, principalId: number): boolean;
  onLookupFailure?(phase: 'authorize' | 'attest', error: unknown): void;
}

export interface ShadowCoreAuthorizationInput {
  principalId: string | number | null;
  clientMsgId: string;
  requestedProvider: string;
  requestedLegacySessionId: string | null;
  requestedProjectPath: string | null;
}

export interface ShadowCoreAttestationInput {
  authorization: TrustedShadowAuthorization;
  provider: string;
  legacySessionId: string;
}

export interface UniversalConversationShadowCoreResolver {
  authorize(input: ShadowCoreAuthorizationInput): TrustedShadowAuthorization | null;
  attest(input: ShadowCoreAttestationInput): TrustedLegacySessionAttestation | null;
}

function normalized(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Builds the only bridge allowed to mint shadow authorization and physical-link
 * attestations. Client fields are locators only; all authority comes from the
 * JWT principal plus current server-side session/project state.
 */
export function createUniversalConversationShadowCoreResolver(
  dependencies: ShadowCoreResolverDependencies,
): UniversalConversationShadowCoreResolver {
  function resolveWritableScope(input: {
    principalId: number;
    session: ShadowCoreSession;
  }): ShadowCoreProject | null {
    const projectPath = normalized(input.session.projectPath);
    if (!projectPath) return null;
    const project = dependencies.getProjectByPath(projectPath);
    if (!project) return null;
    return dependencies.isSessionParticipant(input.session.sessionId, input.principalId)
      || dependencies.isProjectWritable(project.projectId, input.principalId)
      ? project
      : null;
  }

  return {
    authorize(input): TrustedShadowAuthorization | null {
      const principalId = dependencies.coercePrincipalId(input.principalId);
      const clientMsgId = normalized(input.clientMsgId);
      const requestedProvider = normalized(input.requestedProvider);
      if (principalId === null || !clientMsgId || !requestedProvider) return null;
      try {
        const requestedLegacySessionId = normalized(input.requestedLegacySessionId);
        if (requestedLegacySessionId) {
          const session = dependencies.getSession(requestedLegacySessionId);
          if (!session || session.provider !== requestedProvider) return null;
          const project = resolveWritableScope({ principalId, session });
          if (!project) return null;
          return issueTrustedShadowAuthorization({
            kind: 'resume',
            projectId: project.projectId,
            principalId,
            clientMsgId,
            canSubmit: true,
            authorizationProvenance: 'jwt+verified-session+participant-or-project-write:v1',
            legacyProvider: session.provider,
            legacySessionId: session.sessionId,
          });
        }

        const requestedProjectPath = normalized(input.requestedProjectPath);
        if (!requestedProjectPath) return null;
        const project = dependencies.getProjectByPath(requestedProjectPath);
        if (!project || !dependencies.isProjectWritable(project.projectId, principalId)) return null;
        return issueTrustedShadowAuthorization({
          kind: 'fresh',
          projectId: project.projectId,
          principalId,
          clientMsgId,
          canSubmit: true,
          authorizationProvenance: 'jwt+verified-project-write:v1',
        });
      } catch (error) {
        dependencies.onLookupFailure?.('authorize', error);
        return null;
      }
    },

    attest(input): TrustedLegacySessionAttestation | null {
      if (
        input.authorization.kind !== 'resume'
        || input.authorization.legacyProvider !== input.provider
        || input.authorization.legacySessionId !== input.legacySessionId
      ) {
        return null;
      }
      const principalId = dependencies.coercePrincipalId(input.authorization.principalId);
      const provider = normalized(input.provider);
      const legacySessionId = normalized(input.legacySessionId);
      if (principalId === null || !provider || !legacySessionId) return null;
      try {
        const session = dependencies.getSession(legacySessionId);
        if (!session || session.provider !== provider) return null;
        const project = resolveWritableScope({ principalId, session });
        if (!project || project.projectId !== input.authorization.projectId) return null;
        return issueTrustedLegacySessionAttestation({
          authorization: input.authorization,
          provider: session.provider,
          legacySessionId: session.sessionId,
          projectId: project.projectId,
        });
      } catch (error) {
        dependencies.onLookupFailure?.('attest', error);
        return null;
      }
    },
  };
}
