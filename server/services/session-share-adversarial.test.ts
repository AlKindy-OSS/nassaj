/**
 * ADR-196 / T-1970 stage 7: adversarial inputs through the FULL share sanitizer
 * (governance strip, tags, fences, images, secrets, paths): evasion-resistant
 * redaction of realistic credential formats, and linear time on 4 MiB hostile inputs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeShareText, type ShareTextCounts } from './session-share-sanitize.js';

const j = (...parts: string[]) => parts.join('');
const MIB = 1024 * 1024;
const CTX = { projectRoot: '/home/operator/Project/example', home: '/home/operator' };
const run = (text: string) => {
  const counts: ShareTextCounts = { system: 0, image: 0, secret: 0, path: 0, network: 0 };
  return JSON.stringify(sanitizeShareText(text, CTX, counts));
};

/** [name, input, raw value that must not survive]; values are assembled so no source line is a credential. */
const MUST_REDACT: Array<[string, string, string]> = [
  ['OpenAI project key', j('key sk-proj-', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3dEf6hIj9k'), 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3dEf6hIj9k'],
  ['Slack bot token', j('xoxb-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'), 'AbCdEfGhIjKlMnOpQrStUvWx'],
  ['Google API key', j('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'), 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
  ['Stripe live key', j('sk_live_', '51Hx9Zb2KqLmNoPqRsTuVwXy'), '51Hx9Zb2KqLmNoPqRsTuVwXy'],
  ['npm token', j('npm_', 'k9Xq2LmZp7TgR4vWb1NcY8sDfH3jA6eOuI5t'), 'k9Xq2LmZp7TgR4vWb1NcY8sDfH3jA6eOuI5t'],
  ['database URL password', j('postgres://app:', 'Sup3rS3cretPw@db.internal:5432/prod'), 'Sup3rS3cretPw'],
  ['Basic auth header', j('Authorization: Basic ', 'dXNlcjpzdXBlcnNlY3JldHBhc3M='), 'dXNlcjpzdXBlcnNlY3JldHBhc3M='],
  ['x-api-key header', j('x-api-key: ', 'live_7f3a9c2e1b8d4f60a5c7'), 'live_7f3a9c2e1b8d4f60a5c7'],
  ['client_secret JSON', j('{"client_secret":"', 'GOCSPX-abcdef123456uvwxyz', '"}'), 'GOCSPX-abcdef123456uvwxyz'],
  ['PEM escaped inside JSON', j('{"private_key":"-----BEGIN ', 'PRIVATE KEY-----\\nMIIEvQIBADANBgkqREALBODYESC\\n-----END PRIVATE KEY-----\\n"}'), 'MIIEvQIBADANBgkqREALBODYESC'],
  ['OpenSSH private key', j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAREALBODY\n-----END OPENSSH PRIVATE KEY-----'), 'b3BlbnNzaC1rZXktdjEAAAAAREALBODY'],
  ['Tailscale auth key', j('tskey-auth-', 'kABCDE1CNTRL-abcdefghijklmnop0123456789'), 'abcdefghijklmnop0123456789'],
  ['lower-case bearer', j('authorization: bearer ', 'abcDEF123456ghiJKL789012mnoPQR'), 'abcDEF123456ghiJKL789012mnoPQR'],
  ['exported variable', j('export DATABASE_PASSWORD="', 'p4ssw0rd-with-dash-9981"'), 'p4ssw0rd-with-dash-9981'],
  ['64 hex secret', j('secret sha ', 'a3f5c8e1b2d4f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d'), 'a3f5c8e1b2d4f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d'],
  ['OAuth token in a URL query', j('https://x.example/cb?access_token=', 'ya29.a0AfH6SMBREALTOKENVALUE'), 'ya29.a0AfH6SMBREALTOKENVALUE'],
  ['Set-Cookie value', j('Set-Cookie: connect.sid=', 's%3AkLm9Xp2Tv7Rb4Nc8Qw1Ze5Yu3Io6Pa0.sig'), 'kLm9Xp2Tv7Rb4Nc8Qw1Ze5Yu3Io6Pa0'],
  ['AWS session token', j('aws_session_token=', 'FwoGZXIvYXdzEBYaDKq8Zk3Lm9Xp2Tv7RbNcQw1Ze5Yu3Io6Pa0'), 'FwoGZXIvYXdzEBYaDKq8Zk3Lm9Xp2Tv7RbNcQw1Ze5Yu3Io6Pa0'],
  ['Tailscale IPv4 inside a URL', 'http://100.101.102.103:8080/x', '100.101.102.103'],
  ['Tailscale range edge', 'peers: 100.64.0.1,100.127.255.254', '100.127.255.254'],
  ['lower-case AWS key id', j('aws key: akia', 'iosfodnn7realkey'), 'akiaiosfodnn7realkey'],
  ['markdown table cell', '| password | Tr0ub4dor&3xyz |', 'Tr0ub4dor&3xyz'],
  ['JWT in a URL fragment', j('https://a.example/#id_token=', 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdEFGH1234ijklMNOP5678'), 'abcdEFGH1234ijklMNOP5678'],
  ['token in link text', j('[token ghp_', 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ](https://x.y)'), 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ'],
  ['token in an HTML comment', j('<!-- ghp_', 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ -->'), 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ'],
  ['env block in a code fence', j('```env\nSTRIPE_SECRET_KEY=sk_live_', 'AbCdEfGhIjKlMnOpQrStUvWx\n```'), 'AbCdEfGhIjKlMnOpQrStUvWx'],
  ['single-quoted secret', j("secret: '", 'Zx9Qw8Er7Ty6Ui5Op4', "'"), 'Zx9Qw8Er7Ty6Ui5Op4'],
  ['padded assignment', j('TOKEN   =   ', 'Zx9Qw8Er7Ty6Ui5Op4As3'), 'Zx9Qw8Er7Ty6Ui5Op4As3'],
  ['camelCase JSON key', j('{"accessToken":"', 'Zx9Qw8Er7Ty6Ui5Op4As3', '"}'), 'Zx9Qw8Er7Ty6Ui5Op4As3'],
  ['nested YAML', j('auth:\n  token: ', 'Zx9Qw8Er7Ty6Ui5Op4As3'), 'Zx9Qw8Er7Ty6Ui5Op4As3'],
  ['Windows user path', 'C:\\Users\\nassaj\\Desktop\\secrets.txt', 'C:\\Users\\nassaj'],
  ['home path', 'cat /home/operator/.config/nassaj/connector-signing/key.pem', '/home/operator/.config'],
  ['project path', 'edit /home/operator/Project/example/src/secret.ts', '/home/operator/Project/example'],
];

test('realistic credential formats and paths are redacted by the full sanitizer', () => {
  for (const [name, input, raw] of MUST_REDACT) {
    assert.ok(!run(input).includes(raw), `${name} survived`);
  }
});

// D2 (fixed): formerly known redactor gaps, now redacted by dedicated linear-time rules.
const FORMER_GAPS: Array<[string, string, string]> = [
  ['short Cookie request header', j('Cookie: sessionid=', 'q8Zk3Lm9Xp2Tv7Rb'), 'q8Zk3Lm9Xp2Tv7Rb'],
  ['lower-case cookie header', j('cookie: a=1; sid=', 'x9Y8z7'), 'x9Y8z7'],
  ['non-breaking space after =', j('API_KEY=\u00a0', 'AbCdEfGh1234IjKlMnOp5678'), 'AbCdEfGh1234IjKlMnOp5678'],
  ['ideographic space after :', j('password:\u3000', 'Zx9Qw8Er7Ty6'), 'Zx9Qw8Er7Ty6'],
  ['Tailscale IPv6 address', 'node fd7a:115c:a1e0:ab12:4843:cd96:6265:1234', 'fd7a:115c:a1e0:ab12:4843:cd96:6265:1234'],
  ['compressed Tailscale IPv6', 'peer fd7a:115c:a1e0::53', 'fd7a:115c:a1e0::53'],
  ['Tailscale MagicDNS name', 'ssh node1.example.ts.net', 'node1.example.ts.net'],
  ['home-relative secret paths', 'open ~/.ssh/id_ed25519 and ~/.aws/credentials', '.aws/credentials'],
  ['home-relative SSH key', 'open ~/.ssh/id_ed25519', 'id_ed25519'],
  ['expanded home SSH key', 'cat /home/operator/.ssh/id_rsa', 'id_rsa'],
  ['root home path', 'see /root/.bash_history', '/root/.bash_history'],
];
for (const [name, input, raw] of FORMER_GAPS) {
  test(`D2: ${name} is redacted`, () => {
    assert.ok(!run(input).includes(raw), run(input));
  });
}

test('D2: cookie and path rules do not over-redact prose', () => {
  assert.ok(run('Cookie: none are set here').includes('none are set here'), 'a Cookie line without a pair stays');
  assert.ok(run('the /root directory').includes('/root directory'), 'bare /root in prose stays');
  assert.ok(run('the docs at tailscale.com/kb').includes('tailscale.com/kb'), 'non-tailnet hosts stay');
});

// D2 decision: accepted and NOT redacted. Private addresses, loopback URLs and /etc paths are
// identical on every machine and routine in technical discussion; redacting them would blank
// ordinary prose while protecting nothing reachable from outside the host's own network.
const ACCEPTED_VISIBLE: Array<[string, string, string]> = [
  ['RFC1918 address', 'host 192.168.1.50', '192.168.1.50'],
  ['loopback service URL', 'curl http://localhost:3004/api/auth/user', 'localhost:3004'],
  ['system config path', 'see /etc/nassaj/prod.env', '/etc/nassaj/prod.env'],
];
for (const [name, input, visible] of ACCEPTED_VISIBLE) {
  test(`D2 accepted: ${name} stays visible`, () => {
    assert.ok(run(input).includes(visible));
  });
}

/** Builders for hostile shapes; every one is exactly 4 MiB. */
const fill = (unit: string) => unit.repeat(Math.ceil((4 * MIB) / unit.length)).slice(0, 4 * MIB);
const HOSTILE: Array<[string, string]> = [
  ['open angle brackets', fill('<')],
  ['tag openers without closers', fill('<a ')],
  ['unclosed stripped tags', fill('<system-reminder>')],
  ['tag name that never ends', `<${'a'.repeat(4 * MIB - 1)}`],
  ['stripped opener and mismatched closers', fill('<instructions></permissions>')],
  ['markdown image brackets', fill('![](')],
  ['nested image brackets', `${'['.repeat(MIB)}${'](x'.repeat(MIB)}`],
  ['unclosed fences', fill('```\n')],
  ['alternating fence kinds', fill('```image\n~~~\n')],
  ['AGENTS heading without instructions', fill('# AGENTS.md instructions for x\n')],
  ['key prefixes', fill('sk-ant-api03-')],
  ['AKIA prefixes', fill('AKIA')],
  ['assignment operators', fill('password=')],
  ['colon and quote runs', fill(': "')],
  ['unclosed PEM headers', fill('-----BEGIN ' + 'PRIVATE KEY-----')],
  ['JWT dot runs', fill('eyJ.')],
  ['almost Tailscale addresses', fill('100.64.')],
  ['table pipes', fill('| token | ')],
  ['path prefixes', fill('/home/operator/')],
  ['slash runs', '/'.repeat(4 * MIB)],
  ['one huge base64-looking run', 'A'.repeat(4 * MIB)],
  ['high entropy words', fill('aB3dE6gH9jK2mN5pQ8sT1vW4yZ7 ')],
  ['dot and dash runs', fill('a.b-c_')],
  ['whitespace only', fill(' \t\n')],
  ['unicode noise', fill('ا\u200b\u202e')],
  ['parenthesis runs', '('.repeat(4 * MIB)],
  ['data URI openers', fill('data:image/png;base64,')],
  ['image store segments', fill('/chat-images/')],
  ['cookie headers without pairs', fill('Cookie: ')],
  ['Tailscale IPv6 prefixes', fill('fd7a:115c:a1e0:')],
  ['MagicDNS label runs', fill('a.ts.')],
  ['private path prefixes', fill('~/.ssh/')],
  ['root path prefixes', fill('/root')],
  ['unicode blanks after assignments', fill('token=\u00a0\u3000')],
];

test('4 MiB of every hostile shape clears the full sanitizer in under one second', () => {
  const slow: string[] = [];
  for (const [name, input] of HOSTILE) {
    assert.equal(input.length, 4 * MIB, name);
    const started = performance.now();
    run(input);
    const elapsed = performance.now() - started;
    if (elapsed > 1000) slow.push(`${name}: ${Math.round(elapsed)} ms`);
  }
  assert.deepEqual(slow, []);
});
