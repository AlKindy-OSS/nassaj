/**
 * B-1699: session-local scheduled wake-ups (ScheduleWakeup, the `/loop` engine).
 *
 * Measured on CLI 2.1.306 (capture 2026-10-27, SDK 0.3.310, cwd under /var/tmp):
 * a successful ScheduleWakeup answers with a top-level `user` tool_result whose
 * structured `tool_use_result` is `{ scheduledFor: <epoch ms>, clampedDelaySeconds,
 * wasClamped }` and whose text reads "Next wakeup scheduled for HH:MM:SS (in Ns)".
 * The wake-up lives inside the CLI process: if nassaj closes the input stream after
 * the turn's `result`, the CLI exits and the wake-up never fires. When it fires, the
 * stream shows `command_lifecycle {state: 'started', command_uuid}` and then a new
 * cycle (system/init → assistant → result) with NO `user` message; the transcript
 * stores the wake prompt as a `user` row with `isMeta: true`, `turnOrigin:
 * 'scheduled'` and `uuid` equal to that `command_uuid`. No task_* event is emitted,
 * so the background-task tracker never sees it.
 *
 * CronCreate (same capture) schedules the same kind of turn: its structured result
 * is `{ id, humanSchedule, recurring, durable, nextFireAt: <epoch ms> }`, and a
 * `durable: false` task is "Session-only (… dies when Claude exits)". Only those
 * count. A one-shot task is pending until it fires; a recurring one stays pending
 * (its later fires are not announced, so their times are unknown) until a
 * CronDelete of its id succeeds — the caller bounds it with its total cap.
 *
 * LIMIT (documented, not guessed): the `command_lifecycle` of a wake-up carries no
 * marker of its own in the stream (the `turnOrigin: 'scheduled'` marker exists only
 * in the transcript). A fire is therefore recognised as a `started` command that
 * nassaj did not send while a wake-up is due. A background-task notification cycle
 * emitted NO `command_lifecycle` in the same captures, so it is not mistaken for one.
 */

/** Tools whose successful result can schedule a wake-up of THIS CLI process. */
const SCHEDULING_TOOLS: ReadonlySet<string> = new Set(['ScheduleWakeup', 'CronCreate']);
/** The tool that cancels a CronCreate task by id. */
const CANCELLING_TOOL = 'CronDelete';

/** `notice.noticeCode` of the line that marks a scheduled wake-up turn. */
export const SCHEDULED_WAKEUP_NOTICE_CODE = 'scheduled_wakeup';

/** English fallback text of that line; the client renders its translation. */
export const SCHEDULED_WAKEUP_NOTICE_TEXT = 'Scheduled wake-up';

/** A due wake-up may start up to this long before its time (clock skew). */
const EARLY_FIRE_SLACK_MS = 5_000;

type RawMessage = Record<string, any> | null | undefined;

/** One wake-up the CLI process owes. `at` is null once a recurring task's next time is unknown. */
export type PendingWakeup = { at: number | null; cronId: string | null; recurring: boolean };

const epochMs = (value: unknown): number | null =>
  (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/**
 * The wake-up a successful scheduling tool_result creates, or null when it creates
 * none for this process. ScheduleWakeup: the structured `scheduledFor`, else the
 * "(in Ns)" of its text counted from `now`. CronCreate: a session-only
 * (`durable: false`) task with its `nextFireAt`, id and `recurring` flag.
 */
export function parseScheduledWakeup(tool: string, structured: unknown, text: string,
  now: number): PendingWakeup | null {
  const fields = (structured && typeof structured === 'object' ? structured : {}) as Record<string, unknown>;
  if (tool === 'CronCreate') {
    const at = fields.durable === false ? epochMs(fields.nextFireAt) : null;
    if (at === null) return null;
    return { at, cronId: typeof fields.id === 'string' ? fields.id : null, recurring: fields.recurring === true };
  }
  const scheduledFor = epochMs(fields.scheduledFor);
  if (scheduledFor !== null) return { at: scheduledFor, cronId: null, recurring: false };
  const match = /\(in (\d{1,7})s\)/.exec(text);
  return match ? { at: now + Number(match[1]) * 1000, cronId: null, recurring: false } : null;
}

/** The epoch-ms time {@link parseScheduledWakeup} finds, or null. */
export function scheduledWakeAt(tool: string, structured: unknown, text: string, now: number): number | null {
  return parseScheduledWakeup(tool, structured, text, now)?.at ?? null;
}

/** Text of a tool_result block's content (string or text parts). */
function toolResultText(block: Record<string, any>): string {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';
  return block.content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

const contentBlocks = (message: Record<string, any>): any[] =>
  (Array.isArray(message.message?.content) ? message.message.content : []);

export type ScheduledWakeupState = {
  /** Earliest known wake-up time still due (epoch ms), or null. */
  nextWakeAt: number | null;
  /** A recurring session-only cron is pending (no known end). */
  openEnded: boolean;
  /** `command_uuid` of a wake-up turn that just started, else null. */
  firedCommandUuid: string | null;
  /** This message scheduled a wake-up. */
  scheduled: boolean;
  /** This message cancelled a pending cron task (CronDelete). */
  cancelled: boolean;
};

type Calls = Map<string, { name: string; cronId: string | null }>;

/** Remembers the scheduling / cancelling tool calls of a top-level assistant message. */
function rememberCalls(message: Record<string, any>, calls: Calls): void {
  for (const block of contentBlocks(message)) {
    if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
    if (SCHEDULING_TOOLS.has(block.name)) calls.set(block.id, { name: block.name, cronId: null });
    else if (block.name === CANCELLING_TOOL && typeof block.input?.id === 'string') {
      calls.set(block.id, { name: block.name, cronId: block.input.id });
    }
  }
}

/** Applies the results of remembered calls to `wakes`; reports what changed. */
function applyResults(message: Record<string, any>, calls: Calls, wakes: PendingWakeup[], now: number) {
  const results = contentBlocks(message).filter((block: any) => block?.type === 'tool_result');
  const change = { scheduled: false, cancelled: false };
  for (const block of results) {
    const call = calls.get(block.tool_use_id);
    if (!call) continue;
    calls.delete(block.tool_use_id);
    if (block.is_error === true) continue;
    if (call.name === CANCELLING_TOOL) {
      const before = wakes.length;
      wakes.splice(0, wakes.length, ...wakes.filter(wake => wake.cronId !== call.cronId));
      change.cancelled ||= wakes.length < before;
      continue;
    }
    // The structured result belongs to the message, so it is read only when the
    // message answers this one call; otherwise the text fallback applies.
    const structured = results.length === 1 ? (message.tool_use_result ?? message.toolUseResult) : null;
    const wake = parseScheduledWakeup(call.name, structured, toolResultText(block), now);
    if (wake) {
      wakes.push(wake);
      change.scheduled = true;
    }
  }
  return change;
}

/** Consumes the wake-up a `command_lifecycle started` fires; its command uuid, or null. */
function consumeFire(message: Record<string, any>, wakes: PendingWakeup[], now: number,
  isOwnCommand: (uuid: string) => boolean): string | null {
  const uuid = typeof message.command_uuid === 'string' ? message.command_uuid : '';
  if (message.state !== 'started' || !uuid || isOwnCommand(uuid)) return null;
  const isDue = (wake: PendingWakeup) => wake.at !== null && wake.at <= now + EARLY_FIRE_SLACK_MS;
  const oneShot = wakes.findIndex(wake => !wake.recurring && isDue(wake));
  if (oneShot !== -1) {
    wakes.splice(oneShot, 1);
    return uuid;
  }
  const recurring = wakes.find(wake => wake.recurring && (wake.at === null || isDue(wake)));
  if (!recurring) return null;
  recurring.at = null;
  return uuid;
}

/** Drops one-shot wake-ups past their time plus `marginMs`, earliest first. */
function prune(wakes: PendingWakeup[], marginMs: number, now: number): PendingWakeup[] {
  return wakes.filter(wake => wake.recurring || (wake.at !== null && wake.at + marginMs > now))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

/**
 * Per-run view of the wake-ups this CLI process owes, fed with RAW SDK messages.
 * @param marginMs - how long past its time a one-shot wake-up is still awaited
 * @param now - clock (tests)
 */
export function createScheduledWakeupTracker(marginMs: number, now: () => number = Date.now) {
  const calls: Calls = new Map();
  let wakes: PendingWakeup[] = [];
  return {
    /**
     * @param message - raw SDK message
     * @param isOwnCommand - whether a command uuid is one nassaj sent (turn, steer)
     */
    observe(message: RawMessage, isOwnCommand: (uuid: string) => boolean = () => false): ScheduledWakeupState {
      let change = { scheduled: false, cancelled: false };
      let firedCommandUuid: string | null = null;
      if (message && !message.parent_tool_use_id) {
        if (message.type === 'assistant') rememberCalls(message, calls);
        else if (message.type === 'user') change = applyResults(message, calls, wakes, now());
        else if (message.type === 'command_lifecycle') firedCommandUuid = consumeFire(message, wakes, now(), isOwnCommand);
      }
      wakes = prune(wakes, marginMs, now());
      const known = wakes.find(wake => wake.at !== null);
      return { nextWakeAt: known?.at ?? null, openEnded: wakes.some(wake => wake.recurring),
        firedCommandUuid, ...change };
    },
  };
}

/**
 * Whether a persisted transcript row is the prompt of a scheduled wake-up turn
 * (CLI 2.1.306: `isMeta` user row with `turnOrigin: 'scheduled'`).
 */
export function isScheduledWakeupRow(raw: RawMessage): boolean {
  return Boolean(raw && raw.type === 'user' && raw.isMeta === true && raw.turnOrigin === 'scheduled'
    && raw.isSidechain !== true);
}
