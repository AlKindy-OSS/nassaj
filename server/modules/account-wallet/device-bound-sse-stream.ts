import { connectionRevocationRegistry, devicePrincipalFromUser } from './connection-revocation-registry.js';

export type DeviceSseResponse = {
  writableEnded: boolean;
  headersSent: boolean;
  write: (chunk: string) => void;
  end: () => void;
  once: (event: string, callback: () => void) => void;
};

/** Shared SSE fence that checks the device generation before every emission. */
export class DeviceBoundSseStream {
  private readonly principal;
  private clientGone = false;
  private revoked = false;
  private unregister: (() => void) | null = null;

  constructor(
    private readonly response: DeviceSseResponse,
    authenticatedUser: unknown,
    private readonly onInvalidated: () => void = () => undefined,
  ) {
    this.principal = devicePrincipalFromUser(authenticatedUser);
    if (this.principal) {
      this.unregister = connectionRevocationRegistry.register(
        { close: () => this.invalidate() },
        this.principal,
      );
      response.once('close', () => this.markClientGone());
    }
  }

  /** Emits one JSON SSE event only while the database identity is current. */
  send(data: unknown, event?: string): boolean {
    if (this.principal && !connectionRevocationRegistry.isCurrent(this.principal)) {
      this.invalidate();
      return false;
    }
    if (this.clientGone || this.revoked || this.response.writableEnded) return false;
    const eventLine = event ? `event: ${event}\n` : '';
    this.response.write(`${eventLine}data: ${JSON.stringify(data)}\n\n`);
    return true;
  }

  /** Cancels backing work, emits the revocation event, and closes the stream. */
  invalidate(): void {
    if (this.clientGone || this.revoked || this.response.writableEnded) return;
    this.revoked = true;
    this.unregister?.();
    this.onInvalidated();
    if (this.response.headersSent) {
      this.response.write('event: identity_revoked\ndata: {}\n\n');
    }
    this.response.end();
  }

  /** Closes on a generic immutable-access fence with one sanitized control event. */
  invalidateAccess(code: 'identity_changed' | 'project_access_changed'): void {
    if (this.clientGone || this.revoked || this.response.writableEnded) return;
    this.revoked = true;
    this.unregister?.();
    this.onInvalidated();
    if (this.response.headersSent) {
      this.response.write(`event: access_fence\ndata: ${JSON.stringify({ type: 'access_fence', code })}\n\n`);
    }
    this.response.end();
  }

  /** Removes the registry entry after an HTTP disconnect. */
  markClientGone(): void {
    this.clientGone = true;
    this.unregister?.();
  }

  /** Ends a healthy stream and removes its operational registry entry. */
  end(): void {
    this.unregister?.();
    if (!this.clientGone && !this.revoked && !this.response.writableEnded) {
      this.response.end();
    }
  }

  /** Whether work should continue producing output for this stream. */
  isOpen(): boolean {
    return !this.clientGone && !this.revoked && !this.response.writableEnded;
  }
}
