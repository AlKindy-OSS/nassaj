/**
 * Host-wide CPU/RAM sampler shared by every turn admission path.
 *
 * CPU is derived from two cumulative os.cpus() snapshots; loadavg is not a CPU
 * percentage and is especially misleading on hosts with several cores. Samples
 * are single-flight and short-lived so simultaneous admissions use one measured
 * host state. Any malformed/failed/stale measurement throws: callers must deny
 * admission rather than guessing that capacity exists.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';

const MEMINFO_PATH = '/proc/meminfo';

export type SystemResourceSample = {
  cpuPercent: number;
  memoryPercent: number;
  measuredAt: number;
};

export type CpuTimes = { idle: number; total: number };

export type SystemResourceSamplerDeps = {
  readCpuTimes?: () => CpuTimes;
  readMemory?: () => { free: number; total: number };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type SystemResourceSamplerOptions = {
  sampleWindowMs?: number;
  cacheMaxAgeMs?: number;
};

/**
 * Host memory as the kernel reports it. On Linux `os.freemem()` is MemFree,
 * which excludes reclaimable page cache and buffers, so a busy host reads
 * "full" while most of that memory is available on demand (B-1072). Prefer
 * MemAvailable from /proc/meminfo; fall back to os.freemem() only where the
 * file is absent (non-Linux). A present but malformed meminfo throws so the
 * caller denies admission instead of trusting a bogus number.
 */
export function readHostMemory(
  deps: { readMeminfo?: () => string | null; freemem?: () => number; totalmem?: () => number } = {},
): { free: number; total: number } {
  const total = (deps.totalmem ?? os.totalmem)();
  const meminfo = (deps.readMeminfo ?? readMeminfoOrNull)();
  if (meminfo === null) return { free: (deps.freemem ?? os.freemem)(), total };
  const match = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(meminfo);
  if (!match) throw new Error('MemAvailable missing from meminfo');
  return { free: Number(match[1]) * 1024, total };
}

function readMeminfoOrNull(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    return readFileSync(MEMINFO_PATH, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

function readHostCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  const cpus = os.cpus();
  if (cpus.length === 0) throw new Error('CPU inventory is empty');
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function validPercent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

export class SystemResourceSampler {
  private readonly readCpuTimes: () => CpuTimes;
  private readonly readMemory: () => { free: number; total: number };
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sampleWindowMs: number;
  private readonly cacheMaxAgeMs: number;
  private cached: SystemResourceSample | null = null;
  private pending: Promise<SystemResourceSample> | null = null;

  constructor(
    deps: SystemResourceSamplerDeps = {},
    options: SystemResourceSamplerOptions = {},
  ) {
    this.readCpuTimes = deps.readCpuTimes ?? readHostCpuTimes;
    this.readMemory = deps.readMemory ?? readHostMemory;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
    this.sampleWindowMs = options.sampleWindowMs ?? 100;
    this.cacheMaxAgeMs = options.cacheMaxAgeMs ?? 500;
  }

  /** Return a fresh-enough sample, coalescing concurrent measurements. */
  sample(): Promise<SystemResourceSample> {
    const now = this.now();
    if (this.cached && now - this.cached.measuredAt <= this.cacheMaxAgeMs) {
      return Promise.resolve(this.cached);
    }
    if (this.pending) return this.pending;
    this.pending = this.measure().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async measure(): Promise<SystemResourceSample> {
    try {
      const before = this.readCpuTimes();
      await this.sleep(this.sampleWindowMs);
      const after = this.readCpuTimes();
      const elapsed = after.total - before.total;
      const idle = after.idle - before.idle;
      const memory = this.readMemory();
      if (!(elapsed > 0) || idle < 0 || idle > elapsed) {
        throw new Error('invalid CPU counters');
      }
      if (!(memory.total > 0) || memory.free < 0 || memory.free > memory.total) {
        throw new Error('invalid memory counters');
      }
      const sample = {
        cpuPercent: ((elapsed - idle) / elapsed) * 100,
        memoryPercent: ((memory.total - memory.free) / memory.total) * 100,
        measuredAt: this.now(),
      };
      if (!validPercent(sample.cpuPercent) || !validPercent(sample.memoryPercent)) {
        throw new Error('resource percentage outside valid range');
      }
      this.cached = sample;
      return sample;
    } catch (error) {
      this.cached = null;
      throw new Error(
        `system resource measurement unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Process singleton: all harnesses in this server share the same sampler. */
export const systemResourceSampler = new SystemResourceSampler();
