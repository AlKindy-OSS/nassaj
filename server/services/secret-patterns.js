/**
 * Shared secret-detection patterns.
 *
 * Two rule sets live here:
 *  - LEGACY_AUDIT_REDACTION_RULES: the exact, frozen rule set used by the
 *    command-board audit redactor (B-197). It is name-directed and must not
 *    change behaviour; command-board-raw.js consumes it unchanged.
 *  - The share rule set (ADR-196) behind redactForShare(): broader, built for
 *    public session snapshots, where over-redaction is preferred to leakage.
 *
 * Every share rule is linear-time: quantifiers are bounded or single-class
 * greedy runs with nothing ambiguous after them, and no rule uses an
 * unbounded `[\s\S]*?`. A test asserts 4 MiB of adversarial input across all
 * rules completes in under 500 ms.
 */

// ── Legacy audit rules (B-197) — behaviour frozen ──────────────────────────

/** Replacement written by the audit redactor in place of a secret value. */
export const AUDIT_REDACTED = '«redacted»';

/**
 * Frozen audit rules. Each regex's LAST capture group is the secret value;
 * everything before it (the label/flag) is preserved.
 */
export const LEGACY_AUDIT_REDACTION_RULES = Object.freeze([
  // NAME=value assignments and --flag=value / --flag value forms whose name
  // looks like a credential. Value = up to the next space or shell separator.
  Object.freeze({
    re: /((?:^|[\s;&|(])(?:-{0,2})[\w.-]*(?:passwo?rd|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|credential|private[_-]?key|passphrase)[\w.-]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;&|)]+)/gi,
  }),
  // `--token VALUE` (space-separated flag form).
  Object.freeze({
    re: /((?:^|[\s;&|(])-{1,2}[\w.-]*(?:passwo?rd|passwd|secret|token|api[_-]?key|apikey|credential|passphrase)[\w.-]*\s+)("[^"]*"|'[^']*'|[^\s;&|)-][^\s;&|)]*)/gi,
  }),
  // HTTP bearer / basic credentials, with or without a surrounding quote.
  Object.freeze({
    re: /((?:bearer|basic)\s+)([\w./+=-]{8,})/gi,
  }),
  // PEM private key material pasted inline (here-doc / echo).
  Object.freeze({
    re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(?=-----END|$)/g,
  }),
]);

// ── Share rules (ADR-196) ──────────────────────────────────────────────────

/** Redaction categories reported to the share preview. */
export const SHARE_CATEGORIES = Object.freeze(['secret', 'path', 'network']);

/** Credential-like names (keys, env vars, YAML keys, table headers). */
const SECRET_NAME = /(?:passwo?rd|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|credential|passphrase|(?:^|[_.-])key$|^key$)/i;
/** Names that look credential-like but carry counts or metadata, not secrets. */
const NON_SECRET_NAME = /^(?:old)?pwd$|(?:tokens|_count|_type|_url|_path|_file|_name|_id|_length|_limit|_expires(?:_at)?)$/i;

/** True when `name` labels a credential value. */
export function isSecretName(name) {
  return SECRET_NAME.test(name) && !NON_SECRET_NAME.test(name);
}

/**
 * Values that are not secrets even under a credential name: empty strings,
 * `$VAR` / `${VAR}` references, bare UPPER_CASE variable names, `<placeholders>`,
 * masks like `***`, and common literals.
 */
function isPlaceholderValue(value) {
  if (value.length === 0) return true;
  if (/^\$(?:\{[A-Za-z_][A-Za-z0-9_]{0,63}\}|[A-Za-z_][A-Za-z0-9_]{0,63})$/.test(value)) return true;
  if (/^[A-Z][A-Z0-9]{0,31}_[A-Z0-9_]{1,63}$/.test(value)) return true;
  if (/^<[^<>]{0,64}>$/.test(value) || /^[*x.…•-]{1,64}$/i.test(value)) return true;
  return /^(?:null|none|true|false|undefined|redacted|required|optional|string)$/i.test(value);
}

/** Strips one level of matching surrounding quotes. */
function unquote(value) {
  const q = value[0];
  return (q === '"' || q === "'") && value.at(-1) === q && value.length >= 2 ? value.slice(1, -1) : value;
}

/** A `name: value` (colon) value must look like a credential, not prose. */
function looksCredentialLike(value) {
  return value.length >= 6 && /[^A-Za-z\s]/.test(value);
}

/**
 * Shannon entropy in bits per character.
 * @param {string} text
 * @returns {number}
 */
export function shannonEntropy(text) {
  if (!text) return 0;
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Decides whether a long opaque run is a secret.
 * Decision (documented for reviewers): pure hex of 7–40 chars is never
 * flagged — git commit SHAs (short and full) are not secrets. Hex longer than
 * 40 (sha256 digests, hex API keys) IS flagged; over-redacting a checksum is
 * the accepted cost. Mixed runs need ≥32 chars, entropy ≥ 4.2 bits/char and a
 * digit, an upper- and a lower-case letter, which excludes words, paths and
 * UUIDs.
 */
export function isHighEntropySecret(run) {
  if (run.length < 32) return false;
  if (/^[0-9a-f]+$/i.test(run)) return run.length > 40 && shannonEntropy(run) >= 3;
  if (!/\d/.test(run) || !/[a-z]/.test(run) || !/[A-Z]/.test(run)) return false;
  return shannonEntropy(run) >= 4.2;
}

const NAME = '[A-Za-z_][A-Za-z0-9_.-]{0,63}';
/** Horizontal blanks around `=`/`:`: tab, space, NBSP, Unicode spaces, zero-width space and BOM. */
const BLANK = '[ \\t\\u00a0\\u1680\\u2000-\\u200b\\u202f\\u205f\\u3000\\ufeff]';

/** `NAME=` / `NAME:` heads; the value is parsed only after the name qualifies. */
const ASSIGNMENT_HEAD = new RegExp(`(?<![A-Za-z0-9_.$-])(${NAME})${BLANK}{0,8}(=|:)${BLANK}{0,8}`, 'g');
const ASSIGNMENT_VALUE = /\$\{[A-Za-z_][A-Za-z0-9_]{0,63}\}|"[^"\n]{0,4096}"|'[^'\n]{0,4096}'|[^\s"'`;&|,)}\]]{1,4096}/y;

/**
 * Env / .env / YAML / query-string assignments under credential names. Split
 * into head + sticky value so a non-credential name never consumes text (a
 * URL scheme must not swallow `?token=`), while total work stays linear: a
 * value is scanned only behind a qualifying name and is consumed when taken.
 */
function scanAssignments(text) {
  const hits = [];
  const head = new RegExp(ASSIGNMENT_HEAD.source, 'g');
  const valueRe = new RegExp(ASSIGNMENT_VALUE.source, 'y');
  for (let m = head.exec(text); m; m = head.exec(text)) {
    if (!isSecretName(m[1])) continue;
    valueRe.lastIndex = head.lastIndex;
    const v = valueRe.exec(text);
    if (!v) continue;
    const value = unquote(v[0]);
    if (isPlaceholderValue(value) || (m[2] === ':' && !looksCredentialLike(value))) continue;
    hits.push({ start: v.index, end: v.index + v[0].length, cat: 'secret', rule: 'assignment' });
    head.lastIndex = valueRe.lastIndex;
  }
  return hits;
}

const JWT_RUN = /[A-Za-z0-9_-]+/y;
const JWT_MAX_SEGMENT = 8192;
const isWordChar = (ch) => ch !== undefined && /\w/.test(ch);

/** Length of the `[A-Za-z0-9_-]` run at `at` (0 when none). */
function runLength(text, at) {
  JWT_RUN.lastIndex = at;
  return JWT_RUN.exec(text)?.[0].length ?? 0;
}

/**
 * JWTs (`eyJ…` header, payload, signature), equivalent to
 * /\beyJ[A-Za-z0-9_-]{4,8192}(\.[A-Za-z0-9_-]{4,8192}){2}/g but linear: every
 * `eyJ` start inside one run shares the same run end, so each run is decided
 * once from its leftmost eligible start instead of rescanned per start.
 * @param {string} text
 * @returns {Array<{start: number, end: number, cat: 'secret', rule: 'jwt'}>}
 */
export function scanJwts(text) {
  const hits = [];
  // Next `eyJ` at or after the search floor; -1 once none remain. Monotonic, so
  // indexOf never rescans text (a per-run unbounded indexOf would be quadratic).
  const cursor = { at: text.indexOf('eyJ') };
  let at = 0;
  while (at < text.length && cursor.at !== -1) {
    const runLen = runLength(text, at);
    if (runLen === 0) { at += 1; continue; }
    const runEnd = at + runLen;
    const start = jwtStartIn(text, cursor, at, runEnd);
    const end = jwtEndFrom(text, start, runEnd);
    if (end === -1) { at = runEnd; continue; }
    hits.push({ start, end, cat: 'secret', rule: 'jwt' });
    at = end;
  }
  return hits;
}

/** Leftmost `eyJ` at a word boundary whose header segment fits 4..8192 chars, or -1. */
function jwtStartIn(text, cursor, runStart, runEnd) {
  const from = Math.max(runStart, runEnd - JWT_MAX_SEGMENT - 3);
  if (cursor.at !== -1 && cursor.at < from) cursor.at = text.indexOf('eyJ', from);
  while (cursor.at !== -1 && cursor.at <= runEnd - 7) {
    const p = cursor.at;
    cursor.at = text.indexOf('eyJ', p + 1);
    if (!isWordChar(text[p - 1])) return p;
  }
  return -1;
}

/** End of the JWT whose header run ends at `runEnd`, or -1 when payload/signature are missing. */
function jwtEndFrom(text, start, runEnd) {
  if (start === -1 || text[runEnd] !== '.') return -1;
  const payload = runLength(text, runEnd + 1);
  const sigAt = runEnd + 2 + payload;
  if (payload < 4 || payload > JWT_MAX_SEGMENT || text[sigAt - 1] !== '.') return -1;
  const signature = runLength(text, sigAt);
  return signature < 4 ? -1 : sigAt + Math.min(signature, JWT_MAX_SEGMENT);
}

/**
 * Share rules. `group` is the capture index whose span is redacted (0 = whole
 * match). `accept(match)` may veto a structural match. All flags include `g`.
 * A rule with `scan(text)` returns its own hits instead.
 */
const SHARE_RULES = Object.freeze([
  { id: 'json-field', cat: 'secret', group: 2,
    re: /"([A-Za-z0-9_.-]{1,64})"[ \t]{0,8}:[ \t]{0,8}"((?:[^"\\\n]|\\.){1,4096})"/g,
    accept: (m) => isSecretName(m[1]) && !isPlaceholderValue(m[2]) },
  { id: 'json-escaped-field', cat: 'secret', group: 2,
    re: /\\"([A-Za-z0-9_.-]{1,64})\\"[ \t]{0,8}:[ \t]{0,8}\\"([^"\\\n]{1,4096})\\"/g,
    accept: (m) => isSecretName(m[1]) && !isPlaceholderValue(m[2]) },
  { id: 'assignment', cat: 'secret', scan: scanAssignments },
  { id: 'table-cell', cat: 'secret', group: 2,
    // Each cell ends on a non-blank so the trailing `[ \t]*` owns every blank: no ambiguous split,
    // no lazy-quantifier retries (the lazy form was ~17 steps per byte on blank-padded cells).
    re: /\|[ \t]{0,16}`?([A-Za-z_](?:[A-Za-z0-9_. -]{0,62}[A-Za-z0-9_.-])?)[ \t]*(?:`[ \t]*)?\|[ \t]{0,16}`?([^|`\s](?:[^|`\n]{0,4094}[^|`\n \t])?)[ \t]*(?:`[ \t]*)?(?=\|)/g,
    accept: (m) => isSecretName(m[1].trim()) && !isPlaceholderValue(m[2].trim())
      && looksCredentialLike(m[2].trim()) },
  { id: 'jwt', cat: 'secret', scan: scanJwts },
  { id: 'anthropic-openai-key', cat: 'secret', group: 0,
    re: /\bsk-(?:ant-|sp-|proj-)?[A-Za-z0-9_-]{16,512}/g },
  { id: 'github-token', cat: 'secret', group: 0,
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255})/g },
  { id: 'aws-access-key', cat: 'secret', group: 0, re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'bearer', cat: 'secret', group: 2,
    re: /\b(Bearer|Basic)[ \t]{1,8}([A-Za-z0-9._~+/=-]{8,4096})/gi,
    accept: (m) => /[^A-Za-z]/.test(m[2]) || m[2].length >= 20 },
  { id: 'url-userinfo', cat: 'secret', group: 2,
    re: /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/([^\s/@:]{1,256}):([^\s/@]{1,1024})@/g,
    accept: (m) => !isPlaceholderValue(m[2]) },
  { id: 'pem-private-key', cat: 'secret', group: 0,
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[A-Za-z0-9+/=\s:,.]|-(?!----END)){0,16384}(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----)?/g },
  { id: 'tailscale-cgnat', cat: 'network', group: 0,
    re: /(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d]|\.\d)/g },
  // Cookie headers carry session credentials whatever their length; `=` keeps prose like "Cookie: none" visible.
  { id: 'cookie-header', cat: 'secret', group: 1,
    re: /(?<![A-Za-z0-9-])(?:Set-)?Cookie[ \t]{0,8}:[ \t]{0,8}([^\r\n]{1,8192})/gi,
    accept: (m) => m[1].includes('=') },
  { id: 'tailscale-ipv6', cat: 'network', group: 0,
    re: /(?<![0-9A-Fa-f:])fd7a:115c:a1e0(?::[0-9A-Fa-f]{0,4}){1,5}(?![0-9A-Fa-f:])/gi },
  { id: 'tailscale-magicdns', cat: 'network', group: 0,
    re: /(?<![A-Za-z0-9.-])[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.ts\.net(?![A-Za-z0-9-])/gi },
  // Credential stores under a home (`~`, any /home/<user>, /root) and anything under /root.
  // Starting at the home prefix, this span outranks the shorter literal home replacement.
  { id: 'private-path', cat: 'path', group: 0, label: '<private-path>',
    re: /(?<![A-Za-z0-9_.~/-])(?:(?:~|\/home\/[a-z_][a-z0-9_-]{0,31}|\/root)\/\.(?:ssh|aws|gnupg)|\/root)\/[^\s"'`<>|;&)\]]{0,1024}/g },
  { id: 'nassaj-user-home', cat: 'path', group: 0, label: '~user',
    re: /\/home\/[a-z_][a-z0-9_-]{0,31}\/\.nassaj-users\/\d{1,6}(?![A-Za-z0-9_.-])/g },
  { id: 'high-entropy', cat: 'secret', group: 0,
    // `{32}` + `*`, not `{32,}`: the open-ended counted form overflows the
    // regexp backtrack stack on multi-MiB runs.
    re: /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{32}[A-Za-z0-9+/_-]*={0,2}/g,
    accept: (m) => isHighEntropySecret(m[0].replace(/=+$/, '')) },
]);

/** Span of capture group `group` within match `m` (requires the `d` flag). */
function groupSpan(m, group) {
  return group === 0 ? [m.index, m.index + m[0].length] : m.indices[group];
}

/** Collects every rule hit as {start, end, cat, rule, label?}. */
function collectRuleHits(text) {
  const hits = [];
  for (const rule of SHARE_RULES) {
    if (rule.scan) {
      // Loop, not spread: a 4 MiB input can yield more hits than call arguments allow.
      for (const hit of rule.scan(text)) hits.push(hit);
      continue;
    }
    const re = new RegExp(rule.re.source, `${rule.re.flags}d`);
    for (const m of text.matchAll(re)) {
      if (rule.accept && !rule.accept(m)) continue;
      const [start, end] = groupSpan(m, rule.group);
      if (end > start) hits.push({ start, end, cat: rule.cat, rule: rule.id, label: rule.label });
    }
  }
  return hits;
}

/** Literal path occurrences (project root, home) that end on a path boundary. */
function collectPathHits(text, root, label, rule) {
  const hits = [];
  if (typeof root !== 'string' || root.length < 2) return hits;
  const base = root.replace(/\/+$/, '');
  for (let at = text.indexOf(base); at !== -1; at = text.indexOf(base, at + base.length)) {
    const next = text[at + base.length];
    if (next === undefined || !/[A-Za-z0-9_.-]/.test(next)) {
      hits.push({ start: at, end: at + base.length, cat: 'path', rule, label });
    }
  }
  return hits;
}

/** Earliest start wins; at equal start the longer span wins; overlaps merge. */
function mergeHits(hits) {
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const hit of hits) {
    const last = merged.at(-1);
    if (last && hit.start < last.end) {
      if (hit.end > last.end) {
        // A secret overlapping a path replacement makes the whole span secret.
        if (hit.cat === 'secret' && last.cat !== 'secret') Object.assign(last, { cat: 'secret', rule: hit.rule, label: undefined });
        last.end = hit.end;
      }
      continue;
    }
    merged.push({ ...hit });
  }
  return merged;
}

/**
 * Redacts a text for a public share snapshot (ADR-196).
 * @param {string} text
 * @param {{projectRoot?: string, home?: string}} [ctx]
 * @returns {{segments: Array<{t:'text',text:string}|{t:'redacted',cat:string,rule:string,text?:string}>,
 *   counts: {secret:number,path:number,network:number}}}
 *   Path segments carry `text` (the display replacement: `<project>`, `~`,
 *   `~user`); secret and network segments carry no text at all.
 */
export function redactForShare(text, ctx = {}) {
  const counts = { secret: 0, path: 0, network: 0 };
  if (typeof text !== 'string' || text.length === 0) return { segments: [], counts };
  const hits = mergeHits([
    ...collectRuleHits(text),
    ...collectPathHits(text, ctx.projectRoot, '<project>', 'project-root'),
    ...collectPathHits(text, ctx.home, '~', 'home'),
  ]);
  const segments = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) segments.push({ t: 'text', text: text.slice(cursor, hit.start) });
    const seg = { t: 'redacted', cat: hit.cat, rule: hit.rule };
    if (hit.cat === 'path') seg.text = hit.label;
    segments.push(seg);
    counts[hit.cat] += 1;
    cursor = hit.end;
  }
  if (cursor < text.length) segments.push({ t: 'text', text: text.slice(cursor) });
  return { segments, counts };
}

/**
 * Flattens share segments to plain text with visible markers, for previews
 * and tests: `[redacted:secret]`, `[redacted:network]`, or the path label.
 */
export function segmentsToText(segments) {
  return segments.map((s) => (s.t === 'text' ? s.text : s.text ?? `[redacted:${s.cat}]`)).join('');
}
