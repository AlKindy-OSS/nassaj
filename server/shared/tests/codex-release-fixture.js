/**
 * Test-only builder for a machine Codex standalone release (layoutVersion 1),
 * mirroring ~/.local/bin/codex -> <pkg>/current/bin/codex -> releases/<v>-<triple>.
 * On x86_64 Linux the entrypoint is a tiny real ELF that prints
 * `codex-cli <version>`, so the default version probe runs for real.
 */
import fs from 'node:fs';
import path from 'node:path';

const TRIPLES = { 'linux:x64': 'x86_64-unknown-linux-musl', 'linux:arm64': 'aarch64-unknown-linux-musl' };

/** Hand-assembled static ELF64 (x86-64): write(1, message); exit(0). */
export function versionPrinterElf(message) {
  const text = Buffer.from(message);
  const code = Buffer.concat([
    Buffer.from([0xb8, 1, 0, 0, 0, 0xbf, 1, 0, 0, 0]),
    Buffer.from([0x48, 0x8d, 0x35, 16, 0, 0, 0]),
    Buffer.from([0xba]), u32(text.length),
    Buffer.from([0x0f, 0x05, 0xb8, 60, 0, 0, 0, 0x31, 0xff, 0x0f, 0x05]),
  ]);
  const base = 0x400000n;
  const total = BigInt(64 + 56 + code.length + text.length);
  const header = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(8),
    u16(2), u16(0x3e), u32(1), u64(base + 120n), u64(64n), u64(0n), u32(0),
    u16(64), u16(56), u16(1), u16(0), u16(0), u16(0),
  ]);
  const program = Buffer.concat([
    u32(1), u32(5), u64(0n), u64(base), u64(base), u64(total), u64(total), u64(0x1000n),
  ]);
  return Buffer.concat([header, program, code, text]);
}

function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }
function u64(value) { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b; }

/** Create one versioned release directory under `<pkg>/releases`. */
export function writeCodexRelease(pkg, version, { reportedVersion = version } = {}) {
  const triple = TRIPLES[`${process.platform}:${process.arch}`] ?? 'x86_64-unknown-linux-musl';
  const release = path.join(pkg, 'releases', `${version}-${triple}`);
  const files = {
    'bin/codex': [versionPrinterElf(`codex-cli ${reportedVersion}\n`), 0o755],
    'bin/codex-code-mode-host': ['\x7fELFhost', 0o755],
    'codex-path/rg': ['\x7fELFrg', 0o755],
    'codex-resources/bwrap': ['\x7fELFbwrap', 0o755],
    'codex-resources/zsh/bin/zsh': ['\x7fELFzsh', 0o755],
    'codex-resources/voice/manifest.json': ['{}', 0o644],
    'codex-package.json': [JSON.stringify({
      layoutVersion: 1, version, target: triple, variant: 'codex', entrypoint: 'bin/codex',
      resourcesDir: 'codex-resources', pathDir: 'codex-path',
    }), 0o644],
  };
  for (const [relative, [content, mode]] of Object.entries(files)) {
    const file = path.join(release, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode });
    fs.chmodSync(file, mode);
  }
  fs.symlinkSync('bin/codex', path.join(release, 'codex'));
  return release;
}

/** Point `<pkg>/current` at a release atomically (rename over the old link). */
export function pointCurrent(pkg, release) {
  const next = path.join(pkg, `current.${process.pid}.${Date.now()}`);
  fs.symlinkSync(release, next);
  fs.renameSync(next, path.join(pkg, 'current'));
}

/**
 * Build `<root>/home/.local/bin/codex -> <root>/pkg/current/bin/codex` with one release.
 * @returns {{ root: string, home: string, pkg: string, release: string, launcher: string }}
 */
export function createCodexMachineFixture(root, version = '0.156.0') {
  const home = path.join(root, 'home');
  const pkg = path.join(root, 'pkg');
  const release = writeCodexRelease(pkg, version);
  pointCurrent(pkg, release);
  const launcher = path.join(home, '.local', 'bin', 'codex');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.symlinkSync(path.join(pkg, 'current', 'bin', 'codex'), launcher);
  return { root, home, pkg, release, launcher };
}

/**
 * The fixture ELF only prints its version, so it cannot answer the runtime
 * compatibility probes; tests that launch through it accept it explicitly.
 */
export async function acceptFixtureRuntimeCompat() {
  // Imported lazily: a static import would bind codex-executable before a test's child_process mock.
  const { setCodexRuntimeEvaluatorForTests } = await import('../codex-runtime-compat.js');
  setCodexRuntimeEvaluatorForTests(async identity => ({
    compatible: true, version: identity.version, reason: null,
    checks: { version: 'fixture', flags: 'fixture', config: 'fixture', enforcement: 'fixture' },
  }));
}
