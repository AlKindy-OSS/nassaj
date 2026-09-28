/**
 * Server-built acknowledgements for risky harness actions (T-1871 stage 3,
 * spec §9, qa condition 3).
 *
 * `pinBreak` (target version is incompatible) and `dataLoss` (a data restore
 * would drop writes made after the backup) each need a single-use token:
 *   token = nonce . expiresAt . HMAC(key, [userId, harness, action, kind,
 *           factsDigest, nonce, expiresAt])
 * The key is DEDICATED (never JWT_SECRET) and lives in a 0600 file. Nonces
 * are kept in memory only, so a server restart invalidates every token. When
 * the facts change the digest no longer matches and a fresh 409 is issued.
 * Texts are built here from server facts only; no client text is echoed.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './snapshot/durable-fs.js';
import { snapshotError } from './snapshot/errors.js';
import { ensurePrivateDir, harnessDataHome, nassajDataDir } from './snapshot/paths.js';

/** Token lifetime. */
export const ACK_TOKEN_TTL_MS = 5 * 60 * 1000;
const KEY_BYTES = 32;

export type AckKind = 'pinBreak' | 'dataLoss';
export type AckAction = 'update' | 'restore-compatible' | 'rollback';

/** pinBreak facts: `carrier` = opencode GLM carrier, `all` = pin armed for every mode. */
export interface PinBreakFacts {
  variant: 'carrier' | 'all';
  target: string;
  pin: string;
}

/** dataLoss facts; `spawnCount: null` means the ledger is unknown. */
export interface DataLossFacts {
  storeCount: number;
  backupAt: number;
  spawnCount: number | null;
  firstSpawnAt: number | null;
  changedStores: number;
  asideExpiry: number;
}

/** Everything the server knows about the requested action. */
export interface AckContext {
  userId: number;
  harness: string;
  harnessName: string;
  action: AckAction;
  pinBreak: PinBreakFacts | null;
  dataLoss: DataLossFacts | null;
}

/** One entry of the 409 CONFIRMATION_REQUIRED `required` list. */
export interface RequiredAck {
  kind: AckKind;
  token: string;
  expiresAt: number;
  textEn: string;
  textAr: string;
  facts: PinBreakFacts | DataLossFacts;
}

/** A client-supplied acknowledgement. */
export interface SuppliedAck {
  kind: unknown;
  token: unknown;
}

/** Default key location: `~/.local/share/nassaj/harness-ack.key`. */
export function defaultAckKeyPath(home: string = harnessDataHome()): string {
  return path.join(nassajDataDir(home), 'harness-ack.key');
}

function readPrivateKey(file: string): Buffer {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw snapshotError('ACK_KEY_INSECURE');
  const hex = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw snapshotError('ACK_KEY_INSECURE');
  return Buffer.from(hex, 'hex');
}

/**
 * Loads the dedicated HMAC key, creating it (0600, dir 0700) on first use.
 * Creation is atomic (temp + link), so a crash never leaves a partial key.
 * A key that is not private is refused (ACK_KEY_INSECURE).
 */
export function loadOrCreateAckKey(file: string = defaultAckKeyPath()): Buffer {
  ensurePrivateDir(path.dirname(file));
  if (!fs.existsSync(file)) {
    const tmp = `${file}.new-${randomBytes(6).toString('hex')}`;
    writeFileAtomic(tmp, `${randomBytes(KEY_BYTES).toString('hex')}\n`);
    try {
      fs.linkSync(tmp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return readPrivateKey(file);
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 over the canonical JSON of `facts`. */
export function factsDigest(facts: PinBreakFacts | DataLossFacts): string {
  return createHash('sha256').update(canonical(facts)).digest('hex');
}

/** Server-built pinBreak texts (spec §9). */
export function pinBreakTexts(harnessName: string, f: PinBreakFacts): { en: string; ar: string } {
  if (f.variant === 'carrier') {
    return {
      en: `Updating OpenCode to ${f.target} leaves the verified version ${f.pin}. GLM will stop working until the compatible version is restored. The verified pin does not change.`,
      ar: `تحديث OpenCode إلى ${f.target} يُخرجه عن النسخة الموثَّقة ${f.pin}. سيتوقف GLM عن العمل حتى تُستعاد النسخة المتوافقة. لن يتغيّر التثبيت الموثَّق.`,
    };
  }
  return {
    en: `${harnessName} will be blocked in every mode until version ${f.pin} is restored.`,
    ar: `سيُحجب ${harnessName} في كل الأوضاع حتى تُستعاد النسخة ${f.pin}.`,
  };
}

/** Server-built dataLoss texts (spec §9); an unknown ledger reads "an unknown number of". */
export function dataLossTexts(harnessName: string, f: DataLossFacts): { en: string; ar: string } {
  const at = iso(f.backupAt);
  const aside = iso(f.asideExpiry);
  const firstEn = f.firstSpawnAt === null ? 'an unknown time' : iso(f.firstSpawnAt);
  const firstAr = f.firstSpawnAt === null ? 'وقت غير معروف' : iso(f.firstSpawnAt);
  const countEn = f.spawnCount === null ? 'an unknown number of' : String(f.spawnCount);
  const countAr = f.spawnCount === null ? 'عدداً غير معروف من المرات' : `${f.spawnCount} مرة`;
  return {
    en: `This returns ${f.storeCount} data store(s) to the backup taken at ${at}. Since then ${harnessName} was started ${countEn} time(s), first at ${firstEn}, and ${f.changedStores} store(s) changed. Conversations and settings written after ${at} will be lost. Current files are kept aside until ${aside}.`,
    ar: `سيُعيد هذا ${f.storeCount} من مخازن البيانات إلى النسخة الاحتياطية المأخوذة في ${at}. منذ ذلك الحين شُغِّل ${harnessName} ${countAr}، أولها في ${firstAr}، وتغيّر ${f.changedStores} مخزن. ستُفقد المحادثات والإعدادات المكتوبة بعد ${at}. تُحفظ الملفات الحالية جانباً حتى ${aside}.`,
  };
}

function requiredFacts(ctx: AckContext): { kind: AckKind; facts: PinBreakFacts | DataLossFacts }[] {
  const out: { kind: AckKind; facts: PinBreakFacts | DataLossFacts }[] = [];
  if (ctx.pinBreak) out.push({ kind: 'pinBreak', facts: ctx.pinBreak });
  if (ctx.dataLoss) out.push({ kind: 'dataLoss', facts: ctx.dataLoss });
  return out;
}

/** Issues and verifies single-use acknowledgement tokens. */
export class AckTokenService {
  private readonly nonces = new Map<string, number>();

  constructor(private readonly key: Buffer, private readonly now: () => number = Date.now) {
    if (key.length < KEY_BYTES) throw snapshotError('ACK_KEY_INSECURE');
  }

  private mac(ctx: AckContext, kind: AckKind, digest: string, nonce: string, expiresAt: number): string {
    const payload = JSON.stringify([ctx.userId, ctx.harness, ctx.action, kind, digest, nonce, expiresAt]);
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  private sweep(): void {
    const now = this.now();
    for (const [nonce, exp] of this.nonces) if (exp <= now) this.nonces.delete(nonce);
  }

  /** Builds the acks the action needs now (empty when none), registering fresh nonces. */
  buildRequiredAcks(ctx: AckContext): RequiredAck[] {
    this.sweep();
    return requiredFacts(ctx).map(({ kind, facts }) => {
      const nonce = randomBytes(16).toString('base64url');
      const expiresAt = this.now() + ACK_TOKEN_TTL_MS;
      this.nonces.set(nonce, expiresAt);
      const token = `${nonce}.${expiresAt}.${this.mac(ctx, kind, factsDigest(facts), nonce, expiresAt)}`;
      const texts = kind === 'pinBreak'
        ? pinBreakTexts(ctx.harnessName, facts as PinBreakFacts)
        : dataLossTexts(ctx.harnessName, facts as DataLossFacts);
      return { kind, token, expiresAt, textEn: texts.en, textAr: texts.ar, facts };
    });
  }

  /** Returns the nonce when `token` is valid for (ctx, kind, facts) now, else null. */
  private check(ctx: AckContext, kind: AckKind, facts: PinBreakFacts | DataLossFacts, token: unknown): string | null {
    if (typeof token !== 'string' || token.length > 512) return null;
    const [nonce, exp, mac, extra] = token.split('.');
    const expiresAt = Number(exp);
    if (!nonce || !mac || extra !== undefined || !Number.isSafeInteger(expiresAt)) return null;
    if (expiresAt <= this.now() || this.nonces.get(nonce) !== expiresAt) return null;
    const want = Buffer.from(this.mac(ctx, kind, factsDigest(facts), nonce, expiresAt));
    const got = Buffer.from(mac);
    return want.length === got.length && timingSafeEqual(want, got) ? nonce : null;
  }

  /**
   * Throws CONFIRMATION_REQUIRED (details `{required}` with fresh tokens and
   * texts) unless every ack `ctx` requires is supplied and valid. Valid tokens
   * are consumed only when all of them pass.
   */
  verifyAcks(ctx: AckContext, supplied: SuppliedAck[] | undefined): void {
    this.sweep();
    const needed = requiredFacts(ctx);
    const list = Array.isArray(supplied) ? supplied : [];
    const nonces = needed.map(({ kind, facts }) => {
      const match = list.filter((a) => a?.kind === kind).map((a) => this.check(ctx, kind, facts, a.token));
      return match.find((n) => n !== null) ?? null;
    });
    if (nonces.some((n) => n === null)) {
      throw snapshotError('CONFIRMATION_REQUIRED', { required: this.buildRequiredAcks(ctx) });
    }
    for (const n of nonces) this.nonces.delete(n as string);
  }
}
