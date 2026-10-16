/**
 * ADR-206 S3/S4 test fixture: an in-memory /proc. No real process is read or signalled.
 */
import type { ProcScanDeps } from '../../../../execution-permissions/tagged-process-scan.js';

export const OWN_UID = 1000;
export const SERVER_PID = 500;
export const GOD_PID = 400;
export const BTIME_S = 1_700_000_000;
/** Wall-clock ms of a start-ticks value (USER_HZ = 100). */
export const ticksToMs = (ticks: number): number => BTIME_S * 1000 + ticks * 10;
export const msToTicks = (ms: number): number => Math.round((ms - BTIME_S * 1000) / 10);

export type FakeProc = {
  pid: number;
  ppid: number;
  comm?: string;
  state?: string;
  uid?: number;
  startTicks: number;
  env?: string[];
  rssKb?: number;
  /** Throw EACCES on environ (non-dumpable). */
  hiddenEnviron?: boolean;
};

export class FakeProcFs {
  readonly procs = new Map<number, FakeProc>();
  readonly signals: Array<{ pid: number; sig: string }> = [];
  /** Called after each signal; tests use it to make processes exit or to reuse pids. */
  onSignal: (pid: number, sig: string, fs: FakeProcFs) => void = (pid, _sig, fs) => { fs.procs.delete(pid); };
  ownPmId: string | null = '4';
  daemonPids: number[] = [GOD_PID];
  clock = ticksToMs(10_000);

  constructor() {
    this.add({ pid: 1, ppid: 0, comm: 'systemd', uid: 0, startTicks: 1 });
    this.add({ pid: GOD_PID, ppid: 1, comm: 'PM2 v7.0.1: God', startTicks: 100, env: ['PM2_HOME=/h/.pm2'] });
    this.add({ pid: SERVER_PID, ppid: GOD_PID, comm: 'node', startTicks: 200, env: ['pm_id=4', 'PM2_HOME=/h/.pm2'] });
  }

  add(proc: FakeProc): this { this.procs.set(proc.pid, proc); return this; }

  private readProc(pid: number, leaf: string): Buffer {
    const proc = this.procs.get(pid);
    if (!proc) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const uid = proc.uid ?? OWN_UID;
    if (leaf === 'status') {
      return Buffer.from(`Name:\t${proc.comm ?? 'x'}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nVmRSS:\t${proc.rssKb ?? 0} kB\n`);
    }
    if (leaf === 'stat') {
      const rest = [proc.state ?? 'S', proc.ppid, ...Array(17).fill(0), proc.startTicks, 0].join(' ');
      return Buffer.from(`${pid} (${proc.comm ?? 'x'}) ${rest}`);
    }
    if (leaf === 'environ') {
      if (proc.hiddenEnviron || uid !== OWN_UID) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return Buffer.from(`${(proc.env ?? []).join('\0')}\0`);
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }

  readFile = (file: string): Buffer => {
    if (file === '/proc/stat') return Buffer.from(`cpu 1 2 3\nbtime ${BTIME_S}\n`);
    const match = /^\/proc\/(\d+)\/(\w+)$/u.exec(file);
    if (!match) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return this.readProc(Number(match[1]), match[2]);
  };

  deps(): ProcScanDeps {
    return {
      ownPid: SERVER_PID,
      ownUid: OWN_UID,
      ownPmId: this.ownPmId,
      pm2DaemonPids: () => this.daemonPids,
      listPids: () => [...this.procs.keys()].map(String),
      readFile: this.readFile,
    };
  }

  cleanupDeps() {
    return {
      scan: this.deps(),
      signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => {
        if (!this.procs.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        this.signals.push({ pid, sig });
        this.onSignal(pid, sig, this);
      },
      sleep: async (ms: number) => { this.clock += ms; },
      now: () => this.clock,
    };
  }
}
