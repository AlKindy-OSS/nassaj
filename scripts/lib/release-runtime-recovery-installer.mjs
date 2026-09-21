import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const UNIT = /^[A-Za-z0-9_.@-]+\.service$/; const HEX64 = /^[a-f0-9]{64}$/;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function atomic(file, bytes, mode = 0o644) { mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    const temporary = `${file}.partial-${process.pid}`; writeFileSync(temporary, bytes, { flag: 'wx', mode });
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, file); }
function systemctl(args, deps) { return (deps.exec || ((file, argv) => execFileSync(file, argv, { encoding: 'utf8',
    timeout: 30_000, maxBuffer: 65_536, env: { PATH: '/usr/bin:/bin', HOME: '/root', LC_ALL: 'C' } })))('/usr/bin/systemctl', args); }
function validate(config) {
    const systemd = config?.systemd; const units = [systemd?.pm2Unit, ...(systemd?.ingressUnits || [])];
    if (!UNIT.test(systemd?.pm2Unit || '') || !Array.isArray(systemd?.ingressUnits) || systemd.ingressUnits.length < 1
        || units.some((unit) => !UNIT.test(unit)) || new Set(units).size !== units.length
        || !Array.isArray(systemd.recoveryReadWritePaths) || systemd.recoveryReadWritePaths.some((item) => !path.isAbsolute(item))
        || units.some((unit) => !HEX64.test(systemd.unitSha256?.[unit] || ''))) throw new Error('recovery_systemd_contract_invalid');
    return { systemd, units };
}
const USER_MANAGER_HINT = 'live ingress runs inside systemd --user, and a system boot gate cannot order itself before it';
function fail(code, detail) { const error = new Error(code); error.detail = detail; return error; }
function showProperties(args, deps) {
    return Object.fromEntries(String(systemctl(args, deps)).trim().split('\n').filter(Boolean)
        .map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim()]; }));
}
/** Answer whether a same-named unit is active in the user manager; fail closed when that is unprovable. */
function userUnitActive(unit, deps) {
    let properties;
    try { properties = showProperties(['--user', 'show', unit, '--property=ActiveState'], deps); }
    catch { throw fail('recovery_ingress_user_manager_probe_unavailable',
        `cannot prove ${unit} is absent from the user manager, so the boot gate is refused`); }
    if (!('ActiveState' in properties)) throw fail('recovery_ingress_user_manager_probe_unavailable',
        `user manager reported no ActiveState for ${unit}, so the boot gate is refused`);
    return properties.ActiveState === 'active';
}
/** Reject units the system manager does not actually run, naming user-manager ingress explicitly. */
function assertSystemManaged(unit, properties, deps) {
    if (properties.LoadState === 'loaded' && properties.ActiveState === 'active'
        && properties.SubState !== 'dead' && properties.SubState !== 'failed') return;
    if (userUnitActive(unit, deps)) throw fail('recovery_ingress_unit_not_system_managed', `${unit}: ${USER_MANAGER_HINT}`);
    throw fail('recovery_unit_not_system_active', `${unit} is not active under the system manager`);
}
/** Discover exact live unit fragments and compare them with the owner-pinned plan. */
export function attestRecoveryBootUnits(config, deps = {}) {
    const { systemd, units } = validate(config); const evidence = [];
    for (const unit of units) {
        const properties = showProperties(['show', unit, '--property=FragmentPath', '--property=LoadState',
            '--property=ActiveState', '--property=SubState'], deps);
        assertSystemManaged(unit, properties, deps);
        const fragment = (properties.FragmentPath || '').trim();
        if (!path.isAbsolute(fragment) || realpathSync(fragment) !== fragment) throw new Error('recovery_unit_fragment_invalid');
        const metadata = lstatSync(fragment); const bytes = readFileSync(fragment);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0
            || sha(bytes) !== systemd.unitSha256[unit]) throw new Error('recovery_unit_attestation_failed');
        evidence.push({ unit, fragment, sha256: sha(bytes), device: metadata.dev, inode: metadata.ino,
            activeState: properties.ActiveState, subState: properties.SubState });
    }
    return Object.freeze(evidence);
}
function gateRestoreUnit(config, ingressUnits) {
    const rw = config.systemd.recoveryReadWritePaths.join(' ');
    return `[Unit]\nDescription=Nassaj early-boot cutover maintenance gate restore\nDefaultDependencies=no\n`
      + `After=local-fs.target nassaj-maintenance.service\nRequires=nassaj-maintenance.service\nBefore=${ingressUnits.join(' ')}\n\n`
      + `[Service]\nType=oneshot\nUser=root\nGroup=root\nEnvironment=HOME=/root\nEnvironment=PATH=/usr/bin:/bin\n`
      + `ExecStart=/usr/bin/node /usr/local/lib/nassaj-release-operator/scripts/release-runtime-gate-restore.mjs\n`
      + `RemainAfterExit=yes\nTimeoutStartSec=60s\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=read-only\n`
      + `ProtectSystem=strict\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\n`
      + `RestrictNamespaces=true\nRestrictSUIDSGID=true\nLockPersonality=true\nRestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK\n`
      + `CapabilityBoundingSet=CAP_NET_ADMIN\nAmbientCapabilities=CAP_NET_ADMIN\nReadWritePaths=${rw}\n\n`
      + `[Install]\nWantedBy=multi-user.target\n`;
}
function recoveryUnit(config, pm2Unit, ingressUnits) {
    const rw = config.systemd.recoveryReadWritePaths.join(' ');
    return `[Unit]\nDescription=Nassaj first cutover recovery gate\nDefaultDependencies=no\n`
      + `After=local-fs.target nassaj-cutover-gate-restore.service ${ingressUnits.join(' ')}\n`
      + `Requires=nassaj-cutover-gate-restore.service\nWants=${ingressUnits.join(' ')}\nBefore=${pm2Unit}\n\n`
      + `[Service]\nType=oneshot\nUser=root\nGroup=root\nEnvironment=HOME=/root\nEnvironment=PATH=/usr/bin:/bin\n`
      + `ExecStart=/usr/bin/node /usr/local/lib/nassaj-release-operator/scripts/release-runtime-cutover-recovery.mjs\n`
      + `TimeoutStartSec=15min\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=read-only\n`
      + `ProtectSystem=strict\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\n`
      + `RestrictNamespaces=true\nRestrictSUIDSGID=true\nLockPersonality=true\nReadWritePaths=${rw}\n\n`
      + `[Install]\nWantedBy=multi-user.target\n`;
}
/** Install the recovery gate and ordering drop-ins only after exact fragment attestation. */
export function installReleaseRuntimeRecovery(config, deps = {}) {
    const evidence = deps.attestUnits ? deps.attestUnits(config) : attestRecoveryBootUnits(config, deps);
    const { systemd, units } = validate(config);
    const ingressUnits = systemd.ingressUnits;
    const root = path.resolve(deps.systemdRoot || '/etc/systemd/system');
    const gateRestore = path.join(root, 'nassaj-cutover-gate-restore.service'); atomic(gateRestore, gateRestoreUnit(config, ingressUnits));
    const recovery = path.join(root, 'nassaj-first-cutover-recovery.service');
    atomic(recovery, recoveryUnit(config, systemd.pm2Unit, ingressUnits));
    const dropIns = [];
    for (const unit of ingressUnits) { const file = path.join(root, `${unit}.d`, '10-nassaj-cutover-gate-restore.conf');
        atomic(file, `[Unit]\nRequires=nassaj-cutover-gate-restore.service\nAfter=nassaj-cutover-gate-restore.service\n`); dropIns.push(file); }
    const pm2DropIn = path.join(root, `${systemd.pm2Unit}.d`, '10-nassaj-first-cutover-recovery.conf');
    atomic(pm2DropIn, `[Unit]\nRequires=nassaj-first-cutover-recovery.service\nAfter=nassaj-first-cutover-recovery.service\n`);
    dropIns.push(pm2DropIn);
    (deps.verify || ((files) => execFileSync('/usr/bin/systemd-analyze', ['verify', ...files], { encoding: 'utf8',
        timeout: 30_000, maxBuffer: 65_536 })))([gateRestore, recovery, ...dropIns]);
    if (!deps.skipDaemonReload) systemctl(['daemon-reload'], deps);
    return Object.freeze({ gateRestore, recovery, dropIns: Object.freeze(dropIns), evidence });
}
