/**
 * T-2095 secret filter for turn checkpoints. Fail-closed: a path or a body is
 * captured only when every gate here passes; anything else is withheld with a
 * reason and its bytes never reach the checkpoint store. No hash of a withheld
 * body is ever computed or recorded.
 */
import path from 'node:path';

// eslint-disable-next-line boundaries/no-unknown -- the shared secret detectors are the one source of credential patterns.
import { isHighEntropySecret, isSecretName, shannonEntropy } from '../../services/secret-patterns.js';

/** Approved capture caps (design T-2095). */
export const CHECKPOINT_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  checkpointBytes: 20 * 1024 * 1024,
  checkpointPaths: 5000,
});

/** Exact secret file names and extensions: withheld whatever their content. */
const DENIED_BASENAMES = [
  /^\.env$/, /^\.env\..+$/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /\.jks$/, /\.keystore$/, /\.kdbx$/,
  /^id_rsa/, /^id_ed25519/, /^id_ecdsa/, /^\.npmrc$/, /^\.pypirc$/, /^\.netrc$/, /^\.git-credentials$/,
  /^service-account.*\.json$/, /^\.credentials\.json$/, /\.tfstate/,
];
const DENIED_DIRECTORIES = new Set(['.ssh', '.gnupg', '.aws']);
/**
 * Data and config formats whose credential-like file name (client_secret.json,
 * secrets.yaml, api_key.txt) marks a credential store. Source code and docs
 * named like a credential (token-utils.ts, secret-patterns.js) are ordinary.
 */
const DATA_EXTENSIONS = new Set([
  '', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.txt', '.properties', '.xml', '.env',
  '.csv', '.db', '.sqlite', '.dat', '.bak',
]);
const CREDENTIAL_FILE_NAME = /credential|secret|passwo?rd|passwd|token(?!s)|api[_-]?key|apikey|access[_-]?key|private[_-]?key/;
const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env']);
const BINARY_PROBE_BYTES = 8 * 1024;
const MIN_STRING_RUN = 6;
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
/** Known provider credential shapes (high precision, linear-time). */
const PROVIDER_KEYS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,255}/g,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,255}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,255}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bglpat-[A-Za-z0-9_-]{20,255}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,255}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const URL_USERINFO = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`<>]{1,64}:([^\s@/'"`<>]{1,128})@[^\s'"`<>]/gi;
const PLACEHOLDER_SECRET = /^(?:pass(?:word)?|pwd|secret|token|key|api[_-]?key|user(?:name)?|example|changeme|test|x+|\*+|\.+|-+)$/i;
/** key, then a double-quoted, single-quoted or bare value; the key may follow `-`, `{`, `,`, `;` or a blank. */
const CONFIG_ASSIGNMENT = /(?:^|[{,;\s])(?:-[ \t]+)?["']?([A-Za-z_][A-Za-z0-9_.-]{0,63})["']?[ \t]*[:=][ \t]*(?:"([^"\n]{0,256})"|'([^'\n]{0,256})'|([^\s"',;#{}[\]]{1,256}))/gm;
/** Names that describe or reference a credential rather than hold one. */
const CONFIG_NON_SECRET_NAME = /(?:_env|tokenizer|secretname|secret_name|policy|_mode|_revision|_version|placeholder|endpoint|label|hint|description|title|_at)$/i;
const MIN_CONFIG_SECRET = 6;
const MIN_DISTINCT_CHARS = 5;
const SRI_HASH = /\bsha(?:256|384|512)-[A-Za-z0-9+/]{20,}={0,2}/g;
/** Public material and opaque identifiers that look random but are not credentials. */
const PUBLIC_BLOCK = /-----BEGIN (?:[A-Z ]*PUBLIC KEY(?: BLOCK)?|CERTIFICATE)-----[\s\S]{0,20000}?-----END [A-Z ]{1,40}-----/g;
const SSH_PUBLIC_KEY = /\bssh-(?:ed25519|rsa|dss|ecdsa-[a-z0-9-]{1,30}) [A-Za-z0-9+/]{16,}={0,2}/g;
const NON_SECRET_ID = /^(?:srv)?toolu_|^msg_|^req_|^prt_|^ses_|^call_|^chatcmpl-|^REF_/;
const OPAQUE_RUN = /[A-Za-z0-9+/=_-]{24,}/g;
const MAX_TOKEN_LENGTH = 256;
const MIN_CLASS_SWITCH_RATIO = 0.45;
const MIN_URL_PASSWORD = 6;

/**
 * Classifies a repository-relative path before any byte is read.
 * @param {string} relativePath forward-slash path relative to the work tree
 * @returns {'denied_path'|null}
 */
export function classifyCheckpointPath(relativePath) {
  const segments = String(relativePath).toLowerCase().split('/');
  const basename = segments.at(-1) ?? '';
  if (segments.slice(0, -1).some((segment) => DENIED_DIRECTORIES.has(segment))) return 'denied_path';
  if (segments.length >= 2 && segments.at(-2) === '.docker' && basename === 'config.json') return 'denied_path';
  if (DENIED_BASENAMES.some((pattern) => pattern.test(basename))) return 'denied_path';
  const extension = path.extname(basename);
  const stem = basename.slice(0, basename.length - extension.length) || basename;
  return DATA_EXTENSIONS.has(extension) && CREDENTIAL_FILE_NAME.test(stem) ? 'denied_path' : null;
}

/**
 * Classifies an lstat result: only regular single-link files within the cap
 * and symlinks (stored as link text, never followed) may be captured.
 * @param {import('node:fs').Stats} stat
 * @param {number} [fileBytes] per-file cap
 * @returns {'hardlink'|'too_large'|'special'|null}
 */
export function classifyCheckpointStat(stat, fileBytes = CHECKPOINT_LIMITS.fileBytes) {
  if (stat.isSymbolicLink()) return null;
  if (!stat.isFile()) return 'special';
  if (stat.nlink > 1) return 'hardlink';
  if (stat.size > fileBytes) return 'too_large';
  return null;
}

function isSecretContainer(body) {
  if (body.subarray(0, 16).toString('latin1') === 'SQLite format 3\0') return true;
  if (body[0] === 0x50 && body[1] === 0x4b && (body[2] === 0x03 || body[2] === 0x05 || body[2] === 0x07)) return true;
  // DER SEQUENCE with a long or indefinite length: PKCS#12, PKCS#8, X.509 containers.
  return body[0] === 0x30 && (body[1] === 0x80 || body[1] === 0x82 || body[1] === 0x83 || body[1] === 0x84);
}

function extractStrings(body) {
  const runs = [];
  let start = -1;
  for (let index = 0; index <= body.length; index += 1) {
    const byte = body[index];
    const printable = index < body.length && byte >= 0x20 && byte < 0x7f;
    if (printable && start < 0) start = index;
    if (!printable && start >= 0) {
      if (index - start >= MIN_STRING_RUN) runs.push(body.toString('latin1', start, index));
      start = -1;
    }
  }
  return runs.join('\n');
}

/** Placeholder keys (ghp_xxxx…, sk-claude-…-SECRET) lack the variety and digits of a real key. */
function looksLikeRealKey(value) {
  return new Set(value).size >= 8 && /[0-9]/.test(value);
}

function hasProviderKey(text) {
  for (const pattern of PROVIDER_KEYS) {
    for (const match of text.matchAll(pattern)) if (looksLikeRealKey(match[0])) return true;
  }
  return false;
}

function hasRealUrlPassword(text) {
  for (const match of text.matchAll(URL_USERINFO)) {
    const password = match[1];
    if (password.length < MIN_URL_PASSWORD || /[$%{}<>[\]]/.test(password) || PLACEHOLDER_SECRET.test(password)) continue;
    return true;
  }
  return false;
}

/** Share of adjacent characters that switch class (upper/lower/digit/other): high for random keys, low for words. */
function classSwitchRatio(run) {
  const classOf = (ch) => (/[A-Z]/.test(ch) ? 1 : /[a-z]/.test(ch) ? 2 : /[0-9]/.test(ch) ? 3 : 4);
  let switches = 0;
  for (let index = 1; index < run.length; index += 1) if (classOf(run[index]) !== classOf(run[index - 1])) switches += 1;
  return switches / (run.length - 1);
}

/** A credential name, minus names that only describe or point at a credential (tokenizer, api_key_env …). */
function isConfigSecretName(name) {
  return isSecretName(name) && !CONFIG_NON_SECRET_NAME.test(name);
}

/** A literal value, not a placeholder, a variable reference, an env-var name or a bare number. */
function isLiteralSecretValue(value) {
  if (value.length < MIN_CONFIG_SECRET || PLACEHOLDER_SECRET.test(value) || /^[$<{%]/.test(value)) return false;
  if (/^[0-9]+$/.test(value) || /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(value)) return false;
  // Version ranges (^9.0.3), a capitalised UI word (Passwort) and non-ASCII prose are labels, not secrets.
  if (/^[\^~<>=]*\d+(?:\.\d+)+/.test(value) || /^[A-Z][a-z]+$/.test(value) || /[^\x20-\x7e]/.test(value)) return false;
  // Paths, dotted/underscored lowercase identifiers, labels ending in ':' and xxxx-style fillers.
  if (/^[./~]/.test(value) || /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)+$/.test(value) || value.endsWith(':')) return false;
  if (new Set(value).size < MIN_DISTINCT_CHARS) return false;
  return !/^(?:true|false|null|none|required|optional|redacted)$/i.test(value);
}

/**
 * A credential-named key with a literal value in a config file (YAML, JSON,
 * INI, compose lists, YAML flow maps, minified JSON): the key may follow `-`,
 * `{`, `,`, `;` or a blank anywhere on the line. A quoted value is also scanned
 * once inside (connection strings such as `Server=db;Password=…;`); a quoted
 * value with blanks is prose and never a secret itself.
 */
function hasConfigCredential(text, nested = false) {
  for (const match of text.matchAll(CONFIG_ASSIGNMENT)) {
    const quoted = match[2] ?? match[3];
    const value = quoted ?? match[4];
    if (isConfigSecretName(match[1]) && !(quoted && /\s/.test(quoted)) && isLiteralSecretValue(value)) return true;
    if (quoted && !nested && hasConfigCredential(quoted, true)) return true;
  }
  return false;
}

/**
 * A long opaque credential-sized token. Pure hex (commit ids, sha256/sha512
 * digests) is never a credential here, and runs longer than 256 characters are
 * data blobs (certificates, images, signatures), not keys a human pastes.
 * Identifiers, paths and slugs (ownerApprovalKeySha256FromPublicKeyPem,
 * ADR-194-provider-neutral-…) rarely switch character class; random keys do.
 */
function isRandomLooking(token) {
  return !/^[0-9a-f]+$/i.test(token) && classSwitchRatio(token) >= MIN_CLASS_SWITCH_RATIO;
}

/** A base64-alphabet run (no `-`/`_`) judged whole: 32..256 chars of random-looking key material. */
function isOpaqueKey(run) {
  const body = run.replace(/=+$/, '');
  return body.length >= 32 && body.length <= MAX_TOKEN_LENGTH && isRandomLooking(body) && isHighEntropySecret(body);
}

/** One segment of a separated run (slug, path, NAME=value) that is itself a random key. */
function isKeySegment(segment) {
  if (segment.length < 24 || segment.length > MAX_TOKEN_LENGTH || !isRandomLooking(segment)) return false;
  return /[0-9]/.test(segment) && /[a-z]/.test(segment) && /[A-Z]/.test(segment) && shannonEntropy(segment) >= 4;
}

function isCredentialToken(run) {
  if (NON_SECRET_ID.test(run)) return false;
  if (!/[-_]/.test(run)) return isOpaqueKey(run);
  return run.split(/[-_./=]/).some(isKeySegment);
}

function hasHighEntropyToken(text) {
  const scanned = text.replace(SRI_HASH, ' ').replace(PUBLIC_BLOCK, ' ').replace(SSH_PUBLIC_KEY, ' ');
  for (const match of scanned.matchAll(OPAQUE_RUN)) {
    if (isCredentialToken(match[0].replace(/^[=_-]+|[=_-]+$/g, ''))) return true;
  }
  return false;
}

/**
 * The first detector that fires on `text`, or null.
 * @param {string} text
 * @param {boolean} isConfig whether the file is a config format (YAML, JSON, INI …)
 * @returns {'private_key'|'provider_key'|'url_password'|'config_credential'|'high_entropy'|null}
 */
export function detectCheckpointSecret(text, isConfig) {
  if (PRIVATE_KEY_HEADER.test(text)) return 'private_key';
  if (hasProviderKey(text)) return 'provider_key';
  if (hasRealUrlPassword(text)) return 'url_password';
  if (isConfig && hasConfigCredential(text)) return 'config_credential';
  return hasHighEntropyToken(text) ? 'high_entropy' : null;
}

function textHasSecret(text, isConfig) {
  return detectCheckpointSecret(text, isConfig) !== null;
}

/**
 * Inspects the exact bytes that would be stored, with high-precision detectors
 * only: private-key headers, known provider key shapes, URLs carrying a real
 * password, credential-named literals in config files, and high-entropy tokens.
 * Binary bodies (a NUL in the first 8 KiB) are denied outright when they are a
 * known secret container (SQLite, zip/jar, DER/PKCS#12) and otherwise pass
 * only if their printable strings are clean.
 * @param {Buffer} body
 * @param {string} [relativePath] used only to recognise config formats
 * @returns {'secret_content'|'secret_container'|null}
 */
export function inspectCheckpointContent(body, relativePath = '') {
  if (isSecretContainer(body)) return 'secret_container';
  const binary = body.subarray(0, BINARY_PROBE_BYTES).includes(0);
  const text = binary ? extractStrings(body) : body.toString('utf8');
  const isConfig = CONFIG_EXTENSIONS.has(path.extname(String(relativePath)).toLowerCase());
  return textHasSecret(text, isConfig) ? 'secret_content' : null;
}
