/**
 * VAPID "subject" (RFC 8292 §2.1): a mailto: or https: contact URI that push
 * services use to reach the operator. Pure module (no DB, no web-push) so the
 * policy is testable on its own.
 */

/** Kept as the fallback so an unconfigured deployment behaves exactly as before. */
export const DEFAULT_VAPID_SUBJECT = 'mailto:noreply@claudecodeui.local';

/** Host part of a mailto:/https: subject, lower-cased, or null when malformed. */
function subjectHost(subject) {
  if (subject.startsWith('mailto:')) {
    const address = subject.slice('mailto:'.length);
    const at = address.lastIndexOf('@');
    if (at <= 0 || at === address.length - 1 || /\s/.test(address)) return null;
    return address.slice(at + 1).toLowerCase();
  }
  if (subject.startsWith('https:')) {
    try {
      const url = new URL(subject);
      return url.protocol === 'https:' && url.hostname ? url.hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** True when `subject` is a well-formed mailto: address or https: URL. */
export function isValidVapidSubject(subject) {
  return typeof subject === 'string' && subjectHost(subject.trim()) !== null;
}

/** True when push services cannot reach the subject's host (.local or localhost). */
export function isUnreachableSubjectHost(subject) {
  const host = subjectHost(subject);
  return host === 'localhost' || Boolean(host?.endsWith('.local')) || Boolean(host?.endsWith('.localhost'));
}

/**
 * Resolve the subject from `env.VAPID_SUBJECT`, falling back to the default.
 * Returns `{ subject, warnings }`; the caller decides how to log the warnings.
 * Warnings never contain the configured value, only its classification.
 */
export function resolveVapidSubject(env = process.env) {
  const warnings = [];
  const configured = typeof env.VAPID_SUBJECT === 'string' ? env.VAPID_SUBJECT.trim() : '';
  let subject = DEFAULT_VAPID_SUBJECT;
  if (configured && isValidVapidSubject(configured)) {
    subject = configured;
  } else if (configured) {
    warnings.push('VAPID_SUBJECT is not a valid mailto: or https: URI; using the built-in default');
  }
  if (isUnreachableSubjectHost(subject)) {
    warnings.push('VAPID subject host is .local/localhost; push services cannot contact the operator. '
      + 'Set VAPID_SUBJECT to a real mailto: or https: contact');
  }
  return { subject, warnings };
}
