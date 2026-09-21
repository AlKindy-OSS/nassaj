/** Only non-secret member document paths may survive the login round trip. */
export function safeShareReturn(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^\/share\/members\/[a-f0-9]{32}$/.test(value) ? value : null;
}

/** Tab-local URL state avoids one tab overwriting another tab's login destination. */
export function shareLoginPath(value: string): string {
  const destination = safeShareReturn(value);
  return destination ? `/login?returnTo=${encodeURIComponent(destination)}` : '/login';
}
